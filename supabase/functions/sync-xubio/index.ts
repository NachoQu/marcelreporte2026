// Edge Function: sync-xubio
// Pull de catálogos (clientes/proveedores) desde la API de Xubio y upsert en Supabase.
// Credenciales: secrets del proyecto Supabase. Nombres case-sensitive:
//   Client_id, Secret_id, Token_URL (opcional, usa default si falta).
// Auth: requiere JWT del usuario que invoca; se respeta RLS al escribir.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_TOKEN_URL = "https://xubio.com/API/1.1/TokenEndpoint";
const BASE_URL = "https://xubio.com/API/1.1";

interface SyncResult {
  resource: string;
  status: "success" | "error" | "partial";
  items_synced: number;
  items_failed: number;
  error_message?: string;
}

async function getXubioToken(tokenUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`Xubio token ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Xubio token response missing access_token");
  }
  return data.access_token as string;
}

async function fetchXubio<T = unknown>(token: string, path: string): Promise<T[]> {
  const res = await fetch(BASE_URL + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Xubio GET ${path} ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return unwrapList<T>(data);
}

// Xubio a veces devuelve arrays planos, otras un objeto wrapper. Probamos formas comunes.
function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const k of ["data", "items", "results", "list", "rows", "content"]) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
    // Si todas las values son arrays con el mismo shape, devolver la primera array no vacía
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

// Prueba varias rutas y devuelve el primer match con datos (o el primer ok vacío).
async function fetchXubioTry<T>(token: string, paths: string[]): Promise<{ items: T[]; path: string; tried: string[] }> {
  const tried: string[] = [];
  let firstOkEmpty: { items: T[]; path: string } | null = null;
  let lastError: Error | null = null;
  for (const p of paths) {
    tried.push(p);
    try {
      const items = await fetchXubio<T>(token, p);
      if (items.length > 0) return { items, path: p, tried };
      if (!firstOkEmpty) firstOkEmpty = { items, path: p };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (firstOkEmpty) return { ...firstOkEmpty, tried };
  throw lastError ?? new Error(`Ningún endpoint funcionó: ${paths.join(", ")}`);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "missing auth header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  // Nombres de secrets case-sensitive, tal como están seteados en el proyecto.
  const xubioClientId = Deno.env.get("Client_id");
  const xubioClientSecret = Deno.env.get("Secret_id");
  const xubioTokenUrl = Deno.env.get("Token_URL") || DEFAULT_TOKEN_URL;

  if (!supabaseUrl || !supabaseAnonKey) {
    return json({ error: "supabase env missing" }, 500);
  }
  if (!xubioClientId || !xubioClientSecret) {
    return json({ error: "Client_id / Secret_id not configured" }, 500);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return json({ error: "unauthorized" }, 401);
  }

  const results: SyncResult[] = [];

  const logSync = async (r: SyncResult) => {
    await supabase.from("sync_log").insert({
      user_id: user.id,
      resource: r.resource,
      status: r.status,
      items_synced: r.items_synced,
      items_failed: r.items_failed,
      error_message: r.error_message,
      finished_at: new Date().toISOString(),
    });
  };

  let token: string;
  try {
    token = await getXubioToken(xubioTokenUrl, xubioClientId, xubioClientSecret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logSync({ resource: "xubio_token", status: "error", items_synced: 0, items_failed: 0, error_message: msg });
    return json({ error: "xubio auth failed", detail: msg }, 502);
  }

  const terceroMapper = (x: Record<string, unknown>, uid: string) => ({
    user_id: uid,
    xubio_id: String(x.id ?? x.ID ?? x.codigo ?? x.code ?? ""),
    nombre: String(x.nombre ?? x.razonSocial ?? x.descripcion ?? x.name ?? "Sin nombre"),
    cuit: x.cuit ?? x.CUIT ?? x.identificacion ?? null,
    email: x.email ?? x.mail ?? null,
    telefono: x.telefono ?? x.tel ?? null,
  });

  // ===== Clientes =====
  results.push(await syncResource({
    resource: "clientes",
    table: "clientes",
    onConflict: "user_id,xubio_id",
    fetcher: () => fetchXubioTry<Record<string, unknown>>(token, [
      "/clienteBean",
      "/clientesBean",
      "/cliente",
    ]),
    mapper: terceroMapper,
    supabase,
    userId: user.id,
    logSync,
  }));

  // ===== Proveedores =====
  results.push(await syncResource({
    resource: "proveedores",
    table: "proveedores",
    onConflict: "user_id,xubio_id",
    fetcher: () => fetchXubioTry<Record<string, unknown>>(token, [
      "/proveedorBean",
      "/proveedoresBean",
      "/proveedor",
      "/Proveedor",
    ]),
    mapper: terceroMapper,
    supabase,
    userId: user.id,
    logSync,
  }));

  // TODO: facturas pendientes (CxC/CxP) y cheques. Confirmar endpoints con Marcel
  // antes de implementar (Xubio usa nombres como /facturaCobrarBean / /chequeBean,
  // pero varían por instancia / módulos contratados).

  const ok = results.every((r) => r.status === "success");
  return json({ ok, results }, ok ? 200 : 207);
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface FetchResult<T> { items: T[]; path: string; tried: string[] }

interface SyncArgs {
  resource: string;
  table: string;
  onConflict: string;
  fetcher: () => Promise<FetchResult<Record<string, unknown>>>;
  mapper: (row: Record<string, unknown>, userId: string) => Record<string, unknown>;
  supabase: ReturnType<typeof createClient>;
  userId: string;
  logSync: (r: SyncResult) => Promise<void>;
}

async function syncResource(args: SyncArgs): Promise<SyncResult> {
  const { resource, table, onConflict, fetcher, mapper, supabase, userId, logSync } = args;
  try {
    const { items, path, tried } = await fetcher();
    const rows = items.map((it) => mapper(it, userId)).filter((r) => r.xubio_id);
    if (rows.length) {
      const { error } = await supabase.from(table).upsert(rows, { onConflict });
      if (error) throw new Error(error.message);
    }
    const r: SyncResult = {
      resource,
      status: "success",
      items_synced: rows.length,
      items_failed: 0,
      error_message: rows.length === 0
        ? `0 items. Path usado: ${path}. Probados: ${tried.join(", ")}`
        : undefined,
    };
    await logSync(r);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const r: SyncResult = { resource, status: "error", items_synced: 0, items_failed: 0, error_message: msg };
    await logSync(r);
    return r;
  }
}
