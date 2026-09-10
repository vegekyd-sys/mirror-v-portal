#!/usr/bin/env python3
"""weekly-evolution-report.py — Self Evolving V 每周进化报告.

Generates a structured Markdown report covering four dimensions of the
V-Learning-Loop lifecycle, spanning both candidate lifecycle (skill-candidates.md)
and Skill Workshop proposal lifecycle:

  1. 新增候选 — New candidates + proposals created this week
  2. 已验证   — Applied / validated this week
  3. 被拒绝   — Rejected this week
  4. 回归风险 — Regression risk: previously stable skills now flagged

Data sources (all read-only):
  - scripts/skill-dashboard.py --json          → candidate lifecycle
  - memory/projects/self-evolving-v/proposals-cache.json  → Skill Workshop snapshot
  - memory/reflections/YYYY-MM-DD.jsonl         → reflection entries
  - memory/skill-candidates.md                  → candidate metadata (via dashboard)

The proposals cache is refreshed by heartbeat before running this report:
  skill_workshop list → save to memory/projects/self-evolving-v/proposals-cache.json

Usage:
  python3 scripts/weekly-evolution-report.py                        # current week
  python3 scripts/weekly-evolution-report.py --week 2026-07-13      # week starting Mon
  python3 scripts/weekly-evolution-report.py --json                 # JSON output
  python3 scripts/weekly-evolution-report.py --output report.md     # write to file
  python3 scripts/weekly-evolution-report.py --no-color             # plain text (no ANSI)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
REFLECTIONS_DIR = ROOT / "memory" / "reflections"
SKILL_CANDIDATES_PATH = ROOT / "memory" / "skill-candidates.md"
PROPOSALS_CACHE = ROOT / "memory" / "projects" / "self-evolving-v" / "proposals-cache.json"

# ── Helpers ─────────────────────────────────────────────────────────────────

def now_local() -> datetime:
    return datetime.now(ZoneInfo("Asia/Shanghai"))


def week_boundaries(ref_date: Optional[str] = None) -> tuple[datetime, datetime]:
    """Return (monday_00:00, next_monday_00:00) in Asia/Shanghai timezone."""
    tz = ZoneInfo("Asia/Shanghai")
    if ref_date:
        ref = datetime.strptime(ref_date, "%Y-%m-%d").replace(tzinfo=tz)
    else:
        ref = now_local()
    monday = ref.replace(hour=0, minute=0, second=0, microsecond=0)
    monday -= timedelta(days=monday.weekday())
    next_monday = monday + timedelta(days=7)
    return (monday, next_monday)


def dt_to_date(dt_obj: datetime) -> str:
    return dt_obj.strftime("%Y-%m-%d")


def parse_iso_date(ts: Optional[str]) -> Optional[datetime]:
    """Parse a variety of date/ISO formats into a datetime."""
    if not ts:
        return None
    ts_str = str(ts).strip().strip('"')
    for fmt in [
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d",
        "%Y-%m-%dT%H:%M:%S.%f+00:00",
    ]:
        try:
            dt = datetime.strptime(ts_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(ZoneInfo("Asia/Shanghai"))
        except ValueError:
            continue
    return None


def extract_proposal_date(proposal_id: str) -> Optional[datetime]:
    """Extract date from proposal ID like 'skill-20260716-abc123'."""
    m = re.search(r"(\d{8})", proposal_id)
    if m:
        try:
            return datetime.strptime(m.group(1), "%Y%m%d").replace(
                tzinfo=ZoneInfo("Asia/Shanghai")
            )
        except ValueError:
            pass
    return None


def extract_skill_name(proposal_id: str) -> str:
    """Extract skill name from proposal ID like 'account-list-doc-20260716-...'"""
    cleaned = re.sub(r"-\d{8}-[a-f0-9]+$", "", proposal_id)
    cleaned = re.sub(r"-\d{8}$", "", cleaned)
    return cleaned


def is_in_week(dt: Optional[datetime], monday: datetime, next_monday: datetime) -> bool:
    if dt is None:
        return False
    return monday <= dt < next_monday


def is_in_week_str(date_str: str, monday: datetime, next_monday: datetime) -> bool:
    """Check if a YYYYMMDD date string falls within a week window."""
    dt = extract_proposal_date(f"x-{date_str}")
    return is_in_week(dt, monday, next_monday)


# ── Data fetching ──────────────────────────────────────────────────────────

def fetch_skill_dashboard() -> dict:
    """Run skill-dashboard.py --json and return parsed output."""
    try:
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "skill-dashboard.py"), "--json"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            print(f"[warn] skill-dashboard.py failed: {result.stderr[:200]}", file=sys.stderr)
            return {}
        return json.loads(result.stdout)
    except Exception as e:
        print(f"[warn] skill-dashboard.py exception: {e}", file=sys.stderr)
        return {}


def fetch_proposals_cache() -> list[dict]:
    """Read the Skill Workshop proposals cache file.

    This cache is expected to be refreshed by heartbeat before the report runs.
    Schema: {"fetched_at": "ISO", "proposals": [{"id": "...", "status": "...", ...}]}
    """
    if not PROPOSALS_CACHE.exists():
        return []
    try:
        data = json.loads(PROPOSALS_CACHE.read_text(encoding="utf-8"))
        return data.get("proposals", [])
    except Exception as e:
        print(f"[warn] proposals cache read error: {e}", file=sys.stderr)
        return []


def fetch_reflections_for_week(monday: datetime, next_monday: datetime) -> list[dict]:
    """Read reflection entries for this week from local jsonl files."""
    rows = []
    if not REFLECTIONS_DIR.exists():
        return rows
    tz_cn = ZoneInfo("Asia/Shanghai")
    for jsonl_file in sorted(REFLECTIONS_DIR.glob("*.jsonl")):
        file_date_str = jsonl_file.stem
        try:
            file_date = datetime.strptime(file_date_str, "%Y-%m-%d").replace(tzinfo=tz_cn)
        except ValueError:
            continue
        if file_date < monday or file_date >= next_monday:
            continue
        try:
            text = jsonl_file.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                row["_file"] = str(jsonl_file.relative_to(ROOT))
                rows.append(row)
            except json.JSONDecodeError:
                pass
    return rows


# ── Report building ────────────────────────────────────────────────────────

def build_weekly_report(monday: datetime, next_monday: datetime) -> dict:
    """Build a structured weekly evolution report with all four dimensions.

    Combines data from:
      - skill-candidates.md (via skill-dashboard.py)
      - Skill Workshop proposals cache
      - Reflections jsonl files
    """
    week_label = f"{dt_to_date(monday)} – {dt_to_date(next_monday - timedelta(days=1))}"

    # ── 1. Dashboard data (candidate lifecycle) ──────────────────────
    dashboard = fetch_skill_dashboard()
    all_dash_candidates = dashboard.get("all_candidates", [])
    latest_decisions = dashboard.get("latest_decisions", [])
    recent_promotions = dashboard.get("recent_promotions", [])

    # ── 2. Skill Workshop proposals ──────────────────────────────────
    all_proposals = fetch_proposals_cache()

    # ── 3. Reflections ───────────────────────────────────────────────
    week_reflections = fetch_reflections_for_week(monday, next_monday)

    # ── 4a. Candidates: new / validated / rejected (from dashboard) ──
    new_candidates_dash = []
    validated_dash = []
    rejected_dash = []

    for c in all_dash_candidates:
        name = c.get("name", "")
        status = c.get("status", "draft")
        created_at = parse_iso_date(c.get("created_at", ""))
        last_updated = parse_iso_date(c.get("last_updated", ""))

        if is_in_week(created_at, monday, next_monday):
            new_candidates_dash.append({
                "name": name,
                "status": status,
                "created_at": c.get("created_at", ""),
                "trigger": c.get("trigger", "")[:120] if c.get("trigger") else "",
                "scores": c.get("scores", {}),
                "source": "skill-candidates.md",
            })

        if status == "promoted" and is_in_week(last_updated, monday, next_monday):
            validated_dash.append({
                "name": name,
                "status": status,
                "promoted_at": c.get("last_updated", ""),
                "scores": c.get("scores", {}),
                "source": "skill-candidates.md",
            })
        elif status == "rejected" and is_in_week(last_updated, monday, next_monday):
            rejected_dash.append({
                "name": name,
                "status": status,
                "rejected_at": c.get("last_updated", ""),
                "source": "skill-candidates.md",
            })

    # ── 4b. Proposals: new / applied / rejected (from workshop) ──────
    new_proposals = []
    applied_proposals = []
    rejected_proposals = []
    stale_proposals = []

    # Deduplicate by skill name for counting
    applied_skill_names = set()
    rejected_skill_names = set()
    pending_skill_names = set()

    for p in all_proposals:
        pid = p.get("id", "")
        status = p.get("status", "")
        action = p.get("action", "")
        desc = p.get("description", "")
        date_str = p.get("date", "")
        skill_name = extract_skill_name(pid)

        in_week = is_in_week_str(date_str, monday, next_monday)

        entry = {
            "id": pid,
            "skill": skill_name,
            "status": status,
            "action": action,
            "description": desc,
            "date": date_str,
        }

        if status == "pending" and in_week:
            new_proposals.append(entry)
            pending_skill_names.add(skill_name)
        elif status == "applied" and in_week:
            applied_proposals.append(entry)
            applied_skill_names.add(skill_name)
        elif status == "rejected" and in_week:
            rejected_proposals.append(entry)
            rejected_skill_names.add(skill_name)
        elif status == "stale" and in_week:
            stale_proposals.append(entry)

    # ── 5. Decisions ─────────────────────────────────────────────────
    week_decisions = []
    for d in latest_decisions:
        at = parse_iso_date(d.get("at", ""))
        if is_in_week(at, monday, next_monday):
            week_decisions.append(d)

    # ── 6. Reflections summary ───────────────────────────────────────
    reflection_summary = {
        "count": len(week_reflections),
        "by_session_type": {},
        "by_confidence": {},
    }
    for r in week_reflections:
        stype = r.get("session_type", "manual")
        conf = str(r.get("confidence", ""))
        reflection_summary["by_session_type"][stype] = \
            reflection_summary["by_session_type"].get(stype, 0) + 1
        reflection_summary["by_confidence"][conf] = \
            reflection_summary["by_confidence"].get(conf, 0) + 1

    # ── 7. Regression risk detection ─────────────────────────────────
    regression_risks = detect_regression_risks(
        all_dash_candidates, all_proposals, monday, next_monday
    )

    # ── 8. Summary counts ────────────────────────────────────────────
    summary = {
        # Candidates
        "new_candidates_dash": len(new_candidates_dash),
        "validated_dash": len(validated_dash),
        "rejected_dash": len(rejected_dash),
        # Proposals
        "new_proposals": len(new_proposals),
        "applied_proposals": len(applied_proposals),
        "rejected_proposals": len(rejected_proposals),
        "stale_proposals": len(stale_proposals),
        # Combined totals
        "new_total": len(new_candidates_dash) + len(new_proposals),
        "validated_total": len(validated_dash) + len(applied_proposals),
        "rejected_total": len(rejected_dash) + len(rejected_proposals),
        "regression_risks": len(regression_risks),
        "reflections": len(week_reflections),
        "decisions": len(week_decisions),
        # Unique skill names
        "applied_unique_skills": len(applied_skill_names),
        "rejected_unique_skills": len(rejected_skill_names),
        "pending_unique_skills": len(pending_skill_names),
    }

    return {
        "generated_at": now_local().isoformat(),
        "week": week_label,
        "week_start": monday.isoformat(),
        "week_end": next_monday.isoformat(),
        "summary": summary,
        "new_candidates": new_candidates_dash,
        "new_proposals": new_proposals,
        "validated": validated_dash,
        "applied_proposals": applied_proposals,
        "rejected": rejected_dash,
        "rejected_proposals": rejected_proposals,
        "stale_proposals": stale_proposals,
        "regression_risks": regression_risks,
        "reflections": reflection_summary,
        "decisions": week_decisions,
        "dashboard_snapshot": {
            "candidates_by_status": dashboard.get("candidates_by_status", {}),
            "all_candidates_count": len(all_dash_candidates),
            "pending_proposals_count": dashboard.get("pending_proposals_count", 0),
        },
    }


def detect_regression_risks(all_candidates: list[dict],
                             all_proposals: list[dict],
                             monday: datetime, next_monday: datetime) -> list[dict]:
    """Detect regression risk signals combining both data sources.

    Signals:
      1. Applied skill now has a new pending proposal → regression attempt
      2. Applied skill has stale proposals → unmaintained risk
      3. Stale draft candidate with high repeat_count → rotting signal
      4. Multiple stale proposals for same skill → systemic issue
    """
    risks = []
    now = now_local()

    # ── Build lookup maps ───────────────────────────────────────────
    # Applied skills (from proposals)
    applied_skills = set()
    for p in all_proposals:
        if p.get("status") == "applied":
            applied_skills.add(extract_skill_name(p.get("id", "")))

    # Pending proposals grouped by skill name
    pending_by_skill: dict[str, list[dict]] = {}
    for p in all_proposals:
        if p.get("status") == "pending":
            name = extract_skill_name(p.get("id", ""))
            pending_by_skill.setdefault(name, []).append(p)

    # Stale proposals grouped by skill name
    stale_by_skill: dict[str, list[dict]] = {}
    for p in all_proposals:
        if p.get("status") == "stale":
            name = extract_skill_name(p.get("id", ""))
            stale_by_skill.setdefault(name, []).append(p)

    # ── Signal 1: Applied skill has new pending proposals ────────────
    for skill_name, pending_list in pending_by_skill.items():
        if skill_name in applied_skills:
            risks.append({
                "type": "applied_skill_re_proposed",
                "name": skill_name,
                "status": "applied+pending",
                "signal": f"已 applied 的 skill 有 {len(pending_list)} 个新 pending proposal",
                "detail": ", ".join(p.get("id", "")[:40] for p in pending_list),
                "recommendation": "审查新 proposal 是否修复了已知问题还是引入了退化",
                "severity": "high",
            })

    # ── Signal 2: Applied skill has stale proposals → unmaintained ──
    for skill_name, stale_list in stale_by_skill.items():
        if skill_name in applied_skills:
            risks.append({
                "type": "applied_skill_stale_proposals",
                "name": skill_name,
                "status": "applied+stale",
                "signal": f"已 applied 的 skill 有 {len(stale_list)} 个 stale proposal",
                "detail": ", ".join(p.get("id", "")[:40] for p in stale_list),
                "recommendation": "检查 stale proposal 是否包含未合并的关键修复",
                "severity": "medium",
            })

    # ── Signal 3: Multiple stale proposals for same skill ────────────
    for skill_name, stale_list in stale_by_skill.items():
        if len(stale_list) >= 2:
            risks.append({
                "type": "multiple_stale_proposals",
                "name": skill_name,
                "status": "stale",
                "signal": f"{len(stale_list)} 个 stale proposals 针对同一 skill",
                "detail": ", ".join(p.get("id", "")[:40] for p in stale_list),
                "recommendation": "评估是否需要合并后重新提案，或清理过期 proposal",
                "severity": "medium",
            })

    # ── Signal 4: Stale draft candidates with high signal ────────────
    for c in all_candidates:
        name = c.get("name", "")
        status = c.get("status", "draft")
        scores = c.get("scores", {})
        overall = scores.get("overall", 0)
        repeat = scores.get("repeat_count", {}).get("score", 0)
        created_at = parse_iso_date(c.get("created_at", ""))

        if status == "draft" and repeat >= 50 and created_at and created_at < monday:
            risks.append({
                "type": "stale_high_signal_candidate",
                "name": name,
                "status": status,
                "signal": f"repeat_count={repeat}, overall={overall:.0f} — 高频 pattern 未晋级",
                "detail": f"创建于 {dt_to_date(created_at)}，距今 {(now - created_at).days} 天",
                "recommendation": "考虑提升为正式候选或标记为 rejected",
                "severity": "medium",
            })

        # Signal 5: Draft candidate created >60 days ago, never updated
        if status == "draft" and created_at and (now - created_at).days > 60:
            last_updated = parse_iso_date(c.get("last_updated", ""))
            if last_updated is None:
                risks.append({
                    "type": "stale_unmaintained_candidate",
                    "name": name,
                    "status": status,
                    "signal": f"创建 {(now - created_at).days} 天未更新",
                    "detail": f"创建于 {dt_to_date(created_at)}",
                    "recommendation": "清理或评估是否需要保留",
                    "severity": "low",
                })

    # ── Deduplicate by (type, name) ──────────────────────────────────
    seen = set()
    deduped = []
    for r in risks:
        key = (r["type"], r["name"])
        if key not in seen:
            seen.add(key)
            deduped.append(r)

    severity_order = {"high": 0, "medium": 1, "low": 2}
    deduped.sort(key=lambda r: (severity_order.get(r.get("severity", "low"), 2), r.get("name", "")))

    return deduped


# ── Markdown formatting ────────────────────────────────────────────────────

def format_markdown_report(report: dict) -> str:
    """Render the weekly report as a human-readable Markdown document."""
    s = report["summary"]
    lines = [
        f"# 📊 V 每周自进化报告",
        f"",
        f"**报告周期**：{report['week']}",
        f"**生成时间**：{report['generated_at'][:19]}",
        f"",
        f"## 📈 概览",
        f"",
        f"| 维度 | 数量 | 说明 |",
        f"|------|------|------|",
        f"| 🆕 新增候选 | {s['new_total']} | 新 candidates({s['new_candidates_dash']}) + 新 proposals({s['new_proposals']}) |",
        f"| ✅ 已验证 | {s['validated_total']} | promoted({s['validated_dash']}) + applied({s['applied_proposals']}), "
        f"{s['applied_unique_skills']} 个独立 skill |",
        f"| ❌ 被拒绝 | {s['rejected_total']} | rejected candidates({s['rejected_dash']}) + rejected proposals({s['rejected_proposals']}) |",
        f"| 🟠 变陈旧 | {s['stale_proposals']} | 本周标记为 stale 的 proposals |",
        f"| ⚠️ 回归风险 | {s['regression_risks']} | 此前稳定的 skills 出现退化信号 |",
        f"| 💭 Reflections | {s['reflections']} | 本周捕获的 reflection 条目 |",
        f"| 📋 Decisions | {s['decisions']} | 本周 daily-review 决策 |",
        f"",
    ]

    # ── Section 1: New (candidates + proposals) ──────────────────────
    lines.append("## 🆕 新增（本周新创建）")
    lines.append("")

    if report["new_candidates"]:
        lines.append("### Skill Candidates (skill-candidates.md)")
        lines.append("")
        for c in report["new_candidates"]:
            scores = c.get("scores", {})
            overall = scores.get("overall", "—")
            lines.append(f"- **{c['name']}** (状态: {c['status']}, 评分: {overall})")
            if c.get("trigger"):
                lines.append(f"  > 触发: {c['trigger'][:100]}")
        lines.append("")

    if report["new_proposals"]:
        lines.append(f"### Skill Workshop Proposals ({len(report['new_proposals'])} 个)")
        lines.append("")
        # Group by action
        create_props = [p for p in report["new_proposals"] if p["action"] == "create"]
        update_props = [p for p in report["new_proposals"] if p["action"] == "update"]
        if create_props:
            lines.append(f"**新建 ({len(create_props)}):**")
            for p in create_props:
                lines.append(f"- `{p['skill']}` — {p['description']}" if p.get("description") else f"- `{p['skill']}`")
            lines.append("")
        if update_props:
            lines.append(f"**更新 ({len(update_props)}):**")
            for p in update_props:
                lines.append(f"- `{p['skill']}` — {p['description']}" if p.get("description") else f"- `{p['skill']}`")
            lines.append("")

    if not report["new_candidates"] and not report["new_proposals"]:
        lines.append("_本周无新增_")
        lines.append("")

    # ── Section 2: Validated (applied) ───────────────────────────────
    lines.append("## ✅ 已验证 / 已应用")
    lines.append("")

    if report["validated"]:
        lines.append("### Candidates promoted")
        lines.append("")
        for c in report["validated"]:
            scores = c.get("scores", {})
            overall = scores.get("overall", "—")
            lines.append(f"- **{c['name']}** → `{c['status']}` (评分: {overall})")
        lines.append("")

    if report["applied_proposals"]:
        lines.append(f"### Proposals applied ({len(report['applied_proposals'])} 个)")
        lines.append("")
        # Group by skill
        by_skill: dict[str, list] = {}
        for p in report["applied_proposals"]:
            by_skill.setdefault(p["skill"], []).append(p)
        for skill_name, props in sorted(by_skill.items()):
            actions = [p["action"] for p in props]
            lines.append(f"- **{skill_name}** ({', '.join(actions)})")
        lines.append("")

    if not report["validated"] and not report["applied_proposals"]:
        lines.append("_本周无验证/应用记录_")
        lines.append("")

    # ── Section 3: Rejected ─────────────────────────────────────────
    lines.append("## ❌ 被拒绝")
    lines.append("")

    if report["rejected"]:
        lines.append("### Candidates rejected")
        lines.append("")
        for c in report["rejected"]:
            lines.append(f"- **{c['name']}** → `{c['status']}` ({c.get('rejected_at', '')})")
        lines.append("")

    if report["rejected_proposals"]:
        lines.append(f"### Proposals rejected ({len(report['rejected_proposals'])} 个)")
        lines.append("")
        for p in report["rejected_proposals"]:
            lines.append(f"- `{p['skill']}` [{p['action']}] — {p.get('description', '')}")
        lines.append("")

    if not report["rejected"] and not report["rejected_proposals"]:
        lines.append("_本周无拒绝记录_")
        lines.append("")

    # ── Section 3b: Stale ───────────────────────────────────────────
    if report["stale_proposals"]:
        lines.append("## 🟠 变陈旧（Stale）")
        lines.append("")
        for p in report["stale_proposals"]:
            lines.append(f"- `{p['skill']}` [{p['action']}] — {p.get('description', '')}")
        lines.append("")

    # ── Section 4: Regression risks ──────────────────────────────────
    lines.append("## ⚠️ 回归风险")
    lines.append("")
    if report["regression_risks"]:
        for r in report["regression_risks"]:
            icon = {"high": "🔴", "medium": "🟡", "low": "🟢"}.get(r.get("severity", "low"), "⚪")
            lines.append(f"- {icon} **{r['name']}** ({r['type']})")
            lines.append(f"  > {r['signal']}")
            if r.get("detail"):
                lines.append(f"  > {r['detail']}")
            lines.append(f"  > 建议: {r['recommendation']}")
        lines.append("")
    else:
        lines.append("_无回归风险信号_")
        lines.append("")

    # ── Section 5: Reflections ───────────────────────────────────────
    lines.append("## 💭 Reflection 活动")
    lines.append("")
    ref = report["reflections"]
    lines.append(f"- 总条目: {ref['count']}")
    if ref.get("by_session_type"):
        lines.append(f"- 按类型: {', '.join(f'{k}={v}' for k, v in ref['by_session_type'].items())}")
    if ref.get("by_confidence"):
        lines.append(f"- 按置信度: {', '.join(f'{k}={v}' for k, v in ref['by_confidence'].items())}")
    lines.append("")

    # ── Section 6: Decisions ─────────────────────────────────────────
    if report["decisions"]:
        lines.append("## 📋 本周决策")
        lines.append("")
        for d in report["decisions"][:10]:
            kind = d.get("kind", "—")
            title = d.get("title", "—")
            note_str = d.get("note", "")
            lines.append(f"- [{kind}] {title}")
            if note_str.strip():
                lines.append(f"  > {note_str[:120]}")
        lines.append("")

    # ── Section 7: System snapshot ───────────────────────────────────
    ds = report["dashboard_snapshot"]
    lines.append("## 📊 系统快照")
    lines.append("")
    cbs = ds.get("candidates_by_status", {})
    lines.append(f"- Skill Candidates: "
                 f"draft={cbs.get('draft',0)}, shadow={cbs.get('shadow',0)}, "
                 f"promoted={cbs.get('promoted',0)}, rejected={cbs.get('rejected',0)}")
    lines.append(f"- Total Candidates (dashboard): {ds.get('all_candidates_count', 0)}")
    lines.append(f"- Pending Proposals (dashboard): {ds.get('pending_proposals_count', 0)}")
    lines.append("")

    # ── V-Learning-Loop status ───────────────────────────────────────
    lines.append("## 🔄 V-Learning-Loop 阶段状态")
    lines.append("")
    lifecycle_phases = [
        ("[1] Reflection 捕获", "✅", "heartbeat 自动触发, reflection-capture.py"),
        ("[2] Pattern 检测", "✅", "heartbeat 自动分析, reflection-analyzer.py"),
        ("[3] Candidate 管理", "✅", "自动创建 + dashboard 评分 + promotion 阈值"),
        ("[4] Proposal 生成", "⚠️", "SkillOpt 路径已覆盖, 通用 candidate→proposal 缺口"),
        ("[5] Validation 执行", "⚠️", "preflight-proposal-check.py 可用, 但未强制 hook"),
        ("[6] Apply 门禁", "🔒", "Tianyi 审批, pre-apply-summary 开发中"),
    ]
    lines.append("| 阶段 | 状态 | 说明 |")
    lines.append("|------|------|------|")
    for phase, status, desc in lifecycle_phases:
        lines.append(f"| {phase} | {status} | {desc} |")
    lines.append("")

    # ── Footer ───────────────────────────────────────────────────────
    lines.append("---")
    lines.append(f"_由 scripts/weekly-evolution-report.py 自动生成 | "
                 f"Self Evolving V · V-Learning-Loop_")

    return "\n".join(lines)


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Self Evolving V 每周进化报告",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--week", type=str, default=None,
                        help="Week start date (YYYY-MM-DD, Monday). Default: current week Monday.")
    parser.add_argument("--json", action="store_true",
                        help="Output as JSON instead of Markdown.")
    parser.add_argument("--output", "-o", type=str, default=None,
                        help="Write report to file instead of stdout.")
    parser.add_argument("--no-color", action="store_true", help="Plain text output.")

    args = parser.parse_args()

    monday, next_monday = week_boundaries(args.week)
    report = build_weekly_report(monday, next_monday)

    if args.json:
        output = json.dumps(report, indent=2, ensure_ascii=False, default=str)
    else:
        output = format_markdown_report(report)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
        print(f"Report written to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
