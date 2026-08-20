#!/usr/bin/env python3
"""
dc_growth_dashboard.py — 展会邮件营销看板（只读聚合，P0-E6）

从 email-facts / email-signals / pending-replies / LeadStore / Campaign 聚合，
输出触达漏斗 + 当前跟进 + 买家状态 + 策略效果。

只读：不重新分析邮件、不修改业务状态、不写任何事实。缺数据显示「暂无数据」，不编造。
同日期/企业/战役重复生成结果一致（纯聚合、确定性排序）。
"""

from __future__ import annotations


def _signals(company_id: str) -> list[dict]:
    from dc_email_controller.dc_email_signals import list_signals
    try:
        return list_signals(company_id)
    except Exception:
        return []


def _outbounds(company_id: str) -> list[dict]:
    from email_gateway.store import EmailStore
    try:
        return EmailStore().list_outbound_records(company_id=company_id)
    except Exception:
        return []


def _inbounds(company_id: str) -> list[dict]:
    from email_gateway.store import EmailStore
    try:
        return EmailStore().list_inbound_records(company_id=company_id)
    except Exception:
        return []


def _leads(company_id: str) -> list[dict]:
    try:
        from dc_ls_store import LeadStore
        ls = LeadStore()
        return [l for l in getattr(ls, "_leads", [])
                if (l.get("enterprise") or "") in (company_id, "", "testco")]
    except Exception:
        return []


def _campaign(company_id: str):
    try:
        from dc_campaign import get_active_campaign
        return get_active_campaign(company_id)
    except Exception:
        return None


# ── 1. 触达漏斗 ──────────────────────────────────────────
def build_funnel(company_id: str) -> dict:
    out = _outbounds(company_id)
    signals = _signals(company_id)
    sent = len(out)
    delivered = sum(1 for o in out if o.get("provider_status") == "delivered")
    bounced = sum(1 for o in out if o.get("provider_status") == "bounced")
    # 回复/有效询盘/会议意向：按唯一 source_message_id（回复 message_id）计数，
    # 因为 Resend 接收路径生成信号而非 inbound bound 记录。
    reply_ids = {s.get("source_message_id") for s in signals if s.get("source_message_id")
                 and s.get("signal_type") in ("quote_request", "sample_request", "meeting_interest", "missing_info")}
    inquiry_ids = {s.get("source_message_id") for s in signals if s.get("source_message_id")
                   and s.get("signal_type") in ("quote_request", "sample_request")}
    meeting_ids = {s.get("source_message_id") for s in signals if s.get("source_message_id")
                   and s.get("signal_type") == "meeting_interest"}
    return {
        "sent": sent,
        "delivered": delivered,
        "replied": len(reply_ids),
        "valid_inquiry": len(inquiry_ids),
        "meeting_intent": len(meeting_ids),
        "bounced": bounced,
    }


# ── 2. 当前跟进 ──────────────────────────────────────────
def build_followup_status(company_id: str) -> dict:
    from dc_email_controller.dc_reply_draft import list_drafts
    from dc_email_controller.dc_followup import list_strategy_review_candidates
    drafts = list_drafts(company_id=company_id, status="pending_confirmation")
    followup2 = [d for d in drafts if d.get("category") == "followup" and d.get("touch_number") == 2]
    followup3 = [d for d in drafts if d.get("category") == "followup" and d.get("touch_number") == 3]
    reply_drafts = [d for d in drafts if d.get("category") != "followup"]
    paused = list_strategy_review_candidates(company_id)
    return {
        "pending_drafts": len(drafts),
        "second_round": len(followup2),
        "third_round": len(followup3),
        "reply_drafts": len(reply_drafts),
        "paused_leads": len(paused),
        "needs_user_action": len(drafts),
    }


# ── 3. 买家状态 ──────────────────────────────────────────
def _lead_by_domain(leads: list[dict], domain: str) -> dict | None:
    d = (domain or "").strip().lower()
    if not d:
        return None
    for l in leads:
        if (l.get("domain") or "").strip().lower() == d:
            return l
    return None


def _resolve_lead(outbound: dict, email: str, leads: list[dict]) -> dict | None:
    """优先结构化字段（lead_id/contact_id），缺失时按 domain，再失败返回 None（→暂无数据，不猜测）。"""
    lead_id = outbound.get("lead_id") or outbound.get("contact_id") or ""
    if lead_id:
        for l in leads:
            if l.get("company_cdp_id") == lead_id \
                    or (l.get("domain") or "").strip().lower() == lead_id.strip().lower():
                return l
    domain = email.split("@")[-1].strip().lower() if "@" in email else ""
    return _lead_by_domain(leads, domain)


def _buyer_last_signal(signals: list[dict], out_resend_ids: set) -> str:
    types = []
    for s in signals:
        if s.get("source_resend_id") in out_resend_ids or s.get("thread_id") in out_resend_ids:
            if s.get("signal_type") in ("quote_request", "sample_request", "meeting_interest"):
                types.append(s.get("signal_type"))
    return "meeting_interest" if "meeting_interest" in types else \
           ("valid_inquiry" if types else "")


