#!/usr/bin/env python3
"""
dc_daily_report.py — 早报/晚报内容构建（展会邮件增长闭环）

从现有 Markdown 事实存储聚合指标，生成早晚报文本。即使无业务变化也返回简短版本
（只有实时机会通知可以无价值静默）。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

MEMORY_DIR = Path(__file__).resolve().parents[2] / "memory"
# Daily Brief 新管线的 plan/review 落盘根（与 EmailStore 用同一 DC_DATA_DIR 口径）
DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent / "data")))
BUSINESS_TZ = "Asia/Shanghai"


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


def _self_evolution_brief(company_id: str, days: int = 7) -> str:
    """读最近 N 天的业务 reflection（只取 what），拼「最近又学会了」段落；有数据才写，没数据静默。"""
    try:
        refl_path = Path(__file__).resolve().parents[2] / "memory" / "projects" / "dealclaw" / "reflections.jsonl"
        if not refl_path.exists():
            return ""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        whats = []
        for line in refl_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except Exception:
                continue
            ts = (entry.get("ts") or "").strip()
            what = (entry.get("what") or "").strip()
            if not ts or not what or ts < cutoff:
                continue
            whats.append(what)
        if not whats:
            return ""
        # 去重（保持顺序）+ 取最近 3 条 + 倒序（最新在前）
        recent = list(dict.fromkeys(whats))[-3:][::-1]
        return "最近又学会了：\n" + "\n".join(f"· {w}" for w in recent)
    except Exception:
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


def company_display_name(company_id: str) -> str:
    """supplier_id → 企业展示名。只读动态租户数据，不维护企业硬编码。"""
    # 1. 企业绑定信息（buyer-leads-v10 binding.company_name，动态权威来源）
    try:
        v10_dir = Path(__file__).resolve().parents[2] / "data" / "buyer-leads-v10"
        if v10_dir.exists():
            for f in v10_dir.glob("*.json"):
                try:
                    d = json.loads(f.read_text(encoding="utf-8"))
                    if d.get("status") != "active":
                        continue
                    b = d.get("binding") or {}
                    sid = str(b.get("tradechina_supplier_id") or "").strip()
                    name = str(b.get("company_name") or d.get("label") or "").strip()
                    if sid == str(company_id) and name:
                        return name
                except Exception:
                    continue
    except Exception:
        pass
    # 2. 画像 kb.json profile.name（动态）
    try:
        kb_path = Path(__file__).resolve().parents[2] / "data" / "memory" / str(company_id) / "kb.json"
        if kb_path.exists():
            kb = json.loads(kb_path.read_text(encoding="utf-8"))
            name = (kb.get("profile") or {}).get("name")
            if name:
                return name
    except Exception:
        pass
    # 3. registry 兜底
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
    from enterprise_ids import slug_for
    slug = slug_for(company_id)
    try:
        from dc_company_registry import CompanyRegistry
        entry = CompanyRegistry().get(slug)
        if entry:
            app_token = entry.get("app_token", "")
            # 优先沟通明细子表（阶段④链接改指）；兑底旧 followup_table_id / bitable_url
            tid = entry.get("interaction_table_id") or entry.get("followup_table_id", "")
            if app_token and tid:
                return f"https://versa-ai.feishu.cn/base/{app_token}?table={tid}"
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


def _local_date_of(ts) -> str:
    """把带时区 ISO 时间转成业务时区（Asia/Shanghai）的日期，解决 UTC/本地跨日错配。"""
    if not ts:
        return ""
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(ZoneInfo(BUSINESS_TZ)).date().isoformat()
    except (ValueError, TypeError):
        return str(ts)[:10]


def _follow_count(plan: dict) -> int:
    """待跟进客户数：plan 中 buyer 目标去重计数（客户级动作 + 批量跟进）。"""
    targets = set()
    for a in plan.get("actions", []):
        for t in a.get("target_refs", []):
            if t.get("type") == "buyer" and t.get("id"):
                targets.add(t["id"])
    return len(targets)


def _exh_metrics_from_plan(plan: dict) -> str:
    """展会数据行：从 ExhibitionProvider result item 取到展/会议/未到场。"""
    for c in plan.get("context", []):
        if c.get("source") == "exhibition" and c.get("kind") == "result":
            d = c.get("detail") or {}
            if "arrived" in d:
                return (f"本届展会：到展 {d.get('arrived', 0)} · 会议 {d.get('meeting', 0)} · "
                        f"未到场 {d.get('not_arrived', 0)}")
    return ""


def _today_metrics(company_id: str, plan: dict) -> str:
    """【今日数据】客户关心的量化指标：会谈 / 待跟进 / 回复 / 邮件 / 商机 / 展会。"""
    try:
        now = datetime.now(timezone.utc)
        today = now.astimezone(ZoneInfo(BUSINESS_TZ)).date().isoformat()
        lines: list[str] = []
        # 互动：今日会谈 / 收到回复（按客户计数）
        meetings = replies = 0
        try:
            from dc_memory_data import read_interactions
            seen_m, seen_r = set(), set()
            for it in (read_interactions(company_id) or []):
                if _local_date_of(it.get("occurred_at")) != today:
                    continue
                cid = it.get("customer_id") or it.get("interaction_id") or it.get("raw_record_ref")
                if str(it.get("channel") or "").lower() == "meeting":
                    seen_m.add(cid)
                if str(it.get("direction") or "").lower() == "inbound":
                    seen_r.add(cid)
            meetings, replies = len(seen_m), len(seen_r)
        except Exception:
            pass
        lines.append(f"今日会谈 {meetings} 家 · 收到回复 {replies} 家 · 待跟进 {_follow_count(plan)} 家")
        # 邮件
        try:
            m = collect_metrics(company_id)
            lines.append(f"邮件：发送 {m['sent']} · 送达 {m['delivered']} · "
                         f"回复 {m['replied']} · 退信 {m['bounced']}")
        except Exception:
            pass
        # 新增商机（今日信号）
        try:
            from dc_email_controller.dc_email_signals import list_signals
            q = s = mi = 0
            for sig in (list_signals(company_id) or []):
                ts = sig.get("created_at") or sig.get("occurred_at")
                if _local_date_of(ts) != today:
                    continue
                st = sig.get("signal_type")
                q += 1 if st == "quote_request" else 0
                s += 1 if st == "sample_request" else 0
                mi += 1 if st == "meeting_interest" else 0
            if q or s or mi:
                lines.append(f"新增商机：报价 {q} · 样品 {s} · 会议意向 {mi}")
        except Exception:
            pass
        exh = _exh_metrics_from_plan(plan)
        if exh:
            lines.append(exh)
        return "【今日数据】\n" + "\n".join(f"- {l}" for l in lines) if lines else ""
    except Exception:
        return ""


def _exhibition_battle(company_id: str) -> str:
    """【本届展会战报】漏斗（邀约→到展→有效商洽→商务推进）+ 高匹配 + 新增商机。

    只统计本届展会买家；无本届数据返回空串。**不含上届对比（已定稿不做）**。
    """
    try:
        from dc_exhibition_provider import (
            ExhibitionMemoryStore, resolve_current_exhibition, _exh_id, in_scope, has_meeting, _int,
        )
        from dc_opportunity_stage import COMMERCIAL_TYPES
        store = ExhibitionMemoryStore()
        meta = store.read_meta(company_id)
        exh = resolve_current_exhibition(meta)
        exh_id = _exh_id(exh) if exh else ""
        if not exh_id:
            return ""
        invs = [i for i in (store.list_invitations(company_id, exh_id) or []) if in_scope(i, exh_id)]
        if not invs:
            return ""
        inter = store.list_interactions(company_id) or []

        def _cid(b):
            return str(b.get("companyCdpId") or b.get("company_cdp_id") or b.get("companyName") or "")

        def _commercial(cid):
            for it in inter:
                if str(it.get("customer_id") or "") not in ("", cid):
                    continue
                for s in (it.get("signals") or []):
                    if isinstance(s, dict) and s.get("type") in COMMERCIAL_TYPES and s.get("value"):
                        return True
            return False

        invited = len(invs)
        arrived = engaged = advanced = grade_a = grade_b = new_deals = 0
        for b in invs:
            cid = _cid(b)
            g = str(b.get("match_grade") or b.get("fit_grade") or "").strip()
            grade_a += 1 if g == "A" else 0
            grade_b += 1 if g == "B" else 0
            if _int(b.get("isCheckIn") or b.get("is_checkin")) == 1:
                arrived += 1
                engaged += 1 if has_meeting(b, inter, cid) else 0
            if _commercial(cid) or str(b.get("stage") or "") in ("报价中", "需求明确", "商务跟进"):
                advanced += 1
        for it in inter:
            for s in (it.get("signals") or []):
                if isinstance(s, dict) and s.get("type") in ("quote_request", "sample_request", "contract") and s.get("value"):
                    new_deals += 1

        def _rate(n, d):
            return f"{round(n / d * 100)}%" if d else "—"

        parts = ["【本届展会战报】",
                 f"邀约 {invited} → 到展 {arrived}（到场率 {_rate(arrived, invited)}）→ "
                 f"有效商洽 {engaged}（商洽率 {_rate(engaged, arrived)}）→ 商务推进 {advanced}"]
        if grade_a or grade_b:
            parts.append(f"高匹配买家：A 级 {grade_a} · B 级 {grade_b}")
        if new_deals:
            parts.append(f"新增商机（报价/寄样/合同）：{new_deals} 条")
        return "\n".join(parts)
    except Exception:
        return ""


def _pipeline_brief(company_id: str, slot: str) -> str:
    """新 Daily Brief 管线 → 推送文案片段（今日数据 + 今日优先 / 晚报核销）。失败/无数据返回空串。"""
    try:
        from dc_daily_brief import BriefContext
        import dc_daily_pipeline as pipeline
        now = datetime.now(timezone.utc)
        local_date = now.astimezone(ZoneInfo(BUSINESS_TZ)).date().isoformat()
        ctx = BriefContext(tenant=company_id, company=company_id, report_type=slot,
                           date=local_date, tz=BUSINESS_TZ, as_of=now.isoformat(),
                           window_start=now.isoformat(), window_end=now.isoformat())
        base = DATA_DIR / "daily-brief"
        if slot == "morning":
            r = pipeline.run_morning_brief(ctx, base)
            plan = r.get("plan") or {}
            parts = [_exhibition_battle(company_id), _today_metrics(company_id, plan),
                     _fmt_pipeline_morning(plan)]
        else:
            r = pipeline.run_evening_brief(ctx, base)
            plan = r.get("plan") or {}
            parts = [_exhibition_battle(company_id), _today_metrics(company_id, plan),
                     _fmt_pipeline_evening(r.get("review"), plan)]
        return "\n\n".join(p for p in parts if p)
    except Exception:
        return ""


def _fmt_pipeline_morning(plan: dict) -> str:
    by_key = {a.get("action_key"): a for a in plan.get("actions", [])}
    top = [by_key[k] for k in plan.get("top_n_action_keys", []) if k in by_key]
    lines: list[str] = []
    if top:
        lines.append("【今日优先】")
        for a in top:
            lines.append(f"{len(lines)}. {a['title']}｜{a.get('reason', '')}")
    batch = [a for a in plan.get("actions", []) if a.get("source") == "email"]
    for a in batch:
        lines.append(f"【待分层批量跟进】{a['title']}")
    for c in plan.get("context", []):
        if c.get("kind") == "risk":
            lines.append(f"【风险】{c['title']}")
    return "\n".join(lines)


def _fmt_pipeline_evening(review, plan: dict) -> str:
    if not review:
        return ""
    by_key = {a.get("action_key"): a for a in plan.get("actions", [])}
    lines = ["【晚报核销】"]
    for rv in review.get("reviews", []):
        title = (by_key.get(rv.get("action_key")) or {}).get("title", rv.get("action_key", ""))
        lines.append(f"- {title}：{rv.get('status')}")
    return "\n".join(lines)


def build_morning_report(company_id: str) -> dict:
    """早报：只展示关键变化（漏斗 + 今日到期跟进 + 待确认草稿 + KB）。"""
    m = collect_metrics(company_id)
    drafts = collect_pending_drafts(company_id)
    followups = collect_due_followups(company_id)
    funnel = _funnel(company_id)
    text = _format_morning(company_id, m, drafts, followups, funnel)
    brief = _pipeline_brief(company_id, "morning")
    if brief:
        text = (brief + "\n\n" + text) if text else brief
    # 周一早报：体现上周蒸馏的行为偏好（让用户感知「越来越懂」）
    if datetime.now(timezone.utc).weekday() == 0:
        distill = _distill_brief(company_id)
        if distill:
            text += "\n\n" + distill
    # 自进化感知：最近又学会了（业务 reflection，有数据才写）
    evolution = _self_evolution_brief(company_id)
    if evolution:
        text += "\n\n" + evolution
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
    text = _format_evening(company_id, m, drafts, followups, funnel, strategy)
    brief = _pipeline_brief(company_id, "evening")
    if brief:
        text = (brief + "\n\n" + text) if text else brief
    evolution = _self_evolution_brief(company_id)
    if evolution:
        text += "\n\n" + evolution
    return {
        "company_id": company_id,
        "slot": "evening",
        "metrics": m,
        "funnel": funnel,
        "strategy": strategy,
        "pending_draft_count": len(drafts),
        "due_followup_count": len(followups),
        "text": text,
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
