#!/usr/bin/env python3
"""
DC-Notify — DealClaw 飞书通知 Bot 路由引擎

将引擎输出(早报/IQ断点/买家提醒/进化建议)路由到正确的飞书频道。

路由规则:
  - 企业级通知 → 企业群聊/用户私聊
  - 个人级通知 → 用户私聊

用法:
  python3 dc_notify.py send morning_report solarunis.com              # 终端预览
  python3 dc_notify.py send morning_report solarunis.com --live        # 实际发送
  python3 dc_notify.py routes                                          # 查看路由表
  python3 dc_notify.py map solarunis.com ou_xxx oc_xxx                 # 添加路由
"""

import json, os, sys
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
ROUTES_FILE = DATA_DIR / "notify_routes.json"

NOTIFY_TYPES = {
    "morning_report":    {"label": "🌅 每日早报",   "priority": "normal"},
    "buyer_alert":       {"label": "🔔 买家提醒",   "priority": "high"},
    "iq_breakpoint":     {"label": "🤖 IQ断点",     "priority": "high"},
    "kb_update":         {"label": "📂 KB更新",     "priority": "low"},
    "evolution_suggest": {"label": "🧠 进化建议",   "priority": "low"},
    "followup_reminder": {"label": "⏰ 跟进提醒",   "priority": "normal"},
    "send_report":       {"label": "✉️ 发送报告",   "priority": "normal"},
    "system_alert":      {"label": "⚠️ 系统告警",   "priority": "urgent"},
    "agent_paywall":     {"label": "💰 付费阻隔",   "priority": "high"},
}


def _now():
    return datetime.now(timezone.utc).isoformat()


