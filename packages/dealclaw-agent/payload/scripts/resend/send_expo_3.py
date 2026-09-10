#!/usr/bin/env python3
"""Send invite to 3 verified EXPO-registered buyers (not Mfg, not contacted). First-touch → no CC."""
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
# 首封冷触达：不 CC（CC 规则 v2）

recipients = [
    ("IRMSEN", "abdala020588@icloud.com", "Jorge"),
    ("GRUPO B HOGAR MEXICO", "facturacionbhogar@gmail.com", "David"),
    ("DISTPAC", "ccosmev@gmail.com", "Carlos"),
]

SUBJECT = "STELANG — cafeteras (fábrica china) en China Homelife México, 8-10 sep"

def body(company, first_name):
    return f"""Hola {first_name},

Soy Maxd, gerente de negocios de Foshan Shunde Stelong Electrical Appliance (marca STELANG), fabricante chino especializado en máquinas de café para el hogar.

Estaremos presentando nuestras cafeteras en China Homelife México, del 8 al 10 de septiembre en el Centro Citibanamex de la Ciudad de México.

Nuestra línea (10-50 USD FOB):
- Cafeteras de cápsulas (Nespresso / K-Cup / Dolce Gusto)
- Molinos de café
- Espumadores de leche
- Cafeteras de goteo / americanas
- Máquinas de espresso semiautomáticas

OEM/ODM con MOQ flexible, ISO9001 / BSCI.

¿Le gustaría coordinar una cita durante la feria, o le envío nuestro catálogo?

Quedo atento.

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com"""

def main():
    api_key = load_key()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    log = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")
    for company, to, first in recipients:
        payload = {"from": FROM, "to": [to], "subject": SUBJECT, "text": body(company, first)}
        r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
        res = r.json()
        rid = res.get("id", "?")
        status = "OK" if r.status_code == 200 else f"FAIL {r.status_code}"
        print(f"{status} | {company} | {to} | {rid} | {r.status_code}")
        if r.status_code != 200:
            print(json.dumps(res, ensure_ascii=False)[:300])
        else:
            with open(log, "a") as f:
                f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": to, "cc": [], "subject": SUBJECT, "resend_id": rid, "status": status, "type": "expo-invite"}, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()
