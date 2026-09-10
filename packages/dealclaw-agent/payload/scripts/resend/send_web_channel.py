#!/usr/bin/env python3
"""Send invite to web-channel new buyers (Dicom2000 / Casa Montes / Refadom). First-touch → no CC."""
import os, json, datetime, requests

WORKSPACE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw"
ENV = os.path.join(WORKSPACE, "work/mio-api/.env")

def load_key():
    for line in open(ENV):
        line = line.strip()
        if line.startswith("RESEND_API_KEY="):
            return line.split("=", 1)[1]
    return ""

FROM = "thia@mail.dealclaw.io"
SUBJECT = "STELANG — cafeteras OEM/ODM 10-50 USD (China Homelife México, 8-10 sep)"
BOOTH = "Centro Citibanamex, Stand HALL D-B220"

recipients = [
    ("Dicom2000", "ventas@dicom2000.com.mx"),
    ("Casa Montes", "compras01casamontes@hotmail.com"),
    ("Refadom", "contacto@refadom.mx"),
]

def body(company):
    return f"""Hola, equipo de {company},

Soy Maxd, de Foshan Shunde Stelong Electrical Appliance (marca STELANG), fabricante chino de cafeteras para el hogar.

Estaremos en China Homelife México (8-10 septiembre, {BOOTH}) con cafeteras de cápsulas (Nespresso/K-Cup/Dolce Gusto), molinos, espumadores de leche, goteo y espresso semiautomático — 10-50 USD FOB, OEM/ODM disponible.

Para clientes que confirman un primer pedido en el stand, ofrecemos un 10% de descuento exclusivo.

¿Le gustaría coordinar una cita durante la feria? Será un gusto mostrarle las muestras en persona y hablar de condiciones.

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com"""

def main():
    api_key = load_key()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    log = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")
    for company, to in recipients:
        payload = {"from": FROM, "to": [to], "subject": SUBJECT, "text": body(company)}
        try:
            r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
            res = r.json()
            if r.status_code == 200:
                print(f"OK | {company} | {to}")
                with open(log, "a") as f:
                    f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": to, "subject": SUBJECT, "resend_id": res.get("id","?"), "status": "OK", "type": "web-invite"}, ensure_ascii=False) + "\n")
            else:
                print(f"FAIL {r.status_code} | {company} | {to} | {json.dumps(res,ensure_ascii=False)[:120]}")
        except Exception as e:
            print(f"ERROR | {company} | {to} | {e}")

if __name__ == "__main__":
    main()