class NotifyRouter:
    """通知路由引擎"""

    def __init__(self):
        os.makedirs(str(DATA_DIR), exist_ok=True)
        self._routes = self._load()

    def _load(self) -> dict:
        if ROUTES_FILE.exists():
            return json.loads(ROUTES_FILE.read_text())
        return {"users": {}, "enterprises": {}, "channels": {}, "updated_at": ""}

    def _save(self):
        self._routes["updated_at"] = _now()
        ROUTES_FILE.write_text(json.dumps(self._routes, ensure_ascii=False, indent=2))

    # ── 路由管理 ──

    def map_user(self, user_open_id: str, chat_id: str, label: str = ""):
        """绑定用户 open_id → 飞书群聊/私聊 chat_id"""
        self._routes["users"][user_open_id] = {
            "chat_id": chat_id,
            "label": label,
            "mapped_at": _now(),
            "prefs": {
                "morning_report": True,
                "buyer_alert": True,
                "iq_breakpoint": True,
                "kb_update": False,
                "evolution_suggest": False,
                "followup_reminder": True,
                "send_report": True,
                "system_alert": True,
            }
        }
        self._routes["channels"][chat_id] = {
            "type": "feishu_group",
            "users": list(set(self._routes["channels"].get(chat_id, {}).get("users", []) + [user_open_id])),
        }
        self._save()
        return self._routes["users"][user_open_id]

    def map_enterprise(self, enterprise: str, chat_id: str, label: str = ""):
        """绑定企业 → 飞书群聊"""
        self._routes["enterprises"][enterprise] = {
            "chat_id": chat_id,
            "label": label,
            "mapped_at": _now(),
        }
        self._routes["channels"][chat_id] = {
            "type": "feishu_group",
            "enterprises": list(set(
                self._routes["channels"].get(chat_id, {}).get("enterprises", []) + [enterprise]
            )),
        }
        self._save()
        return self._routes["enterprises"][enterprise]

    def list_routes(self) -> list:
        """列出所有路由"""
        result = []
        for uid, info in self._routes.get("users", {}).items():
            result.append({
                "type": "user",
                "id": uid,
                "chat_id": info["chat_id"],
                "label": info.get("label", ""),
                "prefs": info.get("prefs", {}),
            })
        for ent, info in self._routes.get("enterprises", {}).items():
            result.append({
                "type": "enterprise",
                "id": ent,
                "chat_id": info["chat_id"],
                "label": info.get("label", ""),
            })
        return result

    # ── 通知生成 ──

    def build_notification(self, notify_type: str, enterprise: str,
                           user_open_id: str = "", payload: dict = None) -> dict:
        """构建通知 payload，供 OpenClaw message.send 使用"""
        if notify_type not in NOTIFY_TYPES:
            return {"error": f"unknown notify_type: {notify_type}"}

        meta = NOTIFY_TYPES[notify_type]
        payload = payload or {}

        base = {
            "notify_type": notify_type,
            "label": meta["label"],
            "priority": meta["priority"],
            "enterprise": enterprise,
            "user_open_id": user_open_id,
            "timestamp": _now(),
        }

        if notify_type == "morning_report":
            from dc_morning_report import funnel
            funnel_data = funnel(enterprise, user_open_id)
            base["content"] = self._format_morning_report(enterprise, funnel_data, payload)
        elif notify_type == "iq_breakpoint":
            base["content"] = self._format_iq_breakpoint(payload)
        elif notify_type == "buyer_alert":
            base["content"] = self._format_buyer_alert(payload)
        elif notify_type == "followup_reminder":
            base["content"] = self._format_followup(payload)
        elif notify_type == "evolution_suggest":
            base["content"] = self._format_evolution(payload)
        elif notify_type == "kb_update":
            base["content"] = self._format_kb_update(payload)
        elif notify_type == "send_report":
            base["content"] = self._format_send_report(payload)
        elif notify_type == "agent_paywall":
            base["content"] = self._format_agent_paywall(payload)
        else:
            base["content"] = payload.get("message", "")

        return base

    # ── 格式化 ──

    def _format_morning_report(self, enterprise, funnel_data, payload):
        stages = funnel_data.get("stages", [])
        lines = [f"🌅 **DealClaw 今日早报 — {enterprise}**", ""]
        for s in stages:
            lines.append(f"• {s['name']}: **{s['count']}** ({s['pct']})")
        if payload.get("summary"):
            lines.append("")
            lines.append(payload["summary"])
        return "\n".join(lines)

    def _format_iq_breakpoint(self, payload):
        buyer = payload.get("buyer", "未知买家")
        reason = payload.get("reason", "需要人工介入")
        return (
            f"🤖 **IQ 断点通知**\n\n"
            f"买家 **{buyer}** 的自动回复已暂停。\n"
            f"原因: {reason}\n\n"
            f"请尽快介入处理 → {payload.get('action_hint', '查看对话')}"
        )

    def _format_buyer_alert(self, payload):
        buyer = payload.get("buyer", "")
        score = payload.get("score", "")
        return (
            f"🔔 **高意向买家提醒**\n\n"
            f"**{buyer}** 匹配度 {score}\n"
            f"{payload.get('reason', '')}\n\n"
            f"建议: {payload.get('suggestion', '优先触达')}"
        )

    def _format_followup(self, payload):
        buyer = payload.get("buyer", "")
        days = payload.get("days", 7)
        return (
            f"⏰ **跟进提醒**\n\n"
            f"**{buyer}** 已 {days} 天未跟进。\n"
            f"{payload.get('hint', '建议发送跟进邮件')}"
        )

    def _format_evolution(self, payload):
        return (
            f"🧠 **进化建议**\n\n"
            f"{payload.get('insight', '')}\n\n"
            f"建议操作: {payload.get('action', '')}"
        )

    def _format_kb_update(self, payload):
        return (
            f"📂 **知识库更新**\n\n"
            f"{payload.get('enterprise', '')} 的知识库已更新。\n"
            f"变更: {payload.get('change', '')}"
        )

    def _format_send_report(self, payload):
        return (
            f"✉️ **发送报告**\n\n"
            f"今日发送: {payload.get('sent', 0)} 封\n"
            f"已打开: {payload.get('opened', 0)} 封\n"
            f"已回复: {payload.get('replied', 0)} 封"
        )

    def _format_agent_paywall(self, payload):
        agent_name = payload.get("agent_name", "子Agent")
        description = payload.get("description", "")
        return (
            f"🔒 **{agent_name}** 是付费功能，暂未开通。\n\n"
            f"{description}\n\n"
            f"如需开通，请联系 @田耕郡"
        )

    # ── 路由解析 ──

    def resolve_target(self, enterprise: str, user_open_id: str = "") -> dict:
        """解析通知目标 chat_id。优先级: 用户私聊 > 企业群聊 > 默认群"""
        # 1. 查用户绑定
        user_info = self._routes.get("users", {}).get(user_open_id, {})
        if user_info.get("chat_id"):
            return {
                "chat_id": user_info["chat_id"],
                "type": "user_direct",
                "prefs": user_info.get("prefs", {}),
            }

        # 2. 查企业绑定
        ent_info = self._routes.get("enterprises", {}).get(enterprise, {})
        if ent_info.get("chat_id"):
            return {
                "chat_id": ent_info["chat_id"],
                "type": "enterprise_group",
                "prefs": {},
            }

        # 3. 返回默认（当前群聊）
        return {"chat_id": "", "type": "default", "prefs": {}}

    def should_send(self, user_open_id: str, notify_type: str) -> bool:
        """检查用户是否订阅了此类通知"""
        user_info = self._routes.get("users", {}).get(user_open_id, {})
        prefs = user_info.get("prefs", {})
        return prefs.get(notify_type, True)

    # ── 发送接口 (供 OpenClaw 调用) ──

    def prepare_send(self, notify_type: str, enterprise: str,
                     user_open_id: str = "", payload: dict = None) -> dict:
        """准备发送: 构建通知 + 解析目标。返回给 OpenClaw message.send 使用。"""
        if not self.should_send(user_open_id, notify_type):
            return {"skipped": True, "reason": "user_unsubscribed"}

        notification = self.build_notification(notify_type, enterprise, user_open_id, payload)
        target = self.resolve_target(enterprise, user_open_id)

        return {
            "skipped": False,
            "notification": notification,
            "target": target,
            "action": {
                "tool": "message.send",
                "target": target["chat_id"],
                "message": notification.get("content", ""),
            }
        }


