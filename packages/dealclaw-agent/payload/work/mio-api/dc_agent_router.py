#!/usr/bin/env python3
"""
DC-Agent-Router — DealClaw Agent 路由器 + 付费阻隔

Agent 架构:
  主 Agent (免费): 企业KB / 线索初筛 / 邮件域名 / WABA / 自动营销 / 意图识别跟进
  小展 (付费):   展会展前邀约 + 展后OCR/ASR扫描上传匹配营销
  小创 (付费):   星擎线索接入 → 线索跟进和回复
  小拓 (付费):   AI猎采线索接入 → 线索跟进和回复

用法:
  python3 dc_agent_router.py check 小展 ou_xxx solarunis.com   # 检查用户是否有子Agent权限
  python3 dc_agent_router.py route "我要做展会邀约" ou_xxx     # 路由意图到Agent
  python3 dc_agent_router.py agents                            # 列出所有Agent
"""

import json, os, sys
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
SUBSCRIPTIONS_FILE = DATA_DIR / "agent_subscriptions.json"

def _now():
    return datetime.now(timezone.utc).isoformat()


# ── Agent 定义 ──────────────────────────────────────────────────
AGENTS = {
    "xiaoyuan": {
        "name": "小元",
        "key": "xiaoyuan",
        "tier": "free",
        "brand": "元海·出海精英 | Meo Gennie",
        "role": "企业AI决策大脑 / 老板",
        "description": "洞察全局 · 决策中枢 · 资源调度 · 战略驱动",
        "skills": ["企业分析", "DC-MI", "DC-PRC", "DC-KB", "DC-LS", "DC-OS", "DC-Copy", "DC-GS", "DC-FD", "DC-IQ", "DC-WA"],
        "sub_agents": ["xiaozhan", "xiaochuang", "xiaotuo"],
        "triggers": [
            "分析企业", "建立知识库", "找买家", "写开发信", "发邮件", "配置域名",
            "绑定WhatsApp", "自动跟进", "意图识别", "发早报", "查看知识库"
        ],
    },
    "xiaozhan": {
        "name": "小展精灵",
        "key": "xiaozhan",
        "tier": "paid",
        "parent": "xiaoyuan",
        "category": "展会营销",
        "description": "展会策划与执行 · 品牌曝光与获客 · 数据分析与复盘",
        "skills": ["DC-EL", "OCR", "ASR", "DC-Copy", "DC-GS"],
        "triggers": [
            "展会邀约", "展前邀约", "展后跟进", "扫描名片", "展会名片",
            "OCR识别", "录音转文字", "ASR", "展会营销", "展前邮件",
            "展前", "展后", "名片扫描", "录音", "展会"
        ],
    },
    "xiaochuang": {
        "name": "小创精灵",
        "key": "xiaochuang",
        "tier": "paid",
        "parent": "xiaoyuan",
        "category": "内容营销",
        "description": "星擎视频营销 · GEO营销 · TK电商营销",
        "source": "星擎",
        "skills": ["DC-Copy", "DC-GS", "DC-IQ", "DC-WA", "星擎接入"],
        "triggers": [
            "星擎线索", "星擎", "TikTok线索", "矩阵获客", "视频营销",
            "TK买家", "星擎跟进", "视频询盘", "内容营销"
        ],
    },
    "xiaotuo": {
        "name": "小拓精灵",
        "key": "xiaotuo",
        "tier": "paid",
        "parent": "xiaoyuan",
        "category": "智能拓客",
        "description": "线索挖掘与培育 · 买家需求匹配 · 转化与成交促进",
        "source": "AI猎采",
        "skills": ["DC-LS", "DC-OS", "DC-Copy", "DC-GS", "DC-IQ", "DC-WA", "猎采接入"],
        "triggers": [
            "猎采线索", "AI猎采", "全网买家", "买家发现", "主动开发",
            "猎采", "拓客", "批量开发", "智能拓客"
        ],
    },
}


