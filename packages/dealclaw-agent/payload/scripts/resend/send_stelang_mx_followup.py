#!/usr/bin/env python3
"""STELANG Mexico follow-up email (day+3). Idempotent: logs and skips already-sent followups."""
import os, json, sys, datetime
import requests

WORKSPACE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw"
ENV = os.path.join(WORKSPACE, "work/mio-api/.env")
STATE = os.path.join(WORKSPACE, "scripts/resend/stelang-mx-followup-state.json")

def load_key():
    for line in open(ENV):
        line = line.strip()
        if line.startswith("RESEND_API_KEY="):
            return line.split("=", 1)[1]
    return ""

def load_state():
    if os.path.exists(STATE):
        return json.load(open(STATE))
    return {"sent": {}}

def save_state(s):
    json.dump(s, open(STATE, "w"), ensure_ascii=False, indent=2)

FROM = "thia@mail.dealclaw.io"
CC = "maxd30317@gmail.com"
SUBJECT = "Seguimiento — STELANG cafeteras (China Homelife México, 8-10 sep)"

def follow_body(company):
    return f"""Hola equipo de {company},

Les escribo como seguimiento a mi mensaje anterior. Soy Maxd de STELANG (fabricante chino de cafeteras), y estaremos en China Homelife México del 8 al 10 de septiembre en CDMX.

Si ya respondieron, ignoren este mensaje. Si no, me encantaría agendar una cita en la feria o enviarles catálogo y lista de precios (cafeteras de cápsulas, molinos, espumadores de leche — 10-50 USD, OEM/ODM).

Gracias y saludos,
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

def main():
    api_key = load_key()
    if not api_key:
        print("NO_API_KEY"); sys.exit(1)
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    state = load_state()
    today = datetime.date.today().isoformat()
    # only run on or after target date
    target = os.environ.get("STELANG_FOLLOWUP_DATE", "2026-08-21")
    if today < target:
        print(f"SKIP (before {target})")
        return
    for company, to in recipients:
        if to in state["sent"]:
            print(f"SKIP already-sent | {to}")
            continue
        payload = {"from": FROM, "to": [to], "cc": [CC], "subject": SUBJECT, "text": follow_body(company)}
        try:
            r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
            res = r.json()
            rid = res.get("id", "?")
            ok = r.status_code == 200
            print(("OK" if ok else "FAIL " + str(r.status_code)) + f" | {to} | {rid}")
            if ok:
                state["sent"][to] = {"date": today, "resend_id": rid}
        except Exception as e:
            print(f"ERROR | {to} | {e}")
    save_state(state)

if __name__ == "__main__":
    main()
