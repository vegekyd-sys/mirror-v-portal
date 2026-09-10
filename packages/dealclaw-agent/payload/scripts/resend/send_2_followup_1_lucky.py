#!/usr/bin/env python3
"""Send CAFE CALUPOH + ANIMO follow-up (coffee pref + sample + KP contact), + internal sync to Lucky."""
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

SIG = "\n\nSaludos cordiales,\nMaxd\nSTELANG · Foshan Shunde Stelong Electrical Appliance\nWhatsApp: +86 13728045799\nWeb: gb.stelang.com"

emails = [
    {
        "to": "arthur.242@gmail.com",
        "cc": CC_LIST,
        "subject": "Re: STELANG — preparación de su visita en la feria",
        "body": """Hola Luis,

Para prepararle mejor su posible visita a nuestro stand (China Homelife México, 8-10 septiembre, Centro Citibanamex, Stand HALL D-B220):

¿Qué tipo de café le interesa más? Podemos tener listas muestras de cafeteras de cápsulas (Nespresso / K-Cup / Dolce Gusto), molinos, espumadores de leche, goteo o espresso semiautomático.

¿Podría compartirnos su número de móvil o WhatsApp y el contacto directo de compras, para coordinar mejor su visita?

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com""",
    },
    {
        "to": "aniimportaciones@gmail.com",
        "cc": CC_LIST,
        "subject": "Re: STELANG — preparación de su visita (catálogo + muestras)",
        "body": """Hola Gustavo,

Para prepararle mejor su visita a China Homelife México (8-10 septiembre, Centro Citibanamex, Stand HALL D-B220):

¿Qué tipo de café le interesa más? Podemos preparar muestras de cafeteras de cápsulas, molinos, espumadores de leche, goteo o espresso.

¿Podría compartirnos su número de móvil o WhatsApp y el contacto directo de compras, para coordinar mejor?

Saludos cordiales,
Maxd
STELANG · Foshan Shunde Stelong Electrical Appliance
WhatsApp: +86 13728045799
Web: gb.stelang.com""",
    },
    {
        "to": "lucky@stelang.com",
        "cc": ["waimao@stelang.com", "maxiaodong@meorient.com"],
        "subject": "雪特朗墨西哥展 · 买家到场预约同步",
        "body": """Lucky，你好，

同步雪特朗墨西哥展（9/8-10，Centro Citibanamex，HALL D-B220）的买家到场预约进展：

1. CATERMEX（Mauricio）：已确定 9/9 到访展位（现场请安排专人接待）
2. CAFÉ CALUPOH（Luis）：8/30 同意面谈，已发展位约见，待确认具体日期
3. ANIMO（Gustavo）：已发展位约见，待确认

现场联系人已使用你的信息（Lucky Lee，+86 13418256321），客户如有需要会联系到你。

（此邮件为内部同步，不发给客户。）
""",
    },
]

def main():
    api_key = load_key()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    log = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")
    for e in emails:
        payload = {"from": FROM, "to": [e["to"]], "cc": e.get("cc", []), "subject": e["subject"], "text": e["body"]}
        r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
        res = r.json()
        rid = res.get("id", "?")
        status = "OK" if r.status_code == 200 else f"FAIL {r.status_code}"
        print(f"{status} | {e['to']} | {rid} | {r.status_code}")
        if r.status_code != 200:
            print(json.dumps(res, ensure_ascii=False)[:300])

if __name__ == "__main__":
    main()
