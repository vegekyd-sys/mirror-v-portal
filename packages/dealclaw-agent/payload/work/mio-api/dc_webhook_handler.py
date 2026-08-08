#!/usr/bin/env python3
"""
DC Webhook Handler — Resend Inbound → IQ引擎 → 自动回复/飞书通知
===============================================================
部署到 webhook 服务器 (114.55.150.21)，监听邮件回复事件。

事件流:
  买家回复 → Resend MX → POST /inbound → 本服务
    → 解析邮件 (from/to/subject/body)
    → 匹配 DealClaw 线索 (by email domain + to_address)
    → IQ 引擎判断 (自动回复 or 人工断点)
    → 通过 Resend API 自动回复
    → 飞书通知 Bot 推送给格格

启动:
  pip install flask
  python3 dc_webhook_handler.py --port 8080
"""

import json, os, re, sys, hashlib, hmac
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from flask import Flask, request, jsonify

app = Flask(__name__)

# ── 配置（从环境变量读取）──────────────────────────────
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
FEISHU_WEBHOOK_URL = os.getenv("FEISHU_WEBHOOK_URL", "")  # 飞书群自定义机器人webhook
# DUMMY_URL and NOTIFY_WEBHOOK replaced by FEISHU_WEBHOOK_URL
SIGNING_SECRET = os.getenv("RESEND_SIGNING_SECRET", "")

# 代理邮箱 → 企业映射
PROXY_MAP = {
    "thia@mail.dealclaw.io": {"enterprise": "meorient.com", "owner": "田耕郡", "open_id": "ou_3fe4922d138f37c5a9fbd6ce7aa89570"},
}

def _now():
    return datetime.now(timezone.utc).isoformat()

# ── Resend Webhook 签名验证 ─────────────────────────────
def verify_signature(payload, signature, timestamp):
    if not SIGNING_SECRET:
        return True  # 开发模式跳过
    signed = hmac.new(
        SIGNING_SECRET.encode(),
        f"{timestamp}.{payload}".encode(),
        hashlib.sha256
    ).digest()
    expected = hmac.new(
        SIGNING_SECRET.encode(),
        f"{timestamp}.{payload}".encode(),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected) if signature else False

