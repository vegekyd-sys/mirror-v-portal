#!/usr/bin/env python3
"""Follow-up ANIMO + CAFE CALUPOH (both replied 8/21, no follow-up since). CC 3 fixed emails."""
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

emails = [
    {
        "to": "aniimportaciones@gmail.com",
        "subject": "Re: STELANG catálogo — seguimiento (ANIMO Importaciones)",
        "body": """Hola Gustavo,

Espero que se encuentre bien. Hace unos días le compartí nuestro catálogo de cafeteras STELANG y quería darle seguimiento.

¿Ha tenido oportunidad de revisarlo? Si le interesa alguna línea en particular (cápsulas, molinos, espumadores, goteo o espresso), con gusto le preparo una propuesta más detallada con precios y condiciones.

También estaremos en China Homelife México (8-10 de septiembre, WTC Ciudad de México), por si desea ver los productos en persona.

Quedo atento a sus comentarios.

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com""",
    },
    {
        "to": "arthur.242@gmail.com",
        "subject": "Re: STELANG — propuesta de reunión en Expo Café (seguimiento)",
        "body": """Hola Luis,

Espero que se encuentre bien. Le escribo para darle seguimiento a mi mensaje anterior, donde le compartí nuestro catálogo.

Como ustedes estarán en Expo Café (3-5 de septiembre, CDMX), ¿les parecería coordinar una reunión presencial durante esos días? Nosotros también estaremos en Ciudad de México a inicios de septiembre, y me encantaría revisar con ustedes el catálogo, la lista de precios y las condiciones comerciales en persona.

Quedo atento a su disponibilidad para proponerles un horario.

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
        else:
            with open(log, "a") as f:
                f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": e["to"], "cc": CC_LIST, "subject": e["subject"], "resend_id": rid, "status": status, "type": "followup"}, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()
