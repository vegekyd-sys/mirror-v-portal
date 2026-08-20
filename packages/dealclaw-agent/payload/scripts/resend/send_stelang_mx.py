#!/usr/bin/env python3
"""Send STELANG Mexico HOMELIFE outreach emails via Resend, CC maxd30317@gmail.com."""
import os, json, sys, datetime
import requests

api_key = os.environ.get("RESEND_API_KEY") or ""
if not api_key:
    # fall back to reading from work/mio-api/.env
    env_path = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw/work/mio-api/.env"
    for line in open(env_path):
        line = line.strip()
        if line.startswith("RESEND_API_KEY="):
            api_key = line.split("=", 1)[1]
            break

headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

FROM = "thia@mail.dealclaw.io"
CC = "maxd30317@gmail.com"
SUBJECT = "Proveedor OEM/ODM de cafeteras STELANG — cita en China Homelife México sep 2026"

def body(company):
    return f"""Estimado equipo de {company},

Me presento: Maxd, gerente de negocios de Foshan Shunde Stelong Electrical Appliance (marca STELANG), fabricante chino especializado en máquinas de café para el hogar.

Estaremos en China Homelife México (8–10 septiembre, CDMX) y buscamos distribuidores e importadores para el mercado mexicano.

Línea y rango de precio (10–50 USD FOB):
- Cafeteras de cápsulas (Nespresso / K-Cup / Dolce Gusto)
- Molinos de café
- Espumadores de leche
- Cafeteras de goteo / americanas
- Máquinas de espresso semiautomáticas

OEM/ODM con MOQ flexible, ISO9001 / BSCI, envío desde Shunde.

¿Agendamos una cita en la feria o le envío catálogo y lista de precios?

Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com"""

recipients = [
    ("Disa México", "contacto@disamexico.com.mx"),
    ("Multimarcas del Bajío", "ventas2@multimarcasdelbajio.com"),
    ("Xaze", "contacto@xaze.com.mx"),
    ("TodoPorMayoreo.mx", "atencionalcliente@todopormayoreo.mx"),
    ("Café Boato", "ventas@cafeboato.com"),
    ("Coffee Solutions / Babani", "ventas@babani.com.mx"),
    ("EPC México", "ventas@epcmexico.com"),
    ("Cafeteras México", "ventas@cafeterasmexico.mx"),
]

log_path = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw/scripts/founder-direct/sent-log.jsonl"

for company, to in recipients:
    payload = {
        "from": FROM,
        "to": [to],
        "cc": [CC],
        "subject": SUBJECT,
        "text": body(company),
    }
    try:
        resp = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
        result = resp.json()
        rid = result.get("id", "?")
        status = "OK" if resp.status_code == 200 else f"FAIL {resp.status_code}"
        print(f"{status} | {to} | {rid} | {resp.status_code}")
        with open(log_path, "a") as f:
            f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": to, "cc": CC, "subject": SUBJECT, "resend_id": rid, "status": status}, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"ERROR | {to} | {e}")
