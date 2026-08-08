#!/usr/bin/env python3
"""DC-Dashboard 数据面板引擎 — 聚合 LS/KB/SendLog → 日报 + 漏斗 + 看板"""

import json, os, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(__file__))

from dc_send_log import SendLog
from dc_ls_store import LeadStore
from dc_kb_engine import KBEngine

_FUNNEL_LABELS = ["线索池", "有效线索", "已触达", "已回复", "跟进中"]
_IQ_STAGE_LABELS = {0:"未建联", 1:"已回复", 2:"已表达兴趣", 3:"已索要资料", 4:"已预约会议", 5:"销售跟进", -1:"已暂停"}


class Dashboard:
    """数据面板引擎"""

    def __init__(self, enterprise_domain=""):
        self.store = LeadStore()
        self.slog = SendLog()
        self.kb = KBEngine()
        self.enterprise = enterprise_domain

    # ── 日报 ──

    def daily_report(self, user_open_id="", enterprise=""):
        """生成日报文本（口吻日常，不象系统报表）"""
        ent = enterprise or self.enterprise
        if not ent:
            raise ValueError("daily_report requires enterprise for tenant isolation")
        stats = self.slog.stats_today(user_open_id=user_open_id, enterprise=ent)
        leads = self._user_leads(user_open_id, ent)

        sent = stats["sent"]
        delivered = stats["delivered"]
        bounced = stats["bounced"]
        opened = stats["opened"]
        replied = stats["replied"]

        # 买家状态分布
        stage_count = Counter()
        for l in leads:
            stage_count[l.get("iq_stage", 0)] += 1

        active = stage_count.get(1, 0) + stage_count.get(2, 0) + stage_count.get(3, 0)
        chatting = stage_count.get(2, 0) + stage_count.get(3, 0)
        pool = stage_count.get(0, 0)

        # KB 缺失
        kb_missing = self.kb.missing_materials(ent) if ent else []

        lines = []
        lines.append(f"早 ☀️")
        lines.append("")

        if sent > 0:
            lines.append(f"今天发了 {sent} 封，到了 {delivered} 封。" +
                         (f" {bounced} 封退信。" if bounced else "") +
                         (f" {opened} 封被打开了。" if opened else ""))

        if replied:
            lines.append(f"有 {replied} 封回复，建议看一下。")

        lines.append("")
        new_leads = sum(1 for l in leads if l.get("status") == "待处理")
        my_leads = sum(1 for l in leads if l.get("status") == "我的买家")
        if new_leads:
            lines.append(f"新进了 {new_leads} 条线索。")
        lines.append(f"目前在跟 {active} 家：{pool} 封刚发完等回复，{chatting} 家在聊。")

        if kb_missing:
            lines.append(f"知识库还缺：{'、'.join(kb_missing)}，有空补一下。")

        return "\n".join(lines)

    # ── 漏斗 ──

    def funnel(self, user_open_id="", enterprise=""):
        """漏斗数据：线索池 → 有效线索 → 已触达 → 已回复 → 跟进中"""
        ent = enterprise or self.enterprise
        if not ent:
            raise ValueError("funnel requires enterprise for tenant isolation")
        leads = self._user_leads(user_open_id, ent)

        pool = len(leads)  # 线索池
        valid = sum(1 for l in leads if l.get("status") == "我的买家")  # 有效线索

        # 已触达 = send_log 中出现过的买家
        activities = self.slog.recent_activities(limit=500, user_open_id=user_open_id, enterprise=ent)
        touched_domains = set()
        replied_domains = set()
        for a in activities:
            if a.get("type") == "sent":
                touched_domains.add(a.get("buyer_domain",""))
            elif a.get("type") == "reply":
                replied_domains.add(a.get("buyer_domain",""))

        touched = len(touched_domains) if touched_domains else (valid if sent_count(user_open_id, ent) > 0 else 0)

        # 已回复 = IQ stage >= 1 或有 reply event
        replied = sum(1 for l in leads if l.get("iq_stage", 0) >= 1) or len(replied_domains)

        # 跟进中 = IQ stage 2-4
        following = sum(1 for l in leads if l.get("iq_stage", 0) in (2, 3, 4))

        steps = [pool, max(valid, pool), touched or valid, replied, following]
        # 修正：每一步 <= 上一步
        for i in range(1, len(steps)):
            steps[i] = min(steps[i], steps[i-1])

        funnel_data = []
        for i, (label, count) in enumerate(zip(_FUNNEL_LABELS, steps)):
            prev = steps[i-1] if i > 0 else count
            rate = f"{(count/prev*100):.0f}%" if prev > 0 else "0%"
            funnel_data.append({"stage": label, "count": count, "from_prev": rate})

        return funnel_data

    # ── 看板数据（4 Tab） ──

    def dashboard(self, user_open_id="", enterprise=""):
        """返回完整看板数据"""
        ent = enterprise or self.enterprise
        if not ent:
            raise ValueError("dashboard requires enterprise for tenant isolation")
        leads = self._user_leads(user_open_id, ent)

        # Tab 1: 漏斗总览
        funnel_data = self.funnel(user_open_id, ent)

        # Tab 2: 线索明细
        lead_detail = []
        for l in leads:
            stage = l.get("iq_stage", 0)
            lead_detail.append({
                "company": l.get("company_name",""),
                "domain": l.get("domain",""),
                "country": l.get("country",""),
                "status": l.get("status",""),
                "iq_stage": stage,
                "iq_stage_name": _IQ_STAGE_LABELS.get(stage, "未知"),
                "intent": l.get("iq_last_intent",""),
                "created_at": (l.get("created_at") or "")[:10],
            })

        # Tab 3: 营销记录
        activities = self.slog.recent_activities(limit=100, user_open_id=user_open_id, enterprise=ent)
        marketing = []
        for a in activities:
            marketing.append({
                "buyer": a.get("buyer_name", a.get("buyer_domain","")),
                "domain": a.get("buyer_domain",""),
                "channel": a.get("channel",""),
                "round": a.get("round",""),
                "type": a.get("type",""),
                "status": a.get("status", a.get("event","")),
                "ts": (a.get("_ts",""))[:19],
            })

        # Tab 4: 买家状态
        buyer_status = []
        for l in leads:
            stage = l.get("iq_stage", 0)
            buyer_status.append({
                "company": l.get("company_name",""),
                "domain": l.get("domain",""),
                "stage": stage,
                "stage_name": _IQ_STAGE_LABELS.get(stage, "未知"),
                "last_intent": l.get("iq_last_intent",""),
                "last_reply": (l.get("iq_last_reply") or "")[:100],
                "updated": (l.get("iq_updated_at") or l.get("updated_at") or "")[:19],
            })

        # KB 状态
        kb_status = self.kb.list_all(ent) if ent else []

        return {
            "funnel": funnel_data,
            "leads": lead_detail,
            "marketing": marketing,
            "buyer_status": buyer_status,
            "kb": kb_status,
        }

    # ── 辅助 ──

    def _user_leads(self, user_open_id="", enterprise=""):
        ent = enterprise or self.enterprise
        if user_open_id:
            return self.store.get_user_leads(user_open_id, enterprise=ent) or []
        if ent:
            return self.store.get_enterprise_leads(ent) or []
        raise ValueError("Dashboard requires user_open_id or enterprise for data isolation")