def build_buyer_status(company_id: str) -> list[dict]:
    out = _outbounds(company_id)
    signals = _signals(company_id)
    leads = _leads(company_id)

    # 按买家邮箱分组
    by_email: dict[str, dict] = {}
    for o in out:
        email = (o.get("recipients") or [""])[0].strip().lower()
        if not email:
            continue
        g = by_email.setdefault(email, {"email": email, "touch": 0, "resend_ids": set(),
                                        "status": "", "outbounds": []})
        g["outbounds"].append(o)
        g["touch"] = max(g["touch"], int(o.get("touch_number", 0) or 0))
        g["resend_ids"].add(o.get("resend_id", ""))
        g["status"] = o.get("provider_status", "") or g["status"]

    rows = []
    for email, g in sorted(by_email.items()):
        hint = g["outbounds"][0] if g["outbounds"] else {}
        lead = _resolve_lead(hint, email, leads)
        touch = g["touch"]
        status = g["status"]
        sig = _buyer_last_signal(signals, g["resend_ids"])

        # 最近动作 + 下一步动作 + 状态原因
        if status == "bounced":
            recent, nxt, reason = "退信", "已停止", "退信"
        elif status in ("complained", "failed"):
            recent, nxt, reason = "投递失败", "已停止", status
        elif sig == "meeting_interest":
            recent, nxt, reason = "会议意向", "已回复", "买家有会议意向"
        elif sig == "valid_inquiry":
            recent, nxt, reason = "有效询盘", "已回复", "买家询盘"
        elif status == "delivered":
            if touch >= 3:
                recent, nxt, reason = "已送达(三轮无回复)", "策略复盘", "达到第三轮"
            else:
                recent, nxt, reason = "已送达未回复", f"第{touch+1}轮跟进", "未回复"
        else:
            recent, nxt, reason = "已发送", "等待送达", "投递中"

        rows.append({
            "company": (lead or {}).get("company_name", "") or "暂无数据",
            "contact": email,
            "country": (lead or {}).get("country", "") or "暂无数据",
            "touch_number": touch,
            "last_action": recent,
            "next_action": nxt,
            "status_reason": reason,
        })
    return rows


# ── 4. 策略效果 ──────────────────────────────────────────
def build_strategy_effect(company_id: str) -> dict:
    f = build_funnel(company_id)
    camp = _campaign(company_id)
    from dc_email_controller.dc_followup import list_strategy_review_candidates
    paused = list_strategy_review_candidates(company_id)
    delivery_rate = round(f["delivered"] / f["sent"] * 100, 1) if f["sent"] else 0
    reply_rate = round(f["replied"] / f["delivered"] * 100, 1) if f["delivered"] else 0
    return {
        "delivery_rate": delivery_rate,
        "reply_rate": reply_rate,
        "valid_inquiry": f["valid_inquiry"],
        "meeting_intent": f["meeting_intent"],
        "bounced": f["bounced"],
        "strategy_version": (camp or {}).get("strategy_version", 0),
        "needs_review": len(paused) > 0,
    }


# ── 聚合 ────────────────────────────────────────────────
def build_dashboard(company_id: str) -> dict:
    return {
        "company_id": company_id,
        "funnel": build_funnel(company_id),
        "followup": build_followup_status(company_id),
        "buyers": build_buyer_status(company_id),
        "strategy": build_strategy_effect(company_id),
        "text": None,
    }


_DASHBOARD_QUERIES = ["看一下邮件情况", "邮件情况", "展会进展", "邮件漏斗", "哪些买家需要跟进", "当前营销效果", "营销效果", "邮件看板", "看板", "触达漏斗"]


def detect_dashboard_intent(text: str) -> bool:
    """对话查询是否触发完整看板。"""
    t = (text or "").strip()
    if not t:
        return False
    return any(q in t for q in _DASHBOARD_QUERIES)


def format_dashboard(d: dict) -> str:
    company = d.get("company_id", "")
    f = d.get("funnel", {})
    fu = d.get("followup", {})
    st = d.get("strategy", {})
    buyers = d.get("buyers", [])

    lines = [f"📊 DealClaw 展会邮件看板 · {company}", ""]
    lines.append("## 触达漏斗")
    lines.append(f"发送 {f.get('sent',0)} → 送达 {f.get('delivered',0)} → 回复 {f.get('replied',0)} → 有效询盘 {f.get('valid_inquiry',0)} → 会议意向 {f.get('meeting_intent',0)}")
    lines.append("")
    lines.append("## 当前跟进")
    lines.append(f"待发送草稿 {fu.get('pending_drafts',0)}（回复 {fu.get('reply_drafts',0)} / 跟进 {fu.get('second_round',0)+fu.get('third_round',0)}）")
    lines.append(f"第二轮 {fu.get('second_round',0)} · 第三轮 {fu.get('third_round',0)} · 已暂停 {fu.get('paused_leads',0)} · 需确认 {fu.get('needs_user_action',0)}")
    lines.append("")
    lines.append("## 策略效果")
    lines.append(f"送达率 {st.get('delivery_rate',0)}% · 回复率 {st.get('reply_rate',0)}% · 退信 {st.get('bounced',0)}")
    lines.append(f"有效询盘 {st.get('valid_inquiry',0)} · 会议意向 {st.get('meeting_intent',0)} · 策略版本 v{st.get('strategy_version',0)} · 需复盘 {'是' if st.get('needs_review') else '否'}")
    lines.append("")
    lines.append("## 买家状态")
    if not buyers:
        lines.append("暂无数据")
    else:
        lines.append("| 公司 | 联系人 | 国家 | 触达轮次 | 最近动作 | 下一步 | 状态原因 |")
        lines.append("|---|---|---|---|---|---|---|")
        for b in buyers:
            lines.append(f"| {b['company']} | {b['contact']} | {b['country']} | {b['touch_number']} | {b['last_action']} | {b['next_action']} | {b['status_reason']} |")
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    company = sys.argv[1] if len(sys.argv) > 1 else "testco"
    d = build_dashboard(company)
    d["text"] = format_dashboard(d)
    print(d["text"])