# ═══════════════════════════════════════════════════════════
#  CLI
# ═══════════════════════════════════════════════════════════

def main():
    if len(sys.argv) < 2:
        print("dc_notify.py routes | send <type> <enterprise> [user_open_id] [--live] | map <enterprise/user> <id> <chat_id> [label]")
        sys.exit(1)

    router = NotifyRouter()
    cmd = sys.argv[1]

    if cmd == "routes":
        print(json.dumps(router.list_routes(), ensure_ascii=False, indent=2))

    elif cmd == "send":
        if len(sys.argv) < 4:
            print("用法: send <type> <enterprise> [user_open_id] [--live]")
            sys.exit(1)
        ntype = sys.argv[2]
        enterprise = sys.argv[3]
        uid = sys.argv[4] if len(sys.argv) > 4 and not sys.argv[4].startswith("--") else ""

        live = "--live" in sys.argv
        result = router.prepare_send(ntype, enterprise, uid)

        if result.get("skipped"):
            print(f"SKIPPED: {result['reason']}")
        else:
            print(json.dumps(result["notification"], ensure_ascii=False, indent=2))
            if live:
                print(f"\n>>> WOULD SEND to: {result['target']}")
            else:
                print(f"\n[DRY RUN] add --live to actually send")

    elif cmd == "map":
        if len(sys.argv) < 5:
            print("用法: map user <open_id> <chat_id> [label]  |  map enterprise <domain> <chat_id> [label]")
            sys.exit(1)
        mtype = sys.argv[2]
        eid = sys.argv[3]
        chat_id = sys.argv[4]
        label = sys.argv[5] if len(sys.argv) > 5 else ""

        if mtype == "user":
            router.map_user(eid, chat_id, label)
            print(f"OK: user {eid} → {chat_id}")
        elif mtype == "enterprise":
            router.map_enterprise(eid, chat_id, label)
            print(f"OK: enterprise {eid} → {chat_id}")
        else:
            print(f"Unknown map type: {mtype} (use 'user' or 'enterprise')")

    else:
        print(f"Unknown command: {cmd}")


if __name__ == "__main__":
    main()
