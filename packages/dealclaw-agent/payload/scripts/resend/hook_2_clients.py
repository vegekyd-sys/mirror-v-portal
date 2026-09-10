#!/usr/bin/env python3
"""CAFE CALUPOH + ANIMO follow-up with 10% first-order hook. CC 3."""
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
CC_LIST = ["waimao@stelang.com", "maxiaodong@meorient.com", "lucky@stelang.com"]
BOOTH = "Centro Citibanamex, Stand HALL D-B220"

emails = [
    {
        "to": "arthur.242@gmail.com",
        "subject": "Re: STELANG — 10% de descuento en su primer pedido (feria)",
        "body": f"""Hola Luis,

Solo una nota importante: para los clientes que nos visitan en la feria y confirman un primer pedido en el stand, ofrecemos un **10% de descuento exclusivo**.

Si puede acercarse a nuestro stand (China Homelife México, 8-10 septiembre, {BOOTH}), podrá ver todas las muestras en persona y aprovechar esta condición especial.

¿Le interesa que le reserve un horario? Solo compártanos qué tipo de café le interesa y su WhatsApp para coordinar.

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com""",
    },
    {
        "to": "aniimportaciones@gmail.com",
        "subject": "Re: STELANG — 10% de descuento en su primer pedido (feria)",
        "body": f"""Hola Gustavo,

Solo una nota importante: para los clientes que nos visitan en la feria y confirman un primer pedido en el stand, ofrecemos un **10% de descuento exclusivo**.

Si puede acercarse a nuestro stand (China Homelife México, 8-10 septiembre, {BOOTH}), podrá ver todas las muestras en persona y aprovechar esta condición especial.

¿Le interesa que le reserve un horario? Solo compártanos qué tipo de café le interesa y su WhatsApp para coordinar.

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com""",
    },
]

def main():
    api_key = load_key()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    log = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")
    for e in emails:
        payload = {"from": FROM, "to": [e["to"]], "cc": CC_LIST, "subject": e["subject"], "text": e["body"]}
        r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
        res = r.json()
        rid = res.get("id", "?")
        status = "OK" if r.status_code == 200 else f"FAIL {r.status_code}"
        print(f"{status} | {e['to']} | {rid} | {r.status_code}")
        if r.status_code != 200:
            print(json.dumps(res, ensure_ascii=False)[:300])

if __name__ == "__main__":
    main()
