#!/usr/bin/env python3
"""STELANG 买家回复监控 — 检测新回复，飞书群通知 + 邮件 CC 通知马经理。

用法：cron 每 30 分钟跑一次。发现新回复（来自雪特朗已发买家的邮件），
     用 lark-cli 发群消息通知，并调用 Resend 发一封通知邮件给 maxiaodong@meorient.com。
"""
import os, json, datetime, subprocess, requests

WORKSPACE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw"
ENV = os.path.join(WORKSPACE, "work/mio-api/.env")
STATE = os.path.join(WORKSPACE, "scripts/resend/stelang-reply-monitor-state.json")

# 本群 chat_id（雪特朗操作群）
GROUP_CHAT_ID = "oc_5b727046f9100dcc9cd4613d2c76d2a1"
# 通知邮件收件人
NOTIFY_EMAIL = "maxiaodong@meorient.com"

# 雪特朗已发 20+ 家买家的精确邮箱（用于判定"是否雪特朗的回复"）
TARGET_EMAILS = {
    "contacto@disamexico.com.mx", "ventas2@multimarcasdelbajio.com",
    "contacto@xaze.com.mx", "atencionalcliente@todopormayoreo.mx",
    "ventas@cafeboato.com", "ventas@babani.com.mx", "ventas@epcmexico.com",
    "ventas@cafeterasmexico.mx",
    "arthur.242@gmail.com", "cafeteraseuropeas2@gmail.com",
    "aniimportaciones@gmail.com", "msandoval@catermex.mx",
    "escobarrmz@hotmail.com", "campa40@hotmail.com", "chit.fernando@hotmail.com",
    "mdh@mercantildelhogar.mx", "93gomezuri@gmail.com",
    "abril@sgmmercadotecnia.com", "cruzbrindiscandelariaantonia@gmail.com",
    "armamv@msn.com",
}

def load_key():
    for line in open(ENV):
        line = line.strip()
        if line.startswith("RESEND_API_KEY="):
            return line.split("=", 1)[1]
    return ""

def load_state():
    if os.path.exists(STATE):
        return json.load(open(STATE))
    return {"known_ids": []}

def save_state(s):
    json.dump(s, open(STATE, "w"), ensure_ascii=False, indent=2)

def is_auto_reply(subject):
    s = (subject or "").lower()
    return any(k in s for k in ["automatic reply","auto reply","resposta automática","out of office","undelivered","delivery status","failure","mail delivery"])

def is_target_reply(from_addr, subject="", body=""):
    """判定是否雪特朗相关回复：发件邮箱白名单，或主题/正文含 STELANG/咖啡机关键词。
    解决买家用其他域名邮箱回复（如 dalto.coffee）时白名单匹配不到导致漏通知的问题。"""
    addr = (from_addr or "").strip().lower()
    if addr in TARGET_EMAILS:
        return True
    text = (subject + " " + body).lower()
    return any(k in text for k in ["stelang", "cafetera", "coffee machine", "homelife m\u00e9xico", "m\u00e1quina", "espumador", "molino", "capsul"])

def send_feishu_group(message):
    """发飞书群消息。"""
    try:
        subprocess.run([
            "lark-cli", "im", "+messages-send",
            "--as", "bot",
            "--chat-id", GROUP_CHAT_ID,
            "--text", message,
        ], cwd=WORKSPACE, capture_output=True, timeout=30)
    except Exception as e:
        print("feishu send error:", e)

def send_notify_email(subject, body):
    """发通知邮件给马经理。"""
    api_key = load_key()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "from": "thia@mail.dealclaw.io",
        "to": [NOTIFY_EMAIL],
        "subject": subject,
        "text": body,
    }
    try:
        requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
    except Exception as e:
        print("notify email error:", e)

def main():
    api_key = load_key()
    headers = {"Authorization": f"Bearer {api_key}"}
    r = requests.get("https://api.resend.com/emails/receiving?limit=50", headers=headers, timeout=30)
    data = (r.json() or {}).get("data") or []
    state = load_state()
    known = set(state["known_ids"])

    new_replies = []
    for m in data:
        mid = m.get("id")
        if mid in known:
            continue
        known.add(mid)
        subject = m.get("subject") or ""
        from_raw = m.get("from")
        from_addr = from_raw if isinstance(from_raw, str) else (from_raw[0] if isinstance(from_raw, list) and from_raw else "")
        if is_auto_reply(subject):
            if not is_target_reply(from_addr, subject, ""):
                continue
        if not is_target_reply(from_addr):
            continue
        # 拉正文
        body = ""
        try:
            full = requests.get(f"https://api.resend.com/emails/receiving/{mid}", headers=headers, timeout=20).json()
            body = (full.get("text") or "").strip()
        except Exception:
            pass
        # 正文拉到后，用主题+正文再判一次（覆盖仅靠发件邮箱判不准的情况）
        if not is_target_reply(from_addr, subject, body):
            continue
        # 去掉引用的原文
        clean = body.split("\n>")[0].strip() if body else ""
        new_replies.append({"from": from_addr, "subject": subject, "body": clean[:400], "created": m.get("created_at")})

    state["known_ids"] = sorted(known)
    save_state(state)

    if not new_replies:
        print("NO_NEW_REPLY")
        return

    for rp in new_replies:
        msg = ("📬 买家回复提醒\n"
               f"发件人：{rp['from']}\n"
               f"主题：{rp['subject']}\n"
               f"正文：\n{rp['body']}")
        send_feishu_group(msg)
        send_notify_email(
            f"[买家回复] {rp['from']} - {rp['subject'][:40]}",
            f"发件人：{rp['from']}\n主题：{rp['subject']}\n\n{rp['body']}\n\n（来自 DealClaw 雪特朗买家回信监控）"
        )
        print(f"NOTIFIED: {rp['from']} | {rp['subject'][:40]}")

if __name__ == "__main__":
    main()
