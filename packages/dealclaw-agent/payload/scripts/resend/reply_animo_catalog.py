#!/usr/bin/env python3
"""Reply to ANIMO IMPORTACIONES (Gustavo) with STELANG catalog attached."""
import os, json, base64, datetime, requests

WORKSPACE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw"
ENV = os.path.join(WORKSPACE, "work/mio-api/.env")
PDF = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw/scripts/resend/STELANG_Catalogo_Cafeteras_2026.pdf"

def load_key():
    for line in open(ENV):
        line = line.strip()
        if line.startswith("RESEND_API_KEY="):
            return line.split("=", 1)[1]
    return ""

FROM = "thia@mail.dealclaw.io"
TO = "aniimportaciones@gmail.com"
CC = "maxd30317@gmail.com"
SUBJECT = "Re: Catálogo STELANG — cafeteras (10-50 USD, OEM/ODM)"

BODY = """Estimado Gustavo,

Gracias por su respuesta y por el interés en nuestros productos.

Le adjunto nuestro catálogo de cafeteras STELANG. Cubrimos:

- Cafeteras de cápsulas (Nespresso / K-Cup / Dolce Gusto)
- Molinos de café
- Espumadores de leche
- Cafeteras de goteo / americanas
- Máquinas de espresso semiautomáticas

Rango de precio 10-50 USD FOB, OEM/ODM disponible, MOQ flexible, ISO9001 / BSCI.

También estaremos en China Homelife México (8-10 de septiembre, CDMX) — sería un gusto agendar una cita para mostrarle los productos en persona.

¿Le parece coordinar una reunión durante la feria?

Saludos,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com"""

def main():
    api_key = load_key()
    with open(PDF, "rb") as f:
        pdf_b64 = base64.b64encode(f.read()).decode("utf-8")

    payload = {
        "from": FROM,
        "to": [TO],
        "cc": [CC],
        "subject": SUBJECT,
        "text": BODY,
        "attachments": [
            {
                "filename": "STELANG_Catalogo_Cafeteras_2026.pdf",
                "content": pdf_b64,
            }
        ],
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=60)
    res = r.json()
    rid = res.get("id", "?")
    status = "OK" if r.status_code == 200 else f"FAIL {r.status_code}"
    print(f"{status} | {TO} | {rid} | {r.status_code}")
    if r.status_code != 200:
        print("响应:", json.dumps(res, ensure_ascii=False)[:500])
    else:
        log = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")
        with open(log, "a") as f:
            f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": TO, "cc": CC, "subject": SUBJECT, "resend_id": rid, "status": status, "attachment": "STELANG_Catalogo_Cafeteras_2026.pdf"}, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()