class AgentRouter:
    """Agent 路由器"""

    def __init__(self):
        os.makedirs(str(DATA_DIR), exist_ok=True)
        self._subs = self._load_subs()

    def _load_subs(self):
        if SUBSCRIPTIONS_FILE.exists():
            return json.loads(SUBSCRIPTIONS_FILE.read_text())
        return {"users": {}, "enterprises": {}, "updated_at": ""}

    def _save_subs(self):
        self._subs["updated_at"] = _now()
        SUBSCRIPTIONS_FILE.write_text(json.dumps(self._subs, ensure_ascii=False, indent=2))

    # ── 订阅管理 ──

    def subscribe(self, user_open_id, agent_key, enterprise="", plan="monthly"):
        """为用户开通子Agent"""
        if user_open_id not in self._subs["users"]:
            self._subs["users"][user_open_id] = {
                "agents": {}, "enterprise": enterprise, "joined_at": _now()
            }
        self._subs["users"][user_open_id]["agents"][agent_key] = {
            "plan": plan,
            "active": True,
            "subscribed_at": _now(),
        }
        self._save_subs()

    def unsubscribe(self, user_open_id, agent_key):
        """取消订阅"""
        if user_open_id in self._subs.get("users", {}):
            self._subs["users"][user_open_id].get("agents", {}).pop(agent_key, None)
            self._save_subs()

    def has_access(self, user_open_id, agent_key):
        """检查用户是否有Agent权限（小元永远返回True）"""
        if agent_key == "xiaoyuan":
            return True
        user = self._subs.get("users", {}).get(user_open_id, {})
        agent = user.get("agents", {}).get(agent_key, {})
        return agent.get("active", False)

    def get_user_agents(self, user_open_id):
        """获取用户已订阅的Agent列表"""
        result = {"xiaoyuan": AGENTS["xiaoyuan"]}
        user = self._subs.get("users", {}).get(user_open_id, {})
        for key, sub in user.get("agents", {}).items():
            if sub.get("active") and key in AGENTS:
                result[key] = AGENTS[key]
        return result

    # ── 意图路由 ──

    def detect_agent(self, user_message, user_open_id=""):
        """根据用户消息检测应该由哪个Agent处理
        返回: (agent_key, tier, can_execute)
        """
        msg_lower = user_message.lower()
        user_agents = self.get_user_agents(user_open_id) if user_open_id else {}

        for agent_key, agent_def in AGENTS.items():
            if agent_key == "xiaoyuan":
                continue  # 小元是fallback
            for trigger in agent_def.get("triggers", []):
                if trigger.lower() in msg_lower:
                    if agent_key in user_agents:
                        return (agent_key, agent_def["tier"], True)
                    else:
                        return (agent_key, "paywall", False)

        return ("xiaoyuan", "free", True)

    def enforce(self, user_message, user_open_id=""):
        """强制守门: 检测意图 → 付费Agent未订阅 → 返回阻隔 + 禁止执行"""
        agent_key, tier, can_execute = self.detect_agent(user_message, user_open_id)
        if not can_execute:
            return {
                "blocked": True,
                "agent_key": agent_key,
                "paywall_info": self.get_paywall_info(agent_key),
            }
        return {
            "blocked": False,
            "agent_key": agent_key,
        }

    def get_paywall_info(self, agent_key):
        """获取付费阻隔信息（供飞书通知卡片使用）"""
        agent = AGENTS.get(agent_key)
        if not agent:
            return None
        return {
            "agent_key": agent_key,
            "agent_name": agent["name"],
            "description": agent["description"],
            "price": agent.get("price", ""),
            "skills": agent.get("skills", []),
        }

    def get_all_agents(self):
        """列出所有Agent"""
        return AGENTS


# ── CLI ─────────────────────────────────────────────────────────
def main():
    router = AgentRouter()

    if len(sys.argv) < 2:
        print("dc_agent_router.py agents|check|route|subscribe|unsubscribe")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "agents":
        for key, a in AGENTS.items():
            print(f"\n{'🆓' if a['tier'] == 'free' else '💰'} {a['name']} ({key})")
            print(f"   {a['description']}")
            if a.get('price'):
                print(f"   {a['price']}")

    elif cmd == "check":
        agent_key = sys.argv[2]
        uid = sys.argv[3] if len(sys.argv) > 3 else ""
        has = router.has_access(uid, agent_key)
        print(f"User {uid} → {agent_key}: {'✅ granted' if has else '❌ paywall'}")

    elif cmd == "route":
        msg = sys.argv[2]
        uid = sys.argv[3] if len(sys.argv) > 3 else ""
        agent, tier = router.detect_agent(msg, uid)
        print(f"Message: {msg}")
        print(f"Routed to: {agent} ({tier})")
        if tier == "paywall":
            info = router.get_paywall_info(agent)
            print(f"Paywall: {json.dumps(info, ensure_ascii=False, indent=2)}")

    elif cmd == "subscribe":
        uid = sys.argv[2]
        agent_key = sys.argv[3]
        router.subscribe(uid, agent_key)
        print(f"Subscribed {uid} → {agent_key}")

    elif cmd == "unsubscribe":
        uid = sys.argv[2]
        agent_key = sys.argv[3]
        router.unsubscribe(uid, agent_key)
        print(f"Unsubscribed {uid} → {agent_key}")


if __name__ == "__main__":
    main()
