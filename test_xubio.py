"""
Diagnóstico de credenciales y conectividad con la API de Xubio.
Prueba múltiples variantes de auth porque Xubio no usa el OAuth estándar.
Compatible con Python 3.9+.
"""
import os
import sys
import json
import time
import base64
from typing import Optional
import requests

TOKEN_URL = "https://xubio.com/API/1.1/TokenEndpoint"
BASE_URL = "https://xubio.com/API/1.1"

TEST_ENDPOINTS = [
    "/clienteBean",
    "/productoBean",
    "/empresaBean",
]


def banner(text):
    print("\n" + "=" * 70)
    print(f"  {text}")
    print("=" * 70)


def try_variant(name: str, **kwargs) -> Optional[dict]:
    """Intenta un POST al TokenEndpoint con la config dada y devuelve el JSON si 200."""
    print(f"\n--- Variante: {name} ---")
    t0 = time.time()
    try:
        r = requests.post(TOKEN_URL, timeout=30, **kwargs)
    except Exception as e:
        print(f"  ❌ {type(e).__name__}: {e}")
        return None

    dt = (time.time() - t0) * 1000
    print(f"  Status: {r.status_code}  ({dt:.0f} ms)")
    body = r.text[:500]
    try:
        parsed = r.json()
        print(f"  Body: {json.dumps(parsed, ensure_ascii=False)[:500]}")
    except Exception:
        parsed = None
        print(f"  Body: {body}")

    if r.status_code == 200 and parsed and parsed.get("access_token"):
        return parsed
    return None


def get_token(client_id: str, client_secret: str) -> Optional[str]:
    banner("PASO 1 — Solicitando access_token (probando variantes)")

    # Variante A: Basic Auth header (la más común cuando piden HEADER_AUTHORIZATION)
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    parsed = try_variant(
        "A) Authorization: Basic + grant_type en body",
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        data={"grant_type": "client_credentials"},
    )
    if parsed:
        print(f"\n✅ Funcionó con Basic Auth. Expira en: {parsed.get('expires_in', '?')}s")
        return parsed["access_token"]

    # Variante B: CLIENT_ID + SECRET_ID (nombres en mayúscula como pide el error)
    parsed = try_variant(
        "B) CLIENT_ID + SECRET_ID en body (nombres en mayúscula)",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        data={
            "grant_type": "client_credentials",
            "CLIENT_ID": client_id,
            "SECRET_ID": client_secret,
        },
    )
    if parsed:
        print(f"\n✅ Funcionó con CLIENT_ID/SECRET_ID. Expira en: {parsed.get('expires_in', '?')}s")
        return parsed["access_token"]

    # Variante C: client_id + SECRET_ID mezcla
    parsed = try_variant(
        "C) client_id + SECRET_ID (mezcla)",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "SECRET_ID": client_secret,
        },
    )
    if parsed:
        print(f"\n✅ Funcionó con client_id + SECRET_ID. Expira en: {parsed.get('expires_in', '?')}s")
        return parsed["access_token"]

    # Variante D: como query string
    parsed = try_variant(
        "D) CLIENT_ID + SECRET_ID como query params",
        headers={"Accept": "application/json"},
        params={
            "grant_type": "client_credentials",
            "CLIENT_ID": client_id,
            "SECRET_ID": client_secret,
        },
    )
    if parsed:
        print(f"\n✅ Funcionó como query params. Expira en: {parsed.get('expires_in', '?')}s")
        return parsed["access_token"]

    print("\n❌ Ninguna variante funcionó.")
    return None


def test_endpoint(token: str, path: str) -> bool:
    url = BASE_URL + path
    print(f"\n→ GET {url}")
    t0 = time.time()
    try:
        r = requests.get(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            timeout=30,
        )
    except Exception as e:
        print(f"  ❌ {type(e).__name__}: {e}")
        return False

    dt = (time.time() - t0) * 1000
    print(f"  Status: {r.status_code}  ({dt:.0f} ms)")

    if r.status_code == 200:
        try:
            data = r.json()
            count = len(data) if isinstance(data, list) else "(no es lista)"
            print(f"  ✅ Respuesta OK. Items: {count}")
            if isinstance(data, list) and data:
                first = data[0]
                if isinstance(first, dict):
                    print(f"  Primer item (keys): {list(first.keys())}")
        except Exception:
            print(f"  Body: {r.text[:500]}")
        return True
    else:
        print(f"  Body: {r.text[:500]}")
        return False


def main():
    client_id = os.environ.get("CLIENT_ID")
    client_secret = os.environ.get("CLIENT_SECRET")

    if not client_id or not client_secret:
        print("ERROR: definí las variables CLIENT_ID y CLIENT_SECRET")
        sys.exit(1)

    token = get_token(client_id, client_secret)
    if not token:
        sys.exit(2)

    banner("PASO 2 — Probando endpoint de clientes")
    found = False
    for ep in TEST_ENDPOINTS:
        if test_endpoint(token, ep):
            found = True
            break
    if not found:
        print("\n⚠️  Ningún endpoint de clientes funcionó.")

    banner("FIN")


if __name__ == "__main__":
    main()
