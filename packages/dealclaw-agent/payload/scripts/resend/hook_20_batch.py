#!/usr/bin/env python3
"""20 STELANG non-replied buyers — pre-show sprint with 10% first-order hook."""
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
SUBJECT = "STELANG — 10% de descuento en su primer pedido (China Homelife, 8-10 sep)"
BOOTH = "Centro Citibanamex, Stand HALL D-B220"

def body(company):
    return f"""Hola, equipo de {company},

Nos presentamos nuevamente: somos STELANG, fabricante chino de cafeteras (cápsulas, molinos, espumadores, goteo y espresso, 10-50 USD FOB).

Estaremos en China Homelife México del 8 al 10 de septiembre ({BOOTH}). Para los clientes que nos visitan y confirman un primer pedido en el stand, ofrecemos un **10% de descuento exclusivo**.

Sería un gusto recibirle para que vea todas las muestras en persona. ¿Le gustaría reservar un horario?

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
    ("IRMSEN", "abdala020588@icloud.com"),
    ("GRUPO B HOGAR MEXICO", "facturacionbhogar@gmail.com"),
    ("DISTPAC", "ccosmev@gmail.com"),
]

def main():
    api_key = load_key()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    log = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")
    ok = 0; fail = 0
    for company, to in recipients:
        # 首封冷触达/冲刺：CC 三邮箱（按 CC 规则 v2，这是已发过邀约的后续冲刺，CC 合理）
        payload = {"from": FROM, "to": [to], "cc": ["waimao@stelang.com","maxiaodong@meorient.com","lucky@stelang.com"], "subject": SUBJECT, "text": body(company)}
        try:
            r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
            res = r.json()
            if r.status_code == 200:
                ok += 1
                print(f"OK | {to}")
                with open(log, "a") as f:
                    f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": to, "cc": ["waimao@stelang.com","maxiaodong@meorient.com","lucky@stelang.com"], "subject": SUBJECT, "resend_id": res.get("id","?"), "status": "OK", "type": "pre-show-hook"}, ensure_ascii=False) + "\n")
            else:
                fail += 1
                print(f"FAIL {r.status_code} | {to} | {json.dumps(res,ensure_ascii=False)[:120]}")
        except Exception as e:
            fail += 1
            print(f"ERROR | {to} | {e}")
    print(f"\n=== 完成: 成功 {ok} / 失败 {fail} ===")

if __name__ == "__main__":
    main()
