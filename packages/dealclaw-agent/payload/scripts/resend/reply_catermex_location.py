#!/usr/bin/env python3
"""Reply CATERMEX (Mauricio) — answer expo location, re-invite. CC waimao@stelang.com"""
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
TO = "msandoval@catermex.mx"
CC = "waimao@stelang.com"
CC_LIST = ["waimao@stelang.com", "maxiaodong@meorient.com", "lucky@stelang.com"]
SUBJECT = "Re: STELANG — ubicación de la exposición (China Homelife México)"

BODY = """Hola Mauricio,

Gracias por su respuesta.

La exposición China Homelife México se llevará a cabo en el World Trade Center de la Ciudad de México, los días 8, 9 y 10 de septiembre.

Nos encantaría recibirlos en nuestro stand para mostrarles nuestras cafeteras (cápsulas, molinos, espumadores de leche, goteo y espresso semiautomáticas), en rango de 10-50 USD FOB, con OEM/ODM.

¿Les gustaría que coordinemos una cita durante esos días? Quedo atento para confirmarles el número de stand y un horario.

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com"""

def main():
    api_key = load_key()
    payload = {"from": FROM, "to": [TO], "cc": CC_LIST, "subject": SUBJECT, "text": BODY}
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
    res = r.json()
    rid = res.get("id", "?")
    status = "OK" if r.status_code == 200 else f"FAIL {r.status_code}"
    print(f"{status} | {TO} | {rid} | {r.status_code}")
    if r.status_code == 200:
        log = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")
        with open(log, "a") as f:
            f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": TO, "cc": CC_LIST, "subject": SUBJECT, "resend_id": rid, "status": status}, ensure_ascii=False) + "\n")
    else:
        print(json.dumps(res, ensure_ascii=False)[:300])

if __name__ == "__main__":
    main()
