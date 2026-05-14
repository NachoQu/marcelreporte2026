// Edge Function: sync-xubio-cheques-emitidos
// Pull de cheques propios (emitidos) desde /pagoBean.
// READ-ONLY: solo GET contra xubio.com.
//
// Se separa del sync-xubio principal porque /pagoBean es lento y tiene un bug
// intermitente (PgResultSet.checkClosed → 401) que requiere chunking +
// retries con token fresco. Sumado al resto del sync, se pasa del límite de
// 150s de Edge Functions.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_TOKEN_URL = "https://xubio.com/API/1.1/TokenEndpoint";
const BASE_URL = "https://xubio.com/API/1.1";

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
  if (!res.ok) throw new Error(`Xubio token ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("Xubio token response missing access_token");
  return data.access_token as string;
}

async function fetchXubioRaw(token: string, path: string): Promise<{ raw: unknown; rawText: string }> {
  const res = await fetch(BASE_URL + path, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const rawText = await res.text();
  if (!res.ok) throw new Error(`Xubio GET ${path} ${res.status}: ${rawText.slice(0, 300)}`);
  let raw: unknown;
  try { raw = JSON.parse(rawText); }
  catch { throw new Error(`Xubio GET ${path}: respuesta no es JSON (${rawText.slice(0, 200)})`); }
  return { raw, rawText };
}

function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const k of ["data", "items", "results", "list", "rows", "content"]) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
    for (const v of Object.values(obj)) if (Array.isArray(v)) return v as T[];
  }
  return [];
}

const partyName = (x: unknown): string | null => {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  return (o.nombre ?? o.razonSocial ?? o.descripcion ?? null) as string | null;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "missing auth header" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const xubioClientId = Deno.env.get("Client_id");
  const xubioClientSecret = Deno.env.get("Secret_id");
  const xubioTokenUrl = Deno.env.get("Token_URL") || DEFAULT_TOKEN_URL;

  if (!supabaseUrl || !supabaseAnonKey) return json({ error: "supabase env missing" }, 500);
  if (!xubioClientId || !xubioClientSecret) return json({ error: "Client_id / Secret_id not configured" }, 500);

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);

  const logSync = async (status: "success" | "error", items_synced: number, error_message?: string) => {
    await supabase.from("sync_log").insert({
      user_id: user.id,
      resource: "cheques_emitidos",
      status,
      items_synced,
      items_failed: 0,
      error_message,
      finished_at: new Date().toISOString(),
    });
  };

  let token: string;
  try {
    token = await getXubioToken(xubioTokenUrl, xubioClientId, xubioClientSecret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logSync("error", 0, msg);
    return json({ error: "xubio auth failed", detail: msg }, 502);
  }

  // Cleanup previo de filas con xubio_id (las manuales se preservan).
  await supabase.from("cheques_emitidos").delete().not("xubio_id", "is", null);

  // Mapa banco_id → nombre.
  const bancos: Record<string, string> = {};
  try {
    const { raw: bancosRaw } = await fetchXubioRaw(token, "/banco");
    for (const b of unwrapList<Record<string, unknown>>(bancosRaw)) {
      const id = String(b.banco_id ?? b.id ?? b.ID ?? "");
      if (id) bancos[id] = String(b.nombre ?? id);
    }
  } catch (_) { /* fallback al codigo */ }

  // Mapa proveedor xubio_id → nombre.
  const proveedoresNombre: Record<string, string> = {};
  const { data: provData } = await supabase
    .from("proveedores")
    .select("xubio_id,nombre")
    .not("xubio_id", "is", null);
  for (const p of provData || []) {
    if (p.xubio_id) proveedoresNombre[String(p.xubio_id)] = String(p.nombre);
  }

  // Ventana: 90 días en chunks de 30. Con pausas + retries calza dentro del límite.
  const chunks: { desde: string; hasta: string }[] = [];
  const todayDate = new Date();
  const WINDOW_DAYS = 90;
  const CHUNK_DAYS = 30;
  for (let offset = 0; offset < WINDOW_DAYS; offset += CHUNK_DAYS) {
    const hasta = new Date(todayDate);
    hasta.setDate(todayDate.getDate() - offset);
    const desde = new Date(todayDate);
    desde.setDate(todayDate.getDate() - Math.min(offset + CHUNK_DAYS, WINDOW_DAYS));
    chunks.push({
      desde: desde.toISOString().slice(0, 10),
      hasta: hasta.toISOString().slice(0, 10),
    });
  }

  const pagos: Record<string, unknown>[] = [];
  const chunkErrors: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const { desde, hasta } = chunks[i];
    // Token fresco + pausa entre chunks: el backend de Xubio rompe la sesión
    // si le pegamos varias veces seguidas a /pagoBean.
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      try { token = await getXubioToken(xubioTokenUrl, xubioClientId, xubioClientSecret); }
      catch (_) { /* sigue con el viejo */ }
    }

    const path = `/pagoBean?fechaDesde=${desde}&fechaHasta=${hasta}`;
    let chunkPagos: Record<string, unknown>[] = [];
    let attempt = 0;
    let lastErr: string | null = null;
    while (attempt < 3) {
      try {
        const { raw } = await fetchXubioRaw(token, path);
        chunkPagos = unwrapList<Record<string, unknown>>(raw);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        attempt++;
        if (lastErr.includes("401") || lastErr.includes("PgResultSet") || lastErr.includes("checkClosed")) {
          try { token = await getXubioToken(xubioTokenUrl, xubioClientId, xubioClientSecret); }
          catch (_) { /* */ }
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        } else {
          break;
        }
      }
    }
    if (lastErr) chunkErrors.push(`${desde}→${hasta}: ${lastErr.slice(0, 120)}`);
    pagos.push(...chunkPagos);
  }

  const chequeCutoff = new Date();
  chequeCutoff.setDate(chequeCutoff.getDate() - 7);
  const chequeCutoffISO = chequeCutoff.toISOString().slice(0, 10);

  const rows: Record<string, unknown>[] = [];
  for (const p of pagos) {
    const provObj = (p.proveedor ?? {}) as Record<string, unknown>;
    const provId = String(provObj.id ?? provObj.ID ?? provObj.proveedorid ?? "");
    const provNombre = proveedoresNombre[provId] ?? partyName(provObj);

    const instrumentos = (p.transaccionInstrumentoDePago ?? []) as Record<string, unknown>[];
    if (!Array.isArray(instrumentos)) continue;

    for (const inst of instrumentos) {
      const cuenta = (inst.cuenta ?? {}) as Record<string, unknown>;
      const codigo = String(cuenta.codigo ?? "");
      const cuentaNombre = String(cuenta.nombre ?? "");

      // Cheque propio = cuenta contable empieza con CHEQUES_DIFERIDOS_xxx.
      const esChequePropio =
        inst.chequePropio === true ||
        codigo.startsWith("CHEQUES_DIFERIDOS") ||
        codigo === "CHEQUES_PROPIOS" ||
        codigo === "CHEQUES_EMITIDOS" ||
        codigo === "VALORES_EMITIDOS";
      if (!esChequePropio) continue;

      const venc = String(inst.vencimientoCheque ?? inst.vtoCheque ?? inst.fechaVencimiento ?? "").slice(0, 10);
      if (!venc || venc < chequeCutoffISO) continue;

      const bancoObj = (inst.banco ?? {}) as Record<string, unknown>;
      const bancoId = String(bancoObj.ID ?? bancoObj.id ?? "");
      const bancoNombreFromObj = bancos[bancoId] ?? partyName(bancoObj);
      const bancoFromCodigo = codigo.startsWith("CHEQUES_DIFERIDOS_")
        ? codigo.slice("CHEQUES_DIFERIDOS_".length)
        : null;
      const bancoNombre = bancoNombreFromObj ?? bancoFromCodigo ?? cuentaNombre ?? null;

      const numCheque = inst.numeroCheque ?? inst.numCheque ?? inst.numero;
      const ipId = inst.transaccionIPId ?? inst.transaccionICId ?? inst.id;
      const numeroDisplay = String(numCheque ?? ipId ?? "S/N");
      const xubioId = `${p.transaccionid ?? p.id ?? ""}_${ipId ?? ""}_${numCheque ?? ""}`;
      rows.push({
        user_id: user.id,
        xubio_id: xubioId,
        numero: numeroDisplay,
        proveedor_nombre: provNombre,
        banco: bancoNombre,
        fecha_emision: (p.fecha ?? p.fechaComprobante ?? null) as string | null,
        fecha_vencimiento: venc,
        importe: num(inst.importe ?? inst.monto ?? 0),
        estado: "emitido",
      });
    }
  }

  if (rows.length) {
    const { error } = await supabase
      .from("cheques_emitidos")
      .upsert(rows, { onConflict: "user_id,xubio_id" });
    if (error) {
      await logSync("error", 0, error.message);
      return json({ error: "supabase upsert failed", detail: error.message }, 500);
    }
  }

  const diagMsg = chunkErrors.length > 0
    ? `${rows.length} cheques. Pagos: ${pagos.length}. Chunk errors: [${chunkErrors.join(" | ")}]`
    : undefined;

  await logSync("success", rows.length, diagMsg);

  return json({
    ok: true,
    items_synced: rows.length,
    pagos_scanned: pagos.length,
    chunks_total: chunks.length,
    chunks_failed: chunkErrors.length,
    chunk_errors: chunkErrors,
  });
});
