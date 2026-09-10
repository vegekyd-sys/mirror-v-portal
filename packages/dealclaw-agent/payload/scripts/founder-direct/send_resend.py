#!/usr/bin/env python3
import requests, json, sys

api_key = "re_4BUrVRx7_AKagCo6AeeaVY78UnHQ7Myx1"
headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

emails = [
  {
    "from": "thia@mail.dealclaw.io",
    "to": [
      "nacaotextil@nacaotextil.com.br"
    ],
    "subject": "Cat\u00e1logo de almofadas e t\u00eaxtil para o lar",
    "text": "Oi Samuel,\n\nVi que a Na\u00e7\u00e3o Textil tem uma linha diversificada de cama, mesa, banho e decora\u00e7\u00e3o \u2014 bem alinhada com o que fabricamos.\n\nSomos a TexStead, produzimos almofadas decorativas, travesseiros ergon\u00f4micos, colchonetes para yoga e roupa de cama. Trabalhamos com pronta entrega, OEM e marca pr\u00f3pria. MOQ 50 pe\u00e7as, lead time 30 dias.\n\nJ\u00e1 atendemos sellers na Amazon e Mercado Livre nos EUA e Brasil.\n\nPosso te enviar nosso cat\u00e1logo 2026?"
  },
  {
    "from": "thia@mail.dealclaw.io",
    "to": [
      "zaabecomercio@gmail.com"
    ],
    "subject": "Fornecedor de t\u00eaxtil para e-commerce",
    "text": "Oi Lilian,\n\nAcompanhei a ZAABE no mercado de home decor online. Nosso portf\u00f3lio de almofadas, capas de cabeceira, tapetes e roupa de cama pode complementar bem sua linha atual.\n\nFabricamos com pronta entrega e oferecemos OEM/Private Label. MOQ de 50 pe\u00e7as, lead time 30 dias. Nossos clientes vendem na Amazon e Mercado Livre.\n\nGostaria de ver nosso cat\u00e1logo?"
  }
]

for email in emails:
    resp = requests.post("https://api.resend.com/emails", headers=headers, json=email)
    result = resp.json()
    rid = result.get("id", "?")
    status = "OK" if resp.status_code == 200 else f"FAIL {resp.status_code}"
    print(f"{status} | {email['to'][0]} | {rid}")
    # Also log to sent-log
    with open("/home/openclaw/makaron-openclaw/.openclaw-local/workspace/scripts/founder-direct/sent-log.jsonl", "a") as f:
        f.write(json.dumps({"ts": __import__('datetime').datetime.now().isoformat(), "from": email["from"], "to": email["to"][0], "subject": email["subject"], "resend_id": rid, "status": status}) + "\n")