def sent_count(user_open_id, enterprise):
    """快速获取发送过的买家数，避免重复读大文件"""
    slog = SendLog()
    acts = slog.recent_activities(limit=200, user_open_id=user_open_id, enterprise=enterprise)
    domains = set(a.get("buyer_domain","") for a in acts if a.get("type") == "sent")
    return len(domains)


if __name__ == "__main__":
    import sys
    db = Dashboard()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "funnel"
    user = sys.argv[2] if len(sys.argv) > 2 else ""
    ent = sys.argv[3] if len(sys.argv) > 3 else "kmlbelt.com"

    if cmd == "daily":
        print(db.daily_report(user_open_id=user, enterprise=ent))
    elif cmd == "funnel":
        print(json.dumps(db.funnel(user_open_id=user, enterprise=ent), ensure_ascii=False, indent=2))
    elif cmd == "dashboard":
        data = db.dashboard(user_open_id=user, enterprise=ent)
        print(f"Funnel: {json.dumps(data['funnel'], ensure_ascii=False)}")
        print(f"Leads: {len(data['leads'])}")
        print(f"Marketing: {len(data['marketing'])}")
        print(f"BuyerStatus: {len(data['buyer_status'])}")
        print(f"KB: {len(data['kb'])}")
    else:
        print("Usage: dc_dashboard.py daily|funnel|dashboard [user_open_id] [enterprise_domain]")
