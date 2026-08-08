#!/usr/bin/env python3
"""DC-WA WhatsApp引擎 — YCloud发送+Webhook接收,接入IQ/SendLog/Dashboard"""

import json, os, sys, hashlib, hmac, re
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, str(Path(__file__).parents[2] / "scripts" / "ycloud"))

from client import api_request as ycloud_api

YCLOUD_FROM = os.environ.get("YCLOUD_FROM", "+8615895553765")


def _now():
    return datetime.now(timezone.utc).isoformat()


class WAEngine:
    """WhatsApp 引擎 — 发送+接收+接入 DealClaw"""

    def __init__(self):
        self._iq = None
        self._slog = None
        self._audit = None

    @property
    def iq(self):
        if self._iq is None:
            from dc_iq_engine import IQEngine
            self._iq = IQEngine()
        return self._iq

    @property
    def slog(self):
        if self._slog is None:
            from dc_send_log import SendLog
            self._slog = SendLog()
        return self._slog

    @property
    def audit(self):
        if self._audit is None:
            from dc_audit import AuditLog
            self._audit = AuditLog()
        return self._audit

    # ── 发送 ──

    def send_text(self, to_number, text, buyer_domain="", buyer_name="",
                  user_open_id="", enterprise=""):
        """发送 WhatsApp 文本消息"""
        to_clean = re.sub(r"\D", "", to_number)
        if not to_clean.startswith("+"):
            to_clean = "+" + to_clean

        try:
            resp = ycloud_api("POST", "/whatsapp/messages", data={
                "from": YCLOUD_FROM,
                "to": to_clean,
                "type": "text",
                "text": {"body": text[:4096]},
            })
            msg_id = resp.get("id", "")
        except Exception as e:
            return {"ok": False, "error": str(e), "to": to_clean}

        # Log to SendLog
        if buyer_domain:
            self.slog._append({
                "type": "sent",
                "buyer_domain": buyer_domain,
                "buyer_name": buyer_name,
                "channel": "WA",
                "round": 1,
                "user_open_id": user_open_id,
                "enterprise": enterprise,
                "subject": text[:200],
                "resend_id": msg_id,
                "status": "sent",
            })
            # 审计
            try:
                self.audit.log("send.wa", user_open_id=user_open_id, enterprise=enterprise,
                              target=to_clean, detail=f"WA: {text[:60]}")
            except Exception:
                pass

        return {"ok": True, "id": msg_id, "to": to_clean}

    def send_template(self, to_number, template_name, lang="en", vars_list=None,
                      buyer_domain="", buyer_name="", user_open_id="", enterprise=""):
        """发送 WhatsApp 模板消息"""
        to_clean = re.sub(r"\D", "", to_number)
        if not to_clean.startswith("+"):
            to_clean = "+" + to_clean

        body = {"namespace": ""}  # YCloud auto-detects
        if vars_list:
            body["components"] = [{
                "type": "body",
                "parameters": [{"type": "text", "text": v} for v in vars_list]
            }]

        try:
            payload = {
                "from": YCLOUD_FROM,
                "to": to_clean,
                "type": "template",
                "template": {"name": template_name, "language": {"code": lang}},
            }
            if vars_list:
                payload["template"]["components"] = body.get("components", [])
            resp = ycloud_api("POST", "/whatsapp/messages", data=payload)
            msg_id = resp.get("id", "") or resp.get("wamid", "")
        except Exception as e:
            return {"ok": False, "error": str(e), "to": to_clean}

        if buyer_domain:
            self.slog._append({
                "type": "sent",
                "buyer_domain": buyer_domain,
                "buyer_name": buyer_name,
                "channel": "WA",
                "round": 1,
                "user_open_id": user_open_id,
                "enterprise": enterprise,
                "subject": f"[template] {template_name}",
                "resend_id": msg_id,
                "status": "sent",
            })

        return {"ok": True, "id": msg_id, "to": to_clean}

    # ── 接收 (Webhook 处理) ──

    def process_webhook(self, payload, enterprise="", user_open_id=""):
        """处理 YCloud webhook 回调 → IQ 引擎 + Persona自适应"""

        # Try to parse YCloud webhook format
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except:
                return {"ok": False, "error": "invalid JSON"}

        # YCloud webhook: messages array
        messages = payload.get("messages", []) or [payload]
        results = []

        for msg in messages:
            msg_type = msg.get("type", "")
            if msg_type != "text" and msg_type not in ("message", "text", ""):
                # Try nested structure
                if isinstance(msg.get("text"), dict):
                    msg_type = "text"

            # Extract sender and text
            from_number = msg.get("from", "") or msg.get("wa_id", "")
            text = ""
            if isinstance(msg.get("text"), str):
                text = msg["text"]
            elif isinstance(msg.get("text"), dict):
                text = msg["text"].get("body", "")

            if not from_number or not text:
                continue

            # Route to IQ engine
            try:
                # Use phone as domain placeholder
                iq_result = self.iq.process(
                    buyer_domain=from_number,
                    reply_text=text,
                    channel="WA",
                )
                # Log reply
                self.slog._append({
                    "type": "reply",
                    "buyer_domain": from_number,
                    "buyer_name": "",
                    "channel": "WA",
                    "reply_text": text[:500],
                    "iq_intent": iq_result.get("intent", ""),
                    "iq_stage": iq_result.get("new_stage", 0),
                    "status": "replied",
                })
                results.append({"phone": from_number, "iq": {
                    "intent": iq_result["intent"],
                    "action": iq_result["action"],
                    "auto_reply": (iq_result.get("auto_reply") or "")[:100],
                }})

                # Auto-reply if IQ says so
                if iq_result.get("auto_reply") and iq_result["action"] == "auto":
                    self.send_text(from_number, iq_result["auto_reply"],
                                   buyer_domain=from_number)

            except Exception as e:
                results.append({"phone": from_number, "error": str(e)})

        return {"ok": True, "processed": len(results), "results": results}

    # ── 查询 ──

    def get_phone_numbers(self):
        """获取已注册的 WA 号码列表"""
        try:
            return ycloud_api("GET", "/whatsapp/phoneNumbers")
        except Exception as e:
            return {"error": str(e)}

    def get_templates(self):
        """获取已审批的模板列表"""
        try:
            return ycloud_api("GET", "/whatsapp/templates")
        except Exception as e:
            return {"error": str(e)}


if __name__ == "__main__":
    wa = WAEngine()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"

    if cmd == "status":
        nums = wa.get_phone_numbers()
        items = nums.get("items", [])
        for n in items:
            print(f"📱 {n['phoneNumber']} | {n['verifiedName']} | {n['status']} | {n['messagingLimit']}")

    elif cmd == "templates":
        tmpl = wa.get_templates()
        for t in tmpl.get("items", []):
            print(f"📋 {t.get('name')} | {t.get('language')} | {t.get('status')}")

    elif cmd == "send":
        to_num = sys.argv[2] if len(sys.argv) > 2 else ""
        text = sys.argv[3] if len(sys.argv) > 3 else "Hello from DealClaw"
        r = wa.send_text(to_num, text, buyer_domain=to_num)
        print(json.dumps(r, ensure_ascii=False, indent=2))

    elif cmd == "webhook":
        payload = sys.argv[2] if len(sys.argv) > 2 else '{}'
        r = wa.process_webhook(payload)
        print(json.dumps(r, ensure_ascii=False, indent=2))

    else:
        print("dc_wa.py status|templates|send <to> <text>|webhook <json>")
