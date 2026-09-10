#!/usr/bin/env python3
"""Second follow-up: CATERMEX + ANIMO. CC 3 fixed emails."""
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
        "to": "msandoval@catermex.mx",
        "subject": "Re: STELANG — confirmación de visita (China Homelife, 8-10 sep)",
        "body": """Hola Mauricio,

Le escribo solo para confirmar la ubicación que le compartí: China Homelife México se llevará a cabo en el Centro Citibanamex de la Ciudad de México, del 8 al 10 de septiembre.

Estaremos con muestras de nuestras cafeteras (cápsulas, molinos, espumadores de leche, goteo y espresso semiautomáticas). ¿Le gustaría que le reservemos un horario para atenderle en nuestro stand? Quedo atento para coordinar.

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com""",
    },
    {
        "to": "aniimportaciones@gmail.com",
        "subject": "Re: STELANG catálogo — seguimiento (ANIMO)",
        "body": """Hola Gustavo,

Solo quería hacer un seguimiento. ¿Ha tenido oportunidad de revisar nuestro catálogo de cafeteras STELANG que le compartí?

Si hay alguna línea en particular que le interese (cápsulas, molinos, espumadores de leche, goteo o espresso), con gusto le preparo una propuesta con precios y condiciones a la medida.

También estaremos en China Homelife México (8-10 septiembre, Centro Citibanamex, CDMX), por si desea ver los productos en persona.

Quedo atento a sus comentarios.

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
                f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": e["to"], "cc": CC_LIST, "subject": e["subject"], "resend_id": rid, "status": status, "type": "followup2"}, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()