# ── Resend API 自动回复 ─────────────────────────────────
def send_auto_reply(to_email, from_address, subject, body_html):
    if not RESEND_API_KEY:
        return {"error": "RESEND_API_KEY not set"}
    email = {
        "from": from_address,
        "to": [to_email],
        "subject": f"Re: {subject}",
        "html": body_html,
    }
    try:
        r = Request(
            "https://api.resend.com/emails",
            data=json.dumps(email).encode(),
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urlopen(r, timeout=15) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        return {"error": e.read().decode()[:200]}

# ── 飞书通知推送 ────────────────────────────────────────
def send_feishu_notify(chat_id, message):
    """通过飞书 Bot webhook 直接推送通知
    环境变量 FEISHU_WEBHOOK_URL 必须在 webhook 服务器上配置
    """
    if not FEISHU_WEBHOOK_URL:
        print(f"[NOTIFY DRY RUN] To {chat_id}: {message[:100]}")
        return {"ok": True, "dry": True}
    try:
        data = json.dumps({
            "msg_type": "interactive",
            "card": {
                "header": {"title": {"content": "📩 DealClaw 邮件通知", "tag": "plain_text"}},
                "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": message}}
                ]
            }
        }).encode()
        r = Request(FEISHU_WEBHOOK_URL, data=data,
                    headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(r, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"[NOTIFY ERROR] {e}")
        return {"ok": False, "error": str(e)}

# ── 邮件内容解析 ─────────────────────────────────────────
def parse_email_content(payload):
    """从 Resend inbound payload 提取邮件内容"""
    data = payload if isinstance(payload, dict) else json.loads(payload)
    email_data = data.get("data", data)
    return {
        "from": email_data.get("from", ""),
        "to": email_data.get("to", [""])[0] if isinstance(email_data.get("to"), list) else email_data.get("to", ""),
        "subject": email_data.get("subject", ""),
        "text": email_data.get("text", ""),
        "html": email_data.get("html", ""),
        "message_id": email_data.get("id", ""),
        "timestamp": email_data.get("created_at", _now()),
    }

# ── 线索匹配 ────────────────────────────────────────────
def match_lead(from_email, to_email):
    """根据买家邮箱 + 代理收件箱 匹配 DealClaw 线索"""
    buyer_domain = from_email.split("@")[1].lower() if "@" in from_email else ""
    buyer_name = from_email.split("@")[0] if "@" in from_email else ""
    proxy = to_email.lower().strip()
    
    proxy_info = PROXY_MAP.get(proxy, {})
    return {
        "buyer_email": from_email,
        "buyer_domain": buyer_domain,
        "buyer_name": buyer_name,
        "proxy_email": proxy,
        "enterprise": proxy_info.get("enterprise", ""),
        "owner": proxy_info.get("owner", ""),
        "owner_open_id": proxy_info.get("open_id", ""),
        "matched": bool(proxy_info),
    }

# ── IQ 简单判断（本地版本，可升级为远程调用）─────────────
def iq_decide(parsed_email, lead_info):
    """判断是否需要自动回复以及回复内容"""
    body = (parsed_email.get("text", "") or "").lower()
    subject = parsed_email.get("subject", "").lower()
    
    # 自动回复关键词
    auto_reply_triggers = [
        ("catalog", "catalogue", "产品目录", "price list", "quotation", "报价",
         "spec", "specification", "规格", "datasheet", "brochure"),
    ]
    
    # 拒收/退订
    unsubscribe = ["unsubscribe", "退订", "stop", "remove"]
    
    for word in unsubscribe:
        if word in body or word in subject:
            return {
                "action": "unsubscribe",
                "reason": f"买家请求退订: {word}",
                "auto_reply": None,
            }
    
    # 需要材料 → 自动回复
    requested = []
    for trigger_group in auto_reply_triggers:
        for t in trigger_group:
            if t in body or t in subject:
                requested.append(trigger_group[0])
                break
    
    if requested:
        return {
            "action": "auto_reply",
            "reason": f"买家索要资料: {', '.join(requested)}",
            "auto_reply": f"<p>Hi,</p><p>Thanks for your interest! Our product catalog and specifications are available here: <a href=\"https://solarunis.com\">Solarunis.com</a></p><p>Feel free to ask any questions.</p><p>Best,<br>Thia</p>",
        }
    
    # 一般询盘 → 通知人工跟进
    return {
        "action": "notify_human",
        "reason": "普通询盘，需人工判断",
        "auto_reply": None,
    }

# ── 核心路由: POST /inbound ─────────────────────────────
@app.route("/inbound", methods=["POST"])
def inbound():
    """Receive Resend webhook events"""
    payload = request.get_data(as_text=True)
    
    # 签名验证
    signature = request.headers.get("Resend-Signature", "")
    timestamp = request.headers.get("Resend-Timestamp", "")
    if not verify_signature(payload, signature, timestamp):
        return jsonify({"error": "invalid signature"}), 403
    
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return jsonify({"error": "invalid JSON"}), 400
    
    event_type = data.get("type", "unknown")
    print(f"[{_now()}] Event: {event_type}")
    
    # 只处理 inbound email 事件
    if event_type not in ("email.received", "inbound", "email.inbound"):
        print(f"  Skipping event type: {event_type}")
        return jsonify({"status": "skipped", "reason": f"event type: {event_type}"}), 200
    
    # 解析邮件
    email = parse_email_content(data)
    print(f"  From: {email['from']}")
    print(f"  To: {email['to']}")
    print(f"  Subject: {email['subject']}")
    
    # 匹配线索
    lead = match_lead(email["from"], email["to"])
    if not lead["matched"]:
        print(f"  ⚠️  No proxy match for {email['to']}")
        return jsonify({"status": "unmatched", "to": email["to"]}), 200
    
    # IQ 决策
    decision = iq_decide(email, lead)
    result = {
        "email": email,
        "lead": lead,
        "decision": decision,
        "timestamp": _now(),
    }
    
    notify_msg = ""
    
    if decision["action"] == "unsubscribe":
        print(f"  🚫 Unsubscribe from {lead['buyer_email']}")
        notify_msg = f"🚫 **退订通知**\n\n{lead['buyer_email']} 请求退订。\n已停止自动发送。"
    
    elif decision["action"] == "auto_reply":
        from_addr = f"Thia <{lead['proxy_email']}>"
        reply_result = send_auto_reply(
            lead["buyer_email"], from_addr,
            email["subject"], decision["auto_reply"]
        )
        print(f"  ✅ Auto-replied: {reply_result.get('id', reply_result.get('error'))}")
        notify_msg = (
            f"🤖 **自动回复已发送**\n\n"
            f"买家: {lead['buyer_email']}\n"
            f"原因: {decision['reason']}\n"
            f"Resend ID: {reply_result.get('id', '?')}"
        )
    
    elif decision["action"] == "notify_human":
        print(f"  📩 Human follow-up needed")
        body_preview = (email.get("text", "") or "")[:200]
        notify_msg = (
            f"📩 **新询盘需人工跟进**\n\n"
            f"买家: {lead['buyer_email']}\n"
            f"企业: {lead['enterprise']}\n"
            f"主题: {email['subject']}\n"
            f"内容: {body_preview}..."
        )
    
    # 飞书通知
    if notify_msg and lead.get("owner_open_id"):
        chat_id = "oc_85133ad5814bc9d17cd53f649acc091b"  # V x 格格群
        send_feishu_notify(chat_id, notify_msg)
    
    print(f"  Result: {json.dumps(result, ensure_ascii=False)[:300]}")
    return jsonify(result), 200

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "timestamp": _now()}), 200

if __name__ == "__main__":
    port = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--port" else 8080
    print(f"[{_now()}] DC Webhook Handler starting on port {port}")
    print(f"  Resend API key: {'set' if RESEND_API_KEY else 'MISSING'}")
    print(f"  IQ Engine URL: {DUMMY_URL}")
    print(f"  Proxy map: {list(PROXY_MAP.keys())}")
    app.run(host="0.0.0.0", port=port, debug=False)
