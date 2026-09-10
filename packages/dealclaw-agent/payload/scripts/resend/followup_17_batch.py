#!/usr/bin/env python3
"""Batch follow-up to 17 non-replied STELANG buyers. CC 3 fixed emails."""
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
SUBJECT = "Recordatorio — STELANG cafeteras en China Homelife México (8-10 sep)"

def body(company):
    return f"""Hola, equipo de {company},

Solo un breve recordatorio: estaremos presentando nuestras cafeteras STELANG en China Homelife México, del 8 al 10 de septiembre en el World Trade Center de Ciudad de México.

Si les interesa nuestra línea (cafeteras de cápsulas, molinos, espumadores de leche, goteo y espresso — 10-50 USD FOB, OEM/ODM), sería un gusto coordinar una cita durante la feria o enviarles nuestro catálogo.

Saludos cordiales,
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
    ("CAFETERAS Y REFACCIONES DE EUROPA", "cafeteraseuropeas2@gmail.com"),
    ("KAEGA COMERCIAL", "escobarrmz@hotmail.com"),
    ("CEM GLOBAL", "campa40@hotmail.com"),
    ("DISTRIBUIDORA DEL HOGAR", "chit.fernando@hotmail.com"),
    ("MERCANTIL DEL HOGAR", "mdh@mercantildelhogar.mx"),
    ("VEANA", "93gomezuri@gmail.com"),
    ("ESO QUIERO", "abril@sgmmercadotecnia.com"),
    ("ELREYDELPRECIO", "cruzbrindiscandelariaantonia@gmail.com"),
    ("TECHNOLOGICAL STORE MEXICO", "armamv@msn.com"),
]

def main():
    api_key = load_key()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    log = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")
    ok = 0; fail = 0
    for company, to in recipients:
        payload = {"from": FROM, "to": [to], "cc": CC_LIST, "subject": SUBJECT, "text": body(company)}
        try:
            r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
            res = r.json()
            rid = res.get("id", "?")
            if r.status_code == 200:
                ok += 1
                print(f"OK | {to}")
                with open(log, "a") as f:
                    f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": to, "cc": CC_LIST, "subject": SUBJECT, "resend_id": rid, "status": "OK", "type": "followup-batch"}, ensure_ascii=False) + "\n")
            else:
                fail += 1
                print(f"FAIL {r.status_code} | {to} | {json.dumps(res,ensure_ascii=False)[:150]}")
        except Exception as e:
            fail += 1
            print(f"ERROR | {to} | {e}")
    print(f"\n=== 完成: 成功 {ok} / 失败 {fail} ===")

if __name__ == "__main__":
    main()
