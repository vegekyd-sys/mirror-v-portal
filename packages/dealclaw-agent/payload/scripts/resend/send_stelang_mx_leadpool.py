#!/usr/bin/env python3
"""STELANG Mexico exhibition invite email — 12 lead-pool buyers (engine-search, non pre-registered)."""
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
CC = "maxd30317@gmail.com"
SUBJECT = "STELANG (fábrica china de cafeteras) — invitación a China Homelife México, 8-10 sep"

def body(company):
    return f"""Hola, equipo de {company},

Soy Maxd, gerente de negocios de Foshan Shunde Stelong Electrical Appliance (marca STELANG), fabricante chino especializado en máquinas de café para el hogar.

Estaremos presentes en China Homelife México (8-10 de septiembre, CDMX) y nos encantaría invitarles a visitar nuestro stand y conversar sobre una posible colaboración.

Nuestra línea (10-50 USD FOB):
- Cafeteras de cápsulas (Nespresso / K-Cup / Dolce Gusto)
- Molinos de café
- Espumadores de leche
- Cafeteras de goteo / americanas
- Máquinas de espresso semiautomáticas

OEM/ODM con MOQ flexible, ISO9001 / BSCI, envío desde Shunde.

¿Le interesa agendar una cita durante la feria, o le envío catálogo y lista de precios?

Saludos,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com"""

# (公司名, 收件邮箱) — 12 家有邮箱的买家
recipients = [
    ("CAFE CALUPOH", "arthur.242@gmail.com"),
    ("CAFETERAS Y REFACCIONES DE EUROPA", "cafeteraseuropeas2@gmail.com"),
    ("ANIMO IMPORTACIONES", "aniimportaciones@gmail.com"),
    ("CATERMEX", "msandoval@catermex.mx"),
    ("KAEGA COMERCIAL", "escobarrmz@hotmail.com"),
    ("CEM GLOBAL", "campa40@hotmail.com"),
    ("DISTRIBUIDORA DEL HOGAR", "chit.fernando@hotmail.com"),
    ("MERCANTIL DEL HOGAR", "mdh@mercantildelhogar.mx"),
    ("VEANA", "93gomezuri@gmail.com"),
    ("ESO QUIERO", "abril@sgmmercadotecnia.com"),
    ("ELREYDELPRECIO", "cruzbrindiscandelariaantonia@gmail.com"),
    ("TECHNOLOGICAL STORE MEXICO", "armamv@msn.com"),
]

log_path = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")

def main():
    api_key = load_key()
    if not api_key:
        print("NO_API_KEY"); return
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    for company, to in recipients:
        payload = {"from": FROM, "to": [to], "cc": [CC], "subject": SUBJECT, "text": body(company)}
        try:
            r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
            res = r.json()
            rid = res.get("id", "?")
            status = "OK" if r.status_code == 200 else f"FAIL {r.status_code}"
            print(f"{status} | {to} | {rid}")
            with open(log_path, "a") as f:
                f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": to, "cc": CC, "subject": SUBJECT, "resend_id": rid, "status": status}, ensure_ascii=False) + "\n")
        except Exception as e:
            print(f"ERROR | {to} | {e}")

if __name__ == "__main__":
    main()
