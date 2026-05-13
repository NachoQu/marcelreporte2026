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

## Próximos pasos

- Edge Function para `Sincronizar Xubio` (hoy es un placeholder que sólo loguea en `sync_log`).
- Pull de clientes/proveedores desde Xubio → tablas `clientes` / `proveedores`.
- Pull de CxC / CxP / cheques desde Xubio con upsert por `xubio_id`.
