# Marcel Reporte 2026 — Cash Flow Xubio

App de proyección de cash flow que importa datos desde la API de Xubio (clientes, facturas de venta/compra, cheques) y los suma con movimientos manuales (sueldos, impuestos, préstamos).

## Stack

- **Frontend**: HTML + JS vanilla + Chart.js (single file `index.html`)
- **Backend**: Supabase (Postgres + Auth + RLS)
- **Integración**: API Xubio v1.1 (`test_xubio.py` diagnostica auth)
- **Deploy**: Vercel (estático)

## Estructura de la BD

Tablas con RLS por `auth.uid()`:

| Tabla | Propósito |
|---|---|
| `xubio_integrations` | Credenciales OAuth + estado de sync |
| `clientes` / `proveedores` | Catálogos importados de Xubio |
| `cuentas_bancarias` | Saldos iniciales (caja, bancos, MP, plazo fijo) |
| `cuentas_por_cobrar` / `cuentas_por_pagar` | Facturas pendientes |
| `cheques_recibidos` / `cheques_emitidos` | Cheques en cartera / emitidos |
| `movimientos_manuales` | Sueldos, AFIP, préstamos |
| `sync_log` | Registro de importaciones desde Xubio |

## Desarrollo local

```bash
# Abrir el HTML directo (no necesita build)
open index.html

# Probar credenciales Xubio
CLIENT_ID=xxx CLIENT_SECRET=yyy python3 test_xubio.py
```

## Auth

Email + contraseña vía Supabase Auth. La primera vez, "Crear cuenta" → confirmar email → ingresar.

## Sincronización Xubio (Edge Function)

La function `sync-xubio` (en `supabase/functions/sync-xubio/`) lee las credenciales de
Xubio desde **secrets del proyecto Supabase** (no de la BD). Hay que setearlas una vez:

```bash
# desde la carpeta del repo, con la Supabase CLI logueada al proyecto
supabase secrets set XUBIO_CLIENT_ID=tu_client_id XUBIO_CLIENT_SECRET=tu_client_secret \
  --project-ref pvycxqgwkvlroxasvxqv
```

Alternativa: setearlas desde el Dashboard de Supabase → **Edge Functions → sync-xubio →
Secrets**.

La function:
- Obtiene un token con `Authorization: Basic` (el patrón A validado en `test_xubio.py`).
- Hace upsert de clientes (`/clienteBean`) y proveedores (`/proveedorBean`) por
  `(user_id, xubio_id)`.
- Loguea cada resource en `sync_log`.

El botón **"Sincronizar Xubio"** del frontend la invoca con `sb.functions.invoke()`.

## Próximos pasos

- Confirmar endpoints Xubio para facturas (CxC/CxP) y cheques, y agregar `syncResource(...)`
  en la function.
- Deploy a Vercel (estático).
