#!/usr/bin/env python3
"""
dc_daily_report.py — 早报/晚报内容构建（展会邮件增长闭环）

从现有 Markdown 事实存储聚合指标，生成早晚报文本。即使无业务变化也返回简短版本
（只有实时机会通知可以无价值静默）。
"""

from __future__ import annotations

from datetime import datetime, timezone


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def collect_metrics(company_id: str, campaign_id: str = None) -> dict:
    """聚合发送/送达/回复/退信等指标（EmailStore + 信号层，统一口径）。"""
    from email_gateway.store import EmailStore
    from dc_email_controller.dc_email_signals import list_signals
    store = EmailStore()
    outbounds = store.list_outbound_records(company_id=company_id)
    if campaign_id:
        outbounds = [o for o in outbounds if o.get("campaign_id") == campaign_id]
    sent = len(outbounds)
    delivered = sum(1 for o in outbounds if o.get("provider_status") == "delivered")
    bounced = sum(1 for o in outbounds if o.get("provider_status") == "bounced")
    # 回复：按唯一回复 message_id（信号）计数，与看板漏斗一致（Resend 路径生成信号，不写 inbound bound 记录）
    reply_ids = {s.get("source_message_id") for s in list_signals(company_id, campaign_id=campaign_id)
                 if s.get("source_message_id")
                 and s.get("signal_type") in ("quote_request", "sample_request", "meeting_interest", "missing_info")}
    replied = len(reply_ids)
    return {
        "sent": sent,
        "delivered": delivered,
        "bounced": bounced,
        "replied": replied,
    }


def collect_pending_drafts(company_id: str) -> list[dict]:
    """待确认草稿（回复草稿 + 跟进草稿）。"""
    from dc_email_controller.dc_reply_draft import list_drafts
    return list_drafts(company_id=company_id, status="pending_confirmation")


def collect_due_followups(company_id: str) -> list[dict]:
    """到期跟进任务。"""
    from dc_email_controller.dc_followup import list_followup_candidates
    return list_followup_candidates(company_id)


def collect_opportunities(company_id: str) -> list[dict]:
    """新增机会（quote/sample/meeting 信号）。"""
    from dc_email_controller.dc_email_signals import list_signals
    opp = {"quote_request", "sample_request", "meeting_interest"}
    return [s for s in list_signals(company_id) if s.get("signal_type") in opp]


def _campaign_brief(company_id: str) -> str:
    """展会进度简表。"""
    try:
        from dc_campaign import get_active_campaign
        camp = get_active_campaign(company_id)
        if camp:
            return (f"{camp.get('name') or camp.get('campaign_id','')} · "
                    f"阶段 {camp.get('phase','?')} · 邀约 {camp.get('target_invites','?')} · "
                    f"会议 {camp.get('target_meetings','?')}")
    except Exception:
        pass
    return "（无活跃展会）"


def _kb_brief(company_id: str) -> str:
    """知识库完善度简表。"""
    try:
        from dc_kb_engine import KBEngine
        links = KBEngine().get_material_links(company_id) or []
        return f"{len(links)} 份物料"
    except Exception:
        return "（KB 未接入）"


def _funnel(company_id: str) -> dict:
    try:
        from dc_growth_dashboard import build_funnel
        return build_funnel(company_id)
    except Exception:
        return {}


def _strategy(company_id: str) -> dict:
    try:
        from dc_growth_dashboard import build_strategy_effect
        return build_strategy_effect(company_id)
    except Exception:
        return {}


def build_morning_report(company_id: str) -> dict:
    """早报：只展示关键变化（漏斗 + 今日到期跟进 + 待确认草稿 + KB）。"""
    m = collect_metrics(company_id)
    drafts = collect_pending_drafts(company_id)
    followups = collect_due_followups(company_id)
    funnel = _funnel(company_id)
    return {
        "company_id": company_id,
        "slot": "morning",
        "metrics": m,
        "funnel": funnel,
        "pending_draft_count": len(drafts),
        "due_followup_count": len(followups),
        "campaign": _campaign_brief(company_id),
        "kb": _kb_brief(company_id),
        "text": _format_morning(company_id, m, drafts, followups, funnel),
        "generated_at": _now(),
    }


def build_evening_report(company_id: str) -> dict:
    """晚报：今日总结 + 明日计划 + 看板摘要。"""
    m = collect_metrics(company_id)
    drafts = collect_pending_drafts(company_id)
    followups = collect_due_followups(company_id)
    funnel = _funnel(company_id)
    strategy = _strategy(company_id)
    return {
        "company_id": company_id,
        "slot": "evening",
        "metrics": m,
        "funnel": funnel,
        "strategy": strategy,
        "pending_draft_count": len(drafts),
        "due_followup_count": len(followups),
        "text": _format_evening(company_id, m, drafts, followups, funnel, strategy),
        "generated_at": _now(),
    }


def _format_morning(company_id, m, drafts, followups, funnel) -> str:
    lines = [f"☀️ DealClaw 早报 · {company_id}"]
    lines.append(f"漏斗 发送{funnel.get('sent',0)}→送达{funnel.get('delivered',0)}→回复{funnel.get('replied',0)}→有效询盘{funnel.get('valid_inquiry',0)}→会议意向{funnel.get('meeting_intent',0)}")
    lines.append(f"今日到期跟进 {len(followups)} · 待确认草稿 {len(drafts)}")
    lines.append(f"知识库：{_kb_brief(company_id)}")
    if followups:
        for f in followups[:5]:
            lines.append(f"· 跟进 {f.get('buyer_email','')} 第 {f.get('next_touch')} 轮")
    if drafts:
        for d in drafts[:5]:
            lines.append(f"· 待确认 {d.get('category','reply')} → {d.get('buyer_email','')}")
    return "\n".join(lines)


def _format_evening(company_id, m, drafts, followups, funnel, strategy) -> str:
    lines = [f"🌙 DealClaw 晚报 · {company_id}"]
    lines.append(f"今日发送 {m['sent']} / 送达 {m['delivered']} / 回复 {m['replied']} / 退信 {m['bounced']}")
    lines.append("")
    lines.append("展会邮件看板摘要：")
    lines.append(f"漏斗 发送{funnel.get('sent',0)}→送达{funnel.get('delivered',0)}→回复{funnel.get('replied',0)}→有效询盘{funnel.get('valid_inquiry',0)}→会议意向{funnel.get('meeting_intent',0)}")
    lines.append(f"当前待跟进 {len(followups)} · 待确认草稿 {len(drafts)} · 退信 {funnel.get('bounced',0)}")
    lines.append(f"策略{'需复盘' if strategy.get('needs_review') else '无需复盘'}")
    lines.append("")
    lines.append("明日计划：跟进到期线索 + 处理待确认草稿。")
    return "\n".join(lines)
