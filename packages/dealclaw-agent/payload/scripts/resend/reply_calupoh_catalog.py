#!/usr/bin/env python3
"""Reply to CAFE CALUPOH (Luis) — thanks + catalog + propose Expo Café meeting. CC waimao@stelang.com"""
import os, json, base64, datetime, requests

WORKSPACE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw"
ENV = os.path.join(WORKSPACE, "work/mio-api/.env")
PDF = os.path.join(WORKSPACE, "scripts/resend/STELANG_Catalogo_Cafeteras_2026.pdf")

def load_key():
    for line in open(ENV):
        line = line.strip()
        if line.startswith("RESEND_API_KEY="):
            return line.split("=", 1)[1]
    return ""

FROM = "thia@mail.dealclaw.io"
TO = "arthur.242@gmail.com"
CC = "waimao@stelang.com"
SUBJECT = "Re: STELANG — catálogo y propuesta de reunión (Expo Café, CDMX)"

BODY = """Hola Luis,

Muchas gracias por su respuesta y por el interés en nuestros productos.

Le adjunto nuestro catálogo actualizado de cafeteras STELANG. Cubrimos cafeteras de cápsulas (Nespresso / K-Cup / Dolce Gusto), molinos de café, espumadores de leche, cafeteras de goteo y máquinas de espresso semiautomáticas, en un rango de 10-50 USD FOB, con OEM/ODM y MOQ flexible.

Entendemos perfectamente que en esas fechas estarán en CDMX por Expo Café. De hecho, nosotros también estaremos en Ciudad de México a inicios de septiembre. ¿Les parecería coordinar una reunión presencial durante esos días (3-5 sept) para revisar juntos el catálogo, la lista de precios y las condiciones comerciales?

Así podemos resolver todo de forma directa y a su conveniencia.

Quedo atento a su disponibilidad.

Saludos cordiales,
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
            {"filename": "STELANG_Catalogo_Cafeteras_2026.pdf", "content": pdf_b64}
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
