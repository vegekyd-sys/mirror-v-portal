#!/usr/bin/env python3
"""Send 3 exhibition-meeting emails (CAFE CALUPOH / CATERMEX / ANIMO). CC 3 fixed emails."""
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
        "to": "arthur.242@gmail.com",
        "subject": "Re: STELANG — cita en nuestro stand (muestras + condiciones preferentes)",
        "body": """Hola Luis,

Gracias por su disponibilidad. Quería proponerle algo que le resultará más conveniente: en lugar de reunirnos fuera, ¿qué le parece visitar nuestro stand durante China Homelife México (8-10 septiembre, Centro Citibanamex)?

La razón es sencilla: ahí tendremos todas nuestras muestras en exhibición — cafeteras de cápsulas, molinos, espumadores, goteo y espresso — para que pueda verlas, probarlas y compararlas en persona. Y para los clientes que nos visitan en la feria, tenemos condiciones comerciales preferentes y ofertas especiales de lanzamiento.

Entiendo que su agenda de Expo Café es 3-5 de septiembre; si puede extender unos días o regresar para el 8-10, le recibiremos con una reunión ya agendada y toda nuestra atención.

¿Podemos reservarle un horario en el stand? Quedo atento.

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com""",
    },
    {
        "to": "msandoval@catermex.mx",
        "subject": "Re: STELANG — le reservamos un horario en el stand",
        "body": """Hola Mauricio,

Para confirmarle: estaremos en el Centro Citibanamex, stand de STELANG, del 8 al 10 de septiembre.

¿Qué día le vendría mejor visitarnos? Le puedo reservar un horario de atención personalizada, con muestras y condiciones preferentes para clientes de feria.

Quedo atento para confirmarle el número de stand exacto y el horario.

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com""",
    },
    {
        "to": "aniimportaciones@gmail.com",
        "subject": "Re: STELANG — catálogo y cita en feria",
        "body": """Hola Gustavo,

Espero haya podido revisar nuestro catálogo. Si le interesa alguna línea, estaré encantado de prepararle una propuesta con precios.

Además, estaremos en China Homelife México (8-10 septiembre, Centro Citibanamex) con todas las muestras en exhibición y condiciones preferentes para clientes de feria. Sería el momento ideal para ver los productos en persona.

¿Podemos coordinar una cita en el stand?

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
                f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": e["to"], "cc": CC_LIST, "subject": e["subject"], "resend_id": rid, "status": status, "type": "expo-meeting-invite"}, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()
