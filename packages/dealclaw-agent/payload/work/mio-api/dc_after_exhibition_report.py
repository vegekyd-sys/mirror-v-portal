#!/usr/bin/env python3
"""
dc_after_exhibition_report.py — 展后诊断复盘报告（骨架 + 渲染 + 校验）

职责边界（与 skill 的分工，写死）：
  - 本脚本只做「机械活」：读数据、算漏斗、按 followup_priority 分层、收集 evidence_refs、
    聚合需求洞察、渲染 HTML、转 PDF、跑 validate 校验。
  - 「推理活」由 Agent 按 skill（SKILL.md 第 5 步重点客户深析）生成：深析段落、
    诊断的解释与建议、本届收获、行动 reason/success_metric。脚本只留骨架字段，
    由 Agent 生成后填入 report-data.json 的对应字段。

数据铁律（见 memory/projects/dealclaw/after-exhibition-review-interface-map.md）：
  所有展会数据都在同一目录 data/memory/<enterprise_id>/，读统一走 dc_memory_data 的
  read_leads / read_interactions，不多源查找。真正打飞书 API 的只有 sync_leads_to_memory 一个。

用法：
  # 1. 出骨架（Agent 在此基础上生成深析/诊断/收获/建议）
  python3 dc_after_exhibition_report.py skeleton --company-id <sid> --exhibition-id <id> [--mode close_out] [--out-dir <dir>]
  # 2. 渲染已填好的 report-data.json → HTML + PDF
  python3 dc_after_exhibition_report.py render --input <report-data.json> [--out-dir <dir>]
  # 3. 校验
  python3 dc_after_exhibition_report.py validate --input <report-data.json>
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import dc_memory_data  # noqa: E402
from dc_memory_data import _customer_id as _dc_customer_id  # noqa: E402
from dc_opportunity_stage import (  # noqa: E402
    COMMERCIAL_TYPES,
    PRODUCT_NEED_TYPES,
)

REPORT_VERSION = "1.0.0"

# 漏斗 5 层主口径（唯一 customer 计数）
FUNNEL_STAGES = ["目标买家", "已邀约", "到展/会面", "有效商洽", "商务推进"]

ATTEND_SOURCE_HINTS = ("到展", "扫码", "会议", "到场", "对接")
INVITE_SOURCE_HINTS = ("邀约", "确认", "报名")


def _cid(lead: dict) -> str:
    """lead → 稳定 customer 主键，与 dc_memory_data._customer_id 一致。"""
    return _dc_customer_id(lead.get("company_cdp_id"), lead.get("company"), lead.get("website"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────
# 1. 输入读取（单目录）
# ─────────────────────────────────────────────────────────────
def load_input(company_id: str) -> dict:
    leads = dc_memory_data.read_leads(company_id) or []
    interactions = dc_memory_data.read_interactions(company_id) or []
    return {"leads": leads, "interactions": interactions}


def read_company_name(company_id: str) -> str:
    """读企业名：data/memory/<sid>/kb.json 的 profile.name（与线索/互动同目录）。"""
    p = HERE.parents[1] / "data" / "memory" / str(company_id) / "kb.json"
    if p.exists():
        try:
            profile = json.loads(p.read_text(encoding="utf-8")).get("profile", {})
            return (profile.get("name") or "").strip()
        except Exception:
            return ""
    return ""


def read_exhibition_name(company_id: str, exhibition_id: str) -> str:
    """读展会名：data/memory/<sid>/meta.json 的 exhibitions[] 按 exhibition_id 匹配。"""
    p = HERE.parents[1] / "data" / "memory" / str(company_id) / "meta.json"
    if p.exists():
        try:
            meta = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            meta = {}
        for e in meta.get("exhibitions", []):
            if not isinstance(e, dict):
                continue
            eid = str(e.get("exhibition_id") or e.get("id") or "")
            if eid == str(exhibition_id):
                return (e.get("name") or e.get("name_en") or "").strip()
    return ""


# ─────────────────────────────────────────────────────────────
# 2. 漏斗 5 层计数（机械）
# ─────────────────────────────────────────────────────────────
def build_funnel(leads: list, interactions: list) -> list:
    by_customer: dict[str, dict] = {}
    for lead in leads:
        if not isinstance(lead, dict):
            continue
        cid = _cid(lead)
        by_customer.setdefault(cid, {"lead": lead, "interactions": []})

    for it in interactions:
        if not isinstance(it, dict):
            continue
        cid = (it.get("customer_id") or "").strip()
        if cid and cid in by_customer:
            by_customer[cid]["interactions"].append(it)

    def _has_outbound(c):
        for it in c["interactions"]:
            if it.get("direction") == "outbound":
                return True
        return any(h in (c["lead"].get("source") or "") for h in INVITE_SOURCE_HINTS)

    def _has_attend(c):
        src = (c["lead"].get("source") or "")
        if any(h in src for h in ATTEND_SOURCE_HINTS):
            return True
        return any((it.get("channel") or "") in ("meeting", "scan") for it in c["interactions"])

    def _has_bidir(c):
        return any(it.get("direction") == "bidirectional" for it in c["interactions"])

    def _has_commercial(c):
        for it in c["interactions"]:
            for sig in (it.get("signals") or []):
                if isinstance(sig, dict) and sig.get("type") in COMMERCIAL_TYPES:
                    return True
        return (c["lead"].get("stage") or "") in ("报价中", "商务跟进")

    counts = {
        "目标买家": len(by_customer),
        "已邀约": sum(1 for c in by_customer.values() if _has_outbound(c)),
        "到展/会面": sum(1 for c in by_customer.values() if _has_attend(c)),
        "有效商洽": sum(1 for c in by_customer.values() if _has_bidir(c)),
        "商务推进": sum(1 for c in by_customer.values() if _has_commercial(c)),
    }

    funnel = []
    prev = None
    prev_stage = None
    for stage in FUNNEL_STAGES:
        n = counts[stage]
        rate = round(n / prev, 4) if (prev is not None and prev > 0) else None
        funnel.append({
            "stage": stage,
            "unique_customers": n,
            "denominator_stage": prev_stage or "",
            "conversion_rate": rate,
            "coverage": "complete",
            "evidence_refs": [],
        })
        prev = n
        prev_stage = stage
    return funnel


# ─────────────────────────────────────────────────────────────
# 3. 漏斗阻塞定位（机械：找最陡下降的相邻层，只出事实，不出解释）
# ─────────────────────────────────────────────────────────────
def locate_bottleneck(funnel: list) -> dict | None:
    drops = []
    for i in range(1, len(funnel)):
        prev, cur = funnel[i - 1], funnel[i]
        rate = cur.get("conversion_rate")
        if rate is not None and prev["unique_customers"] >= 5:
            drops.append((rate, prev, cur))
    if not drops:
        return None
    _, prev, cur = min(drops, key=lambda x: x[0])
    return {
        "category": "followup",
        "observation": f"{prev['stage']} {prev['unique_customers']} 家 → {cur['stage']} {cur['unique_customers']} 家，转化率 {cur['conversion_rate']:.0%}。",
        "interpretation": "",        # Agent 生成
        "confidence": "medium",
        "cannot_conclude": ["诊断基于漏斗计数，具体根因需结合原始互动证据确认"],
        "evidence_refs": [],
        "recommended_action": "",    # Agent 生成
        "success_metric": "",        # Agent 生成
    }


# ─────────────────────────────────────────────────────────────
# 4. 买家分层 + evidence_refs（机械；深析段落由 Agent 生成）
# ─────────────────────────────────────────────────────────────
def build_buyer_actions(leads: list, interactions: list) -> dict:
    def _priority(lead: dict) -> str:
        p = (lead.get("followup_priority") or "").strip()
        if p:
            return p
        g = (lead.get("match_grade") or "").strip()
        return {"A": "优先跟进", "B": "普通跟进", "C": "长期培育"}.get(g, "长期培育")

    refs_by_customer: dict[str, list] = {}
    for it in interactions:
        if not isinstance(it, dict):
            continue
        cid = (it.get("customer_id") or "").strip()
        iid = (it.get("interaction_id") or "").strip()
        if cid and iid:
            refs_by_customer.setdefault(cid, []).append(iid)

    groups = {"优先跟进": [], "普通跟进": [], "长期培育": []}
    for lead in leads:
        if not isinstance(lead, dict):
            continue
        cid = _cid(lead)
        p = _priority(lead)
        groups.setdefault(p, []).append({
            "customer_id": cid,
            "company": (lead.get("company") or "").strip(),
            "fit_grade": (lead.get("match_grade") or "").strip(),
            "stage": (lead.get("stage") or "").strip(),
            "followup_priority": p,
            "priority_reason": (lead.get("priority_reason") or "").strip(),
            "evidence_refs": refs_by_customer.get(cid, []),
            "deep_dive": "",           # Agent 生成：重点客户深析段落
            "next_step": {
                "action": (lead.get("next_action") or "").strip(),
                "owner": (lead.get("owner") or "待分配").strip(),
                "due": (lead.get("due") or "").strip(),
            },
        })

    return {
        "not_connected_priority": [],
        "connected_followups": groups.get("优先跟进", []),
        "nurture": groups.get("普通跟进", []) + groups.get("长期培育", []),
        "suppressed": [],
    }


# ─────────────────────────────────────────────────────────────
# 5. 需求洞察聚合（机械：区分唯一客户数 vs 提及次数）
# ─────────────────────────────────────────────────────────────
def build_demand_insights(interactions: list) -> list:
    agg: dict[str, dict] = {}
    for it in interactions:
        if not isinstance(it, dict):
            continue
        cid = (it.get("customer_id") or "").strip()
        iid = (it.get("interaction_id") or "").strip()
        for sig in (it.get("signals") or []):
            if not isinstance(sig, dict):
                continue
            if sig.get("type") in PRODUCT_NEED_TYPES and sig.get("value"):
                topic = str(sig["value"]).strip()
                e = agg.setdefault(topic, {"customers": set(), "mentions": 0, "refs": []})
                if cid:
                    e["customers"].add(cid)
                e["mentions"] += 1
                if iid:
                    e["refs"].append(iid)
    ranked = sorted(agg.items(), key=lambda x: -x[1]["mentions"])
    return [{
        "topic": topic,
        "unique_customers": len(e["customers"]),
        "mention_count": e["mentions"],
        "sample_customer_count": len(e["customers"]),
        "evidence_refs": e["refs"],
        "confidence": "medium",
    } for topic, e in ranked]


# ─────────────────────────────────────────────────────────────
# 6. 组装骨架（diagnoses/wins/action_plan/deep_dive 留空，由 Agent 填）
# ─────────────────────────────────────────────────────────────
def build_skeleton(company_id: str, exhibition_id: str, mode: str) -> dict:
    inp = load_input(company_id)
    leads = inp["leads"]
    interactions = inp["interactions"]
    funnel = build_funnel(leads, interactions)
    bottleneck = locate_bottleneck(funnel)
    buyer_actions = build_buyer_actions(leads, interactions)
    demand = build_demand_insights(interactions)

    total_target = funnel[0]["unique_customers"] if funnel else 0
    commercial_n = funnel[-1]["unique_customers"] if funnel else 0

    return {
        "report_id": f"{company_id}:{exhibition_id}:{mode}",
        "report_mode": mode,
        "exhibition_id": exhibition_id,
        "company_id": company_id,
        "company": {"company_id": company_id, "name": read_company_name(company_id)},
        "exhibition": {"exhibition_id": exhibition_id, "name": read_exhibition_name(company_id, exhibition_id)},
        "generated_at": _now_iso(),
        "scope": {
            "current_exhibition_only": True,
            "unique_customer_count": total_target,
            "deduped_record_count": len(leads),
        },
        "executive_summary": {
            "conclusion": f"本届共触达 {total_target} 家目标买家，{commercial_n} 家已推进到报价/样品/二次会议。",
            "wins": [],                 # Agent 生成
            "main_bottleneck": bottleneck["observation"] if bottleneck else "",
            "priority_action": "",      # Agent 生成
        },
        "funnel": funnel,
        "diagnoses": [bottleneck] if bottleneck else [],
        "buyer_actions": buyer_actions,
        "demand_insights": demand,
        "product_usage_review": [],
        "action_plan": [],              # Agent 生成
        "data_completeness": {
            "status": "complete" if leads else "insufficient",
            "missing_sources": [] if leads else ["leads"],
            "impact_on_conclusions": [],
        },
        "benchmark_context": None,
        "report_version": REPORT_VERSION,
    }


# ─────────────────────────────────────────────────────────────
# 7. HTML 渲染（内嵌 CSS，无外部依赖）
# ─────────────────────────────────────────────────────────────
def render_html(report: dict) -> str:
    es = report["executive_summary"]
    funnel = report["funnel"]
    diagnoses = report["diagnoses"]
    ba = report["buyer_actions"]
    demand = report["demand_insights"]
    wins = es.get("wins", [])
    action_plan = report.get("action_plan", [])
    company_name = (report.get("company") or {}).get("name", "")
    exhibition_name = (report.get("exhibition") or {}).get("name", "") or report.get("exhibition_id", "")

    stage_emoji = {"目标买家": "🎯", "已邀约": "📩", "到展/会面": "🏢", "有效商洽": "💬", "商务推进": "💰"}
    max_n = max((f["unique_customers"] for f in funnel), default=1) or 1
    funnel_rows = []
    for f in funnel:
        width = int(f["unique_customers"] / max_n * 100) if max_n else 0
        rate = f"{f['conversion_rate']:.0%}" if f.get("conversion_rate") is not None else "—"
        emoji = stage_emoji.get(f["stage"], "▫️")
        funnel_rows.append(
            f'<div class="frow"><div class="flabel">{emoji} {f["stage"]}<span class="fnum">{f["unique_customers"]}</span></div>'
            f'<div class="fbar"><div class="fbar-in" style="width:{width}%"></div></div>'
            f'<div class="frate">转化 {rate}</div></div>'
        )

    diag_rows = ""
    for d in diagnoses:
        interp = f'<div class="diag-i">{d.get("interpretation", "")}</div>' if d.get("interpretation") else ""
        action = f'<div class="diag-a"><b>建议：</b>{d.get("recommended_action", "")}</div>' if d.get("recommended_action") else ""
        diag_rows += (
            f'<div class="diag"><div class="diag-t">⚠️ {d["observation"]}</div>'
            f'{interp}{action}</div>'
        )

    def _rows(items, cap=20):
        out = ""
        for b in items[:cap]:
            out += (
                f'<tr><td>{b["company"]}</td><td>{b["fit_grade"]}</td>'
                f'<td>{b["stage"]}</td><td>{b["priority_reason"] or "—"}</td>'
                f'<td>{b["next_step"]["action"] or "—"}</td></tr>'
            )
        return out or '<tr><td colspan="5" class="empty">暂无</td></tr>'

    priority_rows = _rows(ba["connected_followups"])
    nurture_rows = _rows(ba["nurture"])

    # 重点客户深析（Agent 生成，逐家渲染）
    badges = ["①", "②", "③", "④", "⑤"]
    deep_dive_rows = ""
    for i, b in enumerate(ba["connected_followups"]):
        if b.get("deep_dive"):
            badge = badges[i] if i < len(badges) else f"{i + 1}"
            deep_dive_rows += (
                f'<div class="deepdive"><div class="dd-t"><span class="dd-badge">{badge}</span> {b["company"]}</div>'
                f'<div class="dd-body">{b["deep_dive"]}</div></div>'
            )
    deep_dive_section = ""
    if deep_dive_rows:
        deep_dive_section = f'<h2>🔍 重点客户深析</h2>{deep_dive_rows}'

    demand_rows = "".join(f'<li>{d["topic"]} · {d["unique_customers"]} 家客户 · {d["mention_count"]} 次提及</li>' for d in demand)
    if not demand_rows:
        demand_rows = '<li class="empty">暂无结构化需求信号</li>'

    wins_rows = "".join(f'<li>{w}</li>' for w in wins) or '<li class="empty">暂无</li>'

    horizon_label = {"72h": "72小时内", "7d": "7天内", "30d": "30天内", "next_exhibition": "下届展会"}
    horizon_emoji = {"72h": "⏱️", "7d": "📅", "30d": "🗓️", "next_exhibition": "🔁"}
    plan_rows = ""
    for p in action_plan:
        h = horizon_label.get(p.get("horizon", ""), p.get("horizon", ""))
        emoji = horizon_emoji.get(p.get("horizon", ""), "📋")
        plan_rows += (
            f'<div class="plan"><div class="plan-t"><span class="plan-ico">{emoji}</span> {h} · {p["action"]}</div>'
            f'<div class="plan-d">{p.get("reason", "")}</div></div>'
        )
    if not plan_rows:
        plan_rows = '<p class="empty">暂无</p>'

    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>展后复盘报告</title>
<style>
  :root {{ --brand:#2563eb; --muted:#6b7280; --line:#e5e7eb; --bg:#f8fafc; }}
  * {{ box-sizing:border-box; }}
  body {{ font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; color:#111827; margin:0; background:#fff; }}
  .page {{ max-width:820px; margin:0 auto; padding:32px 28px; }}
  .cover {{ text-align:center; padding:120px 20px 80px; border-bottom:1px solid var(--line); margin-bottom:32px; page-break-after:always; }}
  .cover-brand {{ color:var(--muted); font-size:13px; letter-spacing:3px; }}
  .cover-title {{ font-size:30px; margin:40px 0 24px; }}
  .cover-company {{ font-size:22px; font-weight:700; }}
  .cover-expo {{ font-size:15px; color:var(--muted); margin-top:14px; }}
  .cover-meta {{ font-size:13px; color:var(--muted); margin-top:44px; }}
  h1 {{ font-size:22px; margin:0 0 4px; }}
  .meta {{ color:var(--muted); font-size:13px; margin-bottom:20px; }}
  .kpi {{ display:flex; gap:12px; flex-wrap:wrap; margin:16px 0 24px; }}
  .kpi .card {{ flex:1; min-width:130px; background:linear-gradient(180deg,#fff,var(--bg)); border:1px solid var(--line); border-radius:14px; padding:16px 16px 14px; box-shadow:0 2px 8px rgba(17,24,39,.05); border-top:3px solid var(--brand); }}
  .kpi .card.c-green {{ border-top-color:#059669; }} .kpi .card.c-amber {{ border-top-color:#d97706; }}
  .kpi .ico {{ display:flex; align-items:center; justify-content:center; width:38px; height:38px; border-radius:50%; font-size:20px; background:#e8f0fe; }}
  .kpi .card.c-green .ico {{ background:#e6f4ef; }} .kpi .card.c-amber .ico {{ background:#fef3e2; }}
  .kpi .n {{ font-size:28px; font-weight:700; color:var(--brand); margin-top:8px; }}
  .kpi .card.c-green .n {{ color:#059669; }} .kpi .card.c-amber .n {{ color:#d97706; }}
  .kpi .l {{ font-size:12px; color:var(--muted); margin-top:2px; }}
  h2 {{ font-size:17px; border-left:4px solid var(--brand); padding-left:8px; margin:28px 0 12px; }}
  .frow {{ display:flex; align-items:center; gap:10px; margin:8px 0; }}
  .flabel {{ width:110px; font-size:13px; }}
  .fnum {{ margin-left:6px; font-weight:700; color:var(--brand); }}
  .fbar {{ flex:1; height:18px; background:var(--bg); border-radius:4px; overflow:hidden; }}
  .fbar-in {{ height:100%; background:linear-gradient(90deg,#3b82f6,#2563eb); }}
  .frate {{ width:64px; font-size:12px; color:var(--muted); text-align:right; }}
  .diag {{ border:1px solid var(--line); border-left:4px solid #d97706; border-radius:12px; padding:14px 16px; margin:10px 0; background:#fffbeb; box-shadow:0 2px 8px rgba(17,24,39,.04); }}
  .diag-t {{ font-weight:600; }}
  .diag-i {{ color:var(--muted); font-size:13px; margin:6px 0; }}
  .diag-a {{ font-size:13px; }}
  .deepdive {{ border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin:10px 0; background:#fff; box-shadow:0 2px 8px rgba(17,24,39,.04); }}
  .dd-t {{ font-weight:700; color:var(--brand); }}
  .dd-badge {{ display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; border-radius:50%; background:#e8f0fe; color:var(--brand); font-size:13px; font-weight:700; margin-right:6px; vertical-align:-4px; }}
  .dd-body {{ font-size:14px; margin-top:6px; line-height:1.7; }}
  .plan {{ border:1px solid var(--line); border-radius:12px; padding:12px 16px; margin:8px 0; background:#fff; box-shadow:0 2px 8px rgba(17,24,39,.04); }}
  .plan-t {{ font-weight:600; }}
  .plan-ico {{ display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border-radius:50%; background:#e8f0fe; font-size:14px; margin-right:6px; vertical-align:-5px; }}
  .plan-d {{ color:var(--muted); font-size:13px; margin-top:4px; }}
  table {{ width:100%; border-collapse:collapse; font-size:13px; }}
  th,td {{ border:1px solid var(--line); padding:8px 10px; text-align:left; }}
  th {{ background:var(--bg); }}
  .empty {{ color:var(--muted); }}
  ul {{ padding-left:20px; }}
  .foot {{ margin-top:32px; padding-top:12px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }}
</style></head><body><div class="page">
  <div class="cover">
    <div class="cover-brand">出海精灵小元 · 展后诊断复盘</div>
    <h1 class="cover-title">展后复盘报告</h1>
    <div class="cover-company">{company_name}</div>
    <div class="cover-expo">参展展会：{exhibition_name}</div>
    <div class="cover-meta">{report["generated_at"][:10]} · {report["report_mode"]}</div>
  </div>

  <div class="kpi">
    <div class="card"><div class="ico">🎯</div><div class="n">{report["scope"]["unique_customer_count"]}</div><div class="l">目标买家（家）</div></div>
    <div class="card"><div class="ico">📩</div><div class="n">{funnel[1]["unique_customers"] if len(funnel) > 1 else 0}</div><div class="l">已邀约</div></div>
    <div class="card c-green"><div class="ico">💰</div><div class="n">{funnel[-1]["unique_customers"] if funnel else 0}</div><div class="l">商务推进</div></div>
    <div class="card c-amber"><div class="ico">⭐</div><div class="n">{len(ba["connected_followups"])}</div><div class="l">优先跟进</div></div>
  </div>

  <h2>📊 展后复盘结论</h2>
  <p>{es["conclusion"]}</p>
  <p><b>主阻塞：</b>{es["main_bottleneck"] or "—"}</p>
  <p><b>最优先动作：</b>{es["priority_action"] or "—"}</p>

  <h2>🏆 本届收获</h2>
  <ul>{wins_rows}</ul>

  <h2>📉 漏斗与关键阻塞</h2>
  <div class="funnel">{''.join(funnel_rows)}</div>
  {diag_rows}

  {deep_dive_section}

  <h2>⭐ 优先跟进买家</h2>
  <table><thead><tr><th>公司</th><th>匹配度</th><th>阶段</th><th>优先级理由</th><th>下一步</th></tr></thead>
  <tbody>{priority_rows}</tbody></table>

  <h2>🌱 培育买家</h2>
  <table><thead><tr><th>公司</th><th>匹配度</th><th>阶段</th><th>优先级理由</th><th>下一步</th></tr></thead>
  <tbody>{nurture_rows}</tbody></table>

  <h2>💡 买家需求与现场反馈</h2>
  <ul>{demand_rows}</ul>

  <h2>🎯 跟进与复购建议</h2>
  {plan_rows}

  <div class="foot">本报告由出海精灵小元基于展会买家数据自动生成，不含买家个人联系方式。数据口径见配套分层表。</div>
</div></body></html>"""
    return html


