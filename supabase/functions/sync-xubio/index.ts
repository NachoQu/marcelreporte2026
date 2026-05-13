// Edge Function: sync-xubio
// Pull de datos desde la API de Xubio y upsert en Supabase.
// READ-ONLY por diseño: esta function NUNCA escribe en Xubio.
//   - Único método permitido contra xubio.com: GET (ver xubioGet más abajo).
//   - No hay rutas a POST/PUT/DELETE/PATCH de Xubio.
//   - Si en el futuro hace falta escribir algo, crear OTRA function explícitamente
//     y revisarla aparte.
// Credenciales: secrets del proyecto Supabase. Nombres case-sensitive:
//   Client_id, Secret_id, Token_URL (opcional, usa default si falta).
// Auth: requiere JWT del usuario que invoca; se respeta RLS al escribir en Supabase.

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

// OAuth2 token exchange. El POST es contra el TokenEndpoint (estándar OAuth);
// NO modifica datos en Xubio — sólo intercambia credenciales por un access_token.
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

// READ-ONLY: este helper hardcodea method=GET y es el único punto que toca la API
// de Xubio. NO agregar method como parámetro ni un equivalente xubioPost/Put/Delete.
async function fetchXubioRaw(token: string, path: string): Promise<{ raw: unknown; rawText: string }> {
  const res = await fetch(BASE_URL + path, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Xubio GET ${path} ${res.status}: ${rawText.slice(0, 300)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error(`Xubio GET ${path}: respuesta no es JSON (${rawText.slice(0, 200)})`);
  }
  return { raw, rawText };
}

async function fetchXubio<T = unknown>(token: string, path: string): Promise<T[]> {
  const { raw } = await fetchXubioRaw(token, path);
  return unwrapList<T>(raw);
}

function describeShape(data: unknown): string {
  if (data === null) return "null";
  if (data === undefined) return "undefined";
  if (Array.isArray(data)) return `array(len=${data.length})`;
  if (typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>);
    return `object(keys=[${keys.join(", ")}])`;
  }
  return typeof data;
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
// Incluye `shape` y `sample` para diagnosticar 0-items.
async function fetchXubioTry<T>(token: string, paths: string[]): Promise<{
  items: T[];
  path: string;
  tried: string[];
  shape: string;
  sample: string;
}> {
  const tried: string[] = [];
  let firstOkEmpty: { items: T[]; path: string; shape: string; sample: string } | null = null;
  let lastError: Error | null = null;
  for (const p of paths) {
    tried.push(p);
    try {
      const { raw, rawText } = await fetchXubioRaw(token, p);
      const items = unwrapList<T>(raw);
      const shape = describeShape(raw);
      const sample = rawText.slice(0, 400);
      if (items.length > 0) return { items, path: p, tried, shape, sample };
      if (!firstOkEmpty) firstOkEmpty = { items, path: p, shape, sample };
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

  // Diagnóstico: a qué empresa apunta este token. Si las creds están atadas a una
  // empresa vacía, todos los GET volverán 0 items.
  try {
    const { raw, rawText } = await fetchXubioRaw(token, "/miempresa");
    await logSync({
      resource: "miempresa",
      status: "success",
      items_synced: 0,
      items_failed: 0,
      error_message: `shape=${describeShape(raw)} sample=${rawText.slice(0, 300)}`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logSync({ resource: "miempresa", status: "error", items_synced: 0, items_failed: 0, error_message: msg });
  }

  // Nombres reales de campos verificados con test_xubio.py:
  //   clientes:   { cliente_id, nombre }
  //   proveedores:{ proveedorid, nombre }
  //   facturas:   { transaccionid, numeroDocumento, fecha, fechaVto?, importetotal, cliente|proveedor }

  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : v != null ? Number(v) : NaN;
    return Number.isFinite(n) ? n : 0;
  };

  // Extrae nombre de una entidad anidada (cliente / proveedor / moneda / etc).
  const partyName = (x: unknown): string | null => {
    if (!x || typeof x !== "object") return null;
    const o = x as Record<string, unknown>;
    return (o.nombre ?? o.razonSocial ?? o.descripcion ?? null) as string | null;
  };

  // ===== Clientes (catálogo) =====
  results.push(await syncResource({
    resource: "clientes",
    table: "clientes",
    onConflict: "user_id,xubio_id",
    fetcher: () => fetchXubioTry<Record<string, unknown>>(token, ["/clienteBean"]),
    mapper: (c, uid) => ({
      user_id: uid,
      xubio_id: String(c.cliente_id ?? c.id ?? c.ID ?? ""),
      nombre: String(c.nombre ?? c.razonSocial ?? "Sin nombre"),
      cuit: (c.cuit ?? c.CUIT ?? c.identificacion ?? null) as string | null,
      email: (c.email ?? c.mail ?? null) as string | null,
      telefono: (c.telefono ?? c.tel ?? null) as string | null,
    }),
    supabase,
    userId: user.id,
    logSync,
  }));

  // ===== Proveedores (catálogo) =====
  results.push(await syncResource({
    resource: "proveedores",
    table: "proveedores",
    onConflict: "user_id,xubio_id",
    fetcher: () => fetchXubioTry<Record<string, unknown>>(token, ["/ProveedorBean"]),
    mapper: (p, uid) => ({
      user_id: uid,
      xubio_id: String(p.proveedorid ?? p.proveedorId ?? p.id ?? p.ID ?? ""),
      nombre: String(p.nombre ?? p.razonSocial ?? "Sin nombre"),
      cuit: (p.cuit ?? p.CUIT ?? p.identificacion ?? null) as string | null,
      email: (p.email ?? p.mail ?? null) as string | null,
      telefono: (p.telefono ?? p.tel ?? null) as string | null,
    }),
    supabase,
    userId: user.id,
    logSync,
  }));

  // ===== Cuentas por cobrar (facturas de venta) =====
  // Xubio no expone "saldo pendiente" en el comprobante. Asumimos pendiente
  // por default; cruzar con /cobranzaBean queda para iteración futura.
  results.push(await syncResource({
    resource: "cuentas_por_cobrar",
    table: "cuentas_por_cobrar",
    onConflict: "user_id,xubio_id",
    fetcher: () => fetchXubioTry<Record<string, unknown>>(token, ["/comprobanteVentaBean"]),
    mapper: (f, uid) => {
      const total = num(f.importetotal ?? f.importeTotal ?? f.total ?? f.importeMonPrincipal);
      return {
        user_id: uid,
        xubio_id: String(f.transaccionid ?? f.id ?? ""),
        numero_factura: String(f.numeroDocumento ?? f.numero ?? "S/N"),
        cliente_nombre: partyName(f.cliente),
        fecha_emision: (f.fecha ?? null) as string | null,
        fecha_vencimiento: (f.fechaVto ?? f.fecha ?? null) as string | null,
        importe: total,
        importe_cobrado: 0,
        estado: "pendiente",
      };
    },
    supabase,
    userId: user.id,
    logSync,
  }));

  // ===== Cuentas por pagar (facturas de compra) =====
  // Las compras no tienen fechaVto — usamos fechaComprobante / fechaFiscal / fecha.
  results.push(await syncResource({
    resource: "cuentas_por_pagar",
    table: "cuentas_por_pagar",
    onConflict: "user_id,xubio_id",
    fetcher: () => fetchXubioTry<Record<string, unknown>>(token, ["/comprobanteCompraBean"]),
    mapper: (f, uid) => {
      const total = num(f.importetotal ?? f.importeTotal ?? f.total ?? f.importeMonPrincipal);
      return {
        user_id: uid,
        xubio_id: String(f.transaccionid ?? f.id ?? ""),
        numero_factura: String(f.numeroDocumento ?? f.numero ?? "S/N"),
        proveedor_nombre: partyName(f.proveedor),
        fecha_emision: (f.fecha ?? f.fechaComprobante ?? null) as string | null,
        fecha_vencimiento: (f.fechaComprobante ?? f.fechaFiscal ?? f.fecha ?? null) as string | null,
        importe: total,
        importe_pagado: 0,
        estado: "pendiente",
      };
    },
    supabase,
    userId: user.id,
    logSync,
  }));

  // NOTE: Xubio no expone endpoint dedicado de cheques. Vienen como medios de pago
  // dentro de /cobranzaBean (cheques recibidos) y /pagoBean (cheques emitidos).
  // Implementarlo requiere parsear el detalle de cada cobranza/pago — pendiente.

  const ok = results.every((r) => r.status === "success");
  return json({ ok, results }, ok ? 200 : 207);
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface FetchResult<T> {
  items: T[];
  path: string;
  tried: string[];
  shape: string;
  sample: string;
}

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
    const { items, path, tried, shape, sample } = await fetcher();
    const rows = items.map((it) => mapper(it, userId)).filter((r) => r.xubio_id);
    if (rows.length) {
      const { error } = await supabase.from(table).upsert(rows, { onConflict });
      if (error) throw new Error(error.message);
    }
    let error_message: string | undefined;
    if (rows.length === 0) {
      // 0 rows tras mapear: o vino vacío, o el mapper filtró todo por falta de id.
      const firstItemKeys = items.length > 0 && typeof items[0] === "object"
        ? Object.keys(items[0] as Record<string, unknown>).slice(0, 20).join(", ")
        : "(no items)";
      error_message =
        `0 rows guardadas. Path: ${path} | Probados: ${tried.join(", ")} | ` +
        `Respuesta shape: ${shape} | Items extraídos: ${items.length} | ` +
        `Keys del 1er item: [${firstItemKeys}] | Sample: ${sample}`;
    }
    const r: SyncResult = {
      resource,
      status: "success",
      items_synced: rows.length,
      items_failed: 0,
      error_message,
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
