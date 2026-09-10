#!/usr/bin/env python3
"""Confirm CATERMEX 9 Sep visit + booth + contact + ask coffee pref + ask customer mobile/WA. CC 3."""
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
CC_LIST = ["waimao@stelang.com", "maxiaodong@meorient.com", "lucky@stelang.com"]
SUBJECT = "Re: STELANG — confirmado: le esperamos el 9 de septiembre"

BODY = """Hola Mauricio,

Perfecto, le esperamos el 9 de septiembre en nuestro stand. Aquí los datos para su visita:

Ubicación: China Homelife México — Centro Citibanamex
Stand: HALL D - B220
Contacto en la feria: Lucky Lee · +86 134 1825 6321 (WhatsApp disponible)

Para prepararle mejor: ¿qué tipo de café le interesa más? Podemos tener listas muestras de cafeteras de cápsulas (Nespresso / K-Cup / Dolce Gusto), molinos, espumadores de leche, goteo o espresso semiautomático. Si lo desea, también podemos coordinar el envío de una máquina de muestra para que la evalúe.

¿Nos comparte su número de móvil o WhatsApp, por si necesitáramos coordinar algo el día de su visita?

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com"""

def main():
    api_key = load_key()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"from": FROM, "to": [TO], "cc": CC_LIST, "subject": SUBJECT, "text": BODY}
    r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
    res = r.json()
    rid = res.get("id", "?")
    status = "OK" if r.status_code == 200 else f"FAIL {r.status_code}"
    print(f"{status} | {TO} | {rid} | {r.status_code}")
    if r.status_code != 200:
        print(json.dumps(res, ensure_ascii=False)[:300])
    else:
        log = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")
        with open(log, "a") as f:
            f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": TO, "cc": CC_LIST, "subject": SUBJECT, "resend_id": rid, "status": status, "type": "booth-confirm"}, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()
