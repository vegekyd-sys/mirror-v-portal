#!/usr/bin/env python3
"""
dc_daily_report.py — 早报/晚报内容构建（展会邮件增长闭环）

从现有 Markdown 事实存储聚合指标，生成早晚报文本。即使无业务变化也返回简短版本
（只有实时机会通知可以无价值静默）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

MEMORY_DIR = Path(__file__).resolve().parents[2] / "memory"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _exhibition_stage_line(company_id: str) -> str:
    """展会阶段提示行（当前阶段 + 下一步）；读不到 meta.json 或非展会企业则返回空。"""
    try:
        from dc_exhibition_stage import read_stage, stage_next_step, STAGE_LABELS
        st = read_stage(company_id)
        label = STAGE_LABELS.get(st["stage"], st["stage"])
        if st["stage"] in ("profiling", "planning"):
            return f"展会阶段：{label}｜{stage_next_step(st['stage'])}"
        return f"展会阶段：{label}"
    except Exception:
        return ""


def _distill_brief(company_id: str) -> str:
    """读取该企业用户的上周行为偏好（蒸馏产物），用于周一早报。"""
    try:
        open_id = ""
        # 1. Campaign.owner_open_id（优先）
        try:
            from dc_campaign import get_active_campaign
            camp = get_active_campaign(company_id)
            if camp and camp.get("owner_open_id"):
                open_id = camp["owner_open_id"]
        except Exception:
            pass
        # 2. registry campaign_owner_open_id（兜底）
        if not open_id:
            from dc_company_registry import CompanyRegistry
            entry = CompanyRegistry().get(company_id)
            open_id = (entry or {}).get("campaign_owner_open_id", "")
        if not open_id:
            return ""
        path = MEMORY_DIR / "people" / f"{open_id}.md"
        if not path.exists():
            return ""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
        import re
        lines = []
        for ln in path.read_text(encoding="utf-8").splitlines():
            if ln.startswith("- [行为") and "蒸馏" in ln:
                m = re.search(r"\| (\d{4}-\d{2}-\d{2}) \|", ln)
                if m and m.group(1) >= cutoff:
                    lines.append(ln)
        if lines:
            return "上周记住的行为偏好：\n" + "\n".join(lines)
    except Exception:
        pass
    return ""


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


# supplier_id → 真实企业名 + registry slug。
# 注意：不能用 CDP getBasicInfo 的 companyName——它对 151897148668 返回「米奥兰特2026」
# （平台测试号名），真实企业是中亿丰罗普斯金（LPSK，slug=lpskcom）。
_COMPANY_INFO = {
    "151897148668": {"name": "中亿丰罗普斯金材料科技股份有限公司", "slug": "lpskcom"},
    "152598718575": {"name": "杭州奕歌跨境电商有限公司", "slug": "ingiatradecom"},
    "100000834234": {"name": "杭州卓立家具有限公司", "slug": ""},
}


def company_display_name(company_id: str) -> str:
    """supplier_id → 企业展示名。优先显式映射，兜底 registry/company_id。"""
    info = _COMPANY_INFO.get(company_id)
    if info and info.get("name"):
        return info["name"]
    try:
        from dc_company_registry import CompanyRegistry
        entry = CompanyRegistry().get(company_id)
        if entry and entry.get("company_name"):
            return entry["company_name"]
    except Exception:
        pass
    return company_id


def _followup_table_url(company_id: str) -> str:
    """飞书跟进明细表跳转链接（优先「邮件跟进」表，兜底线索池 bitable_url）。无则返回空串。"""
    info = _COMPANY_INFO.get(company_id, {})
    slug = info.get("slug") or company_id
    try:
        from dc_company_registry import CompanyRegistry
        entry = CompanyRegistry().get(slug)
        if entry:
            app_token = entry.get("app_token", "")
            followup_tid = entry.get("followup_table_id", "")
            if app_token and followup_tid:
                return f"https://versa-ai.feishu.cn/base/{app_token}?table={followup_tid}"
            if entry.get("bitable_url"):
                return entry["bitable_url"]
    except Exception:
        pass
    return ""


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
    text = _format_morning(company_id, m, drafts, followups, funnel)
    # 周一早报：体现上周蒸馏的行为偏好（让用户感知「越来越懂」）
    if datetime.now(timezone.utc).weekday() == 0:
        distill = _distill_brief(company_id)
        if distill:
            text += "\n\n" + distill
    return {
        "company_id": company_id,
        "slot": "morning",
        "metrics": m,
        "funnel": funnel,
        "pending_draft_count": len(drafts),
        "due_followup_count": len(followups),
        "campaign": _campaign_brief(company_id),
        "kb": _kb_brief(company_id),
        "text": text,
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
    """早报：只做跟进情况总结（不再逐条列邮箱），明细跳转飞书跟进表。"""
    lines = []
    stage_line = _exhibition_stage_line(company_id)
    if stage_line:
        lines.append(stage_line)
    lines += [
        f"发送 {m['sent']} · 送达 {m['delivered']} · 回复 {m['replied']} · 退信 {m['bounced']}",
        f"待跟进 {len(followups)} 家 · 待确认草稿 {len(drafts)} 份",
    ]
    url = _followup_table_url(company_id)
    if url:
        lines.append(f"跟进明细 → {url}")
    return "\n".join(lines)


def _format_evening(company_id, m, drafts, followups, funnel, strategy) -> str:
    """晚报：今日发送/待跟进总结，明细跳转飞书跟进表。"""
    lines = []
    stage_line = _exhibition_stage_line(company_id)
    if stage_line:
        lines.append(stage_line)
    lines += [
        f"今日发送 {m['sent']} · 送达 {m['delivered']} · 回复 {m['replied']} · 退信 {m['bounced']}",
        f"待跟进 {len(followups)} 家 · 待确认草稿 {len(drafts)} 份",
    ]
    url = _followup_table_url(company_id)
    if url:
        lines.append(f"跟进明细 → {url}")
    return "\n".join(lines)