# ─────────────────────────────────────────────────────────────
# 8. HTML → PDF（chrome headless）
# ─────────────────────────────────────────────────────────────
def html_to_pdf(html_path: str, pdf_path: str) -> bool:
    chrome = os.environ.get("CHROME_BIN") or "google-chrome"
    cmd = [
        chrome, "--headless", "--disable-gpu", "--no-sandbox",
        "--print-to-pdf=" + pdf_path, "--no-pdf-header-footer",
        "file://" + os.path.abspath(html_path),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return r.returncode == 0 and Path(pdf_path).exists()
    except Exception as e:
        print(f"PDF 转换失败: {e}", file=sys.stderr)
        return False


# ─────────────────────────────────────────────────────────────
# 9. validate（复用 skill 里的校验脚本）
# ─────────────────────────────────────────────────────────────
def validate_report(report_path: str) -> dict:
    validator = HERE.parent.parent / "skills" / "dealclaw-after-exhibition-review" / "scripts" / "validate_report.py"
    if not validator.exists():
        return {"valid": False, "errors": [f"validator not found: {validator}"], "warnings": []}
    r = subprocess.run([sys.executable, str(validator), "--input", report_path],
                       capture_output=True, text=True, timeout=30)
    try:
        return json.loads(r.stdout.strip())
    except Exception:
        return {"valid": False, "errors": [r.stdout.strip() or r.stderr.strip()], "warnings": []}


# ─────────────────────────────────────────────────────────────
# 10. CLI
# ─────────────────────────────────────────────────────────────
def cmd_skeleton(args) -> int:
    company_id = args.company_id or dc_memory_data.resolve_supplier_id()
    if not company_id:
        print("缺少 company-id 且环境无 MIO_CDP_SUPPLIER_ID", file=sys.stderr)
        return 1
    skeleton = build_skeleton(company_id, args.exhibition_id, args.mode)
    out_dir = args.out_dir or str(HERE.parents[1] / "data" / "after-exhibition-report" / company_id / args.exhibition_id)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    path = Path(out_dir) / "report-data.json"
    path.write_text(json.dumps(skeleton, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": "ok", "skeleton_path": str(path)}, ensure_ascii=False, indent=2))
    return 0


def cmd_render(args) -> int:
    report = json.loads(Path(args.input).read_text(encoding="utf-8"))
    html = render_html(report)
    out_dir = args.out_dir or str(Path(args.input).parent)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    html_path = Path(out_dir) / "report.html"
    pdf_path = Path(out_dir) / "report.pdf"
    html_path.write_text(html, encoding="utf-8")
    pdf_ok = html_to_pdf(str(html_path), str(pdf_path))
    print(json.dumps({"status": "ok", "html_path": str(html_path), "pdf_path": str(pdf_path), "pdf_ok": pdf_ok},
                     ensure_ascii=False, indent=2))
    return 0 if pdf_ok else 1


def cmd_validate(args) -> int:
    result = validate_report(args.input)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("valid") else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="展后诊断复盘报告：骨架 + 渲染 + 校验")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("skeleton", help="出骨架（Agent 在此基础上生成深析/诊断/收获/建议）")
    p.add_argument("--company-id", default="")
    p.add_argument("--exhibition-id", required=True)
    p.add_argument("--mode", default="close_out", choices=["close_out", "conversion_review", "refresh"])
    p.add_argument("--out-dir", default="")
    p.set_defaults(func=cmd_skeleton)

    p = sub.add_parser("render", help="渲染已填好的 report-data.json → HTML + PDF")
    p.add_argument("--input", required=True)
    p.add_argument("--out-dir", default="")
    p.set_defaults(func=cmd_render)

    p = sub.add_parser("validate", help="校验 report-data.json")
    p.add_argument("--input", required=True)
    p.set_defaults(func=cmd_validate)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
