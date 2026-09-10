#!/usr/bin/env python3
"""dc_shadow_eval.py — LLM Advisor 影子评估与压缩（不新增 Provider/执行能力）

职责：
  1. 构造覆盖多场景的 plan（邮件/回复/展前/展中/展后/无任务/数据异常），跑 TemplateAdvisor
     与 LLMAdvisor 影子对照，累计真实影子样本。
  2. 生成「模板 vs LLM 匿名并排」的人工评估 review 文件（A/B 随机匿名 + 独立 key）。
  3. 汇总：Guard 拦截率、fallback 比例、Token/延迟、压缩统计、与模板排序差异。
  4. 扫描产物中是否含 API Key / 请求头 / 未脱敏 PII。

约束：只读 plan、只写 evals；不展示 LLM 建议、不执行 Proposal、不接自动发送。
"""
from __future__ import annotations

import argparse
import json
import random
import re
import statistics
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from dc_daily_brief import BriefContext  # noqa: E402
from dc_daily_pipeline import run_morning_brief  # noqa: E402
from dc_email_provider import template_advise  # noqa: E402
from dc_llm_advisor import (  # noqa: E402
    LLMAdvisor, ShadowRunner, snapshot_from_plan, HTTPLLMClient, DEFAULT_MAX_TOKENS,
    serialize_advice, MAX_ADVICES, MAX_CLAIM_CHARS, MAX_RECOMMENDATION_CHARS,
)

SCENARIOS = ("email", "reply", "pre_exhibition", "during", "post", "no_task", "data_anomaly")
COMPANY = "152600996207"
TENANT = "meorient"


# ── 场景数据（复用既有 Store 形态，不改 Provider）───────────────
def _iso(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


class EmailStore:
    def __init__(self, outbounds):
        self._o = outbounds

    def list_outbound_records(self, company_id=None):
        return self._o

    def list_inbound_records(self, company_id=None):
        return []


class OppStore:
    def __init__(self, leads=None, interactions=None):
        self._l, self._i = leads or [], interactions or []

    def list_opportunities(self, company_id):
        return self._l

    def list_interactions(self, company_id):
        return self._i


class ExhStore:
    def __init__(self, meta, invitations=None, sync=None):
        self._m, self._inv, self._sync = meta, invitations or [], sync

    def read_meta(self, cid):
        return self._m

    def list_invitations(self, cid, exh_id=""):
        return self._inv

    def list_interactions(self, cid):
        return []

    def read_sync(self, cid, exh_id=""):
        return self._sync if self._sync is not None else {}


def _email_outbounds(n=6, days_ago=3):
    return [{"direction": "outbound", "provider_status": "delivered",
             "recipients": [f"buyer{i}@x.com"], "resend_id": f"re_{i}",
             "sent_at": _iso(days_ago), "created_at": _iso(days_ago), "touch_number": 0,
             "company_id": COMPANY, "subject": "展会邀请"} for i in range(n)]


def _lead(cdp, company, contact, stage, grade="B", status="active", policy="active",
          next_action="", due=""):
    return {"company": company, "company_cdp_id": cdp, "contact": contact, "stage": stage,
            "match_grade": grade, "opportunity_status": status, "contact_policy": policy,
            "next_action": next_action, "due": due}


def _exh_meta(stage, start, end, understanding_done=False, plan_done=False):
    return {"exhibition_stage": stage, "understanding_done": understanding_done,
            "plan_done": plan_done,
            "exhibitions": [{"exhibition_id": "E1", "name": "巴西展", "start": start, "end": end,
                             "timezone": "America/Sao_Paulo"}]}


def _inv(cdp, name, checkin=0, meeting=0, state=0):
    return {"companyCdpId": cdp, "companyName": name, "exhibitionId": "E1",
            "sendTime": _iso(3), "isCheckIn": checkin, "isMeeting": meeting,
            "inviationState": state, "email": f"{cdp}@x.com"}


def _d(delta):
    return (datetime.now(timezone.utc) + timedelta(days=delta)).date().isoformat()


def scenario_stores(name: str):
    if name == "email":
        return EmailStore(_email_outbounds()), None, None
    if name == "reply":
        leads = [_lead("C001", "Reply Co", "buyer0@x.com", "已回复"),
                 _lead("C002", "Overdue Co", "buyer1@x.com", "需求明确",
                       next_action="发送报价", due=_iso(1))]
        inter = [{"interaction_id": "it_r", "customer_id": "C001", "channel": "email",
                  "direction": "inbound", "occurred_at": _iso(1), "subject": "Re: 邀请"},
                 {"interaction_id": "it_o", "customer_id": "C002", "channel": "email",
                  "direction": "outbound", "occurred_at": _iso(2), "subject": "Re: 邀请"}]
        return EmailStore(_email_outbounds()), OppStore(leads, inter), None
    if name == "pre_exhibition":
        return (EmailStore([]), None,
                ExhStore(_exh_meta("planning", _d(10), _d(12)), [],
                         {"exhibition_id": "E1", "status": "completed_empty",
                          "synced_through": "2030-01-01T00:00:00Z", "records": 0}))
    if name == "during":
        invs = [_inv("C1", "Casa Outdoor", checkin=1, meeting=1),
                _inv("C2", "Hotel BR", checkin=1, meeting=0), _inv("C3", "Retail SA", checkin=3)]
        return (EmailStore([]), None,
                ExhStore(_exh_meta("live", _d(-1), _d(1)), invs,
                         {"exhibition_id": "E1", "status": "completed",
                          "synced_through": "2030-01-01T00:00:00Z", "records": 3}))
    if name == "post":
        invs = [_inv("C1", "Casa Outdoor", checkin=1, meeting=1),
                _inv("C2", "Hotel BR", checkin=3), _inv("C3", "Retail SA", checkin=3)]
        return (EmailStore([]), None,
                ExhStore(_exh_meta("followup", _d(-5), _d(-3)), invs,
                         {"exhibition_id": "E1", "status": "completed",
                          "synced_through": "2030-01-01T00:00:00Z", "records": 3}))
    if name == "no_task":
        return (EmailStore([]), None,
                ExhStore(_exh_meta("profiling", _d(10), _d(12), understanding_done=True), [],
                         {"exhibition_id": "E1", "status": "completed_empty",
                          "synced_through": "2030-01-01T00:00:00Z", "records": 0}))
    if name == "data_anomaly":
        invs = [_inv("C1", "Casa Outdoor", checkin=1)]
        return (EmailStore([]), None,
                ExhStore(_exh_meta("live", _d(-1), _d(1)), invs, None))  # 无 sync → 数据质量风险
    raise ValueError(f"unknown scenario {name}")


def build_snapshot(name: str, day: int):
    now = datetime.now(timezone.utc).isoformat()
    date = (datetime.now(timezone.utc) - timedelta(days=day)).date().isoformat()
    if name == "no_task":
        # 无任务：空候选（模板无建议、LLM 允许空数组）
        from dc_daily_advisor import build_snapshot as _bs
        snap = _bs(tenant=TENANT, company=COMPANY, report_type="morning", date=date,
                   tz="Asia/Shanghai", as_of=now, exhibition_stage="followup",
                   preferences={}, candidates=())
        return snap, {"actions": [], "context": []}
    es, os_, xs = scenario_stores(name)
    ctx = BriefContext(tenant=TENANT, company=COMPANY, report_type="morning", date=date,
                       tz="Asia/Shanghai", as_of=now, window_start=now, window_end=now)
    base = Path(tempfile.mkdtemp(prefix="dc-shadow-eval-"))
    r = run_morning_brief(ctx, base, email_store=es, opp_store=os_, exh_store=xs)
    plan = r["plan"]
    snap = snapshot_from_plan(plan, tenant=TENANT, company=COMPANY, report_type="morning",
                              date=date, tz="Asia/Shanghai", as_of=now,
                              exhibition_stage="live", preferences={"revised": {"tone": "short"}})
    return snap, plan


# ── 采样 ────────────────────────────────────────────────────
def collect_samples(scenarios, days, advisor, out_dir: Path, force: bool = False) -> list[dict]:
    samples = []
    eval_base = out_dir / "_evals"
    for day in range(days):
        for name in scenarios:
            snap, plan = build_snapshot(name, day)
            tmpl = template_advise(snap)
            rec = ShadowRunner(eval_base / name / str(day), advisor).run(snap, tmpl, force=force)
            samples.append({
                "scenario": name, "day": day, "snapshot_hash": rec["snapshot_hash"],
                "candidates": len(snap.candidates),
                "template": [serialize_advice(a) for a in tmpl],
                "llm": rec,
            })
    return samples


# ── 匿名并排 review（需求 7）────────────────────────────────
def write_review(out_dir: Path, samples: list[dict], seed: int = 0) -> dict:
    rng = random.Random(seed)
    lines = ["# 模板 vs LLM 匿名并排评估（人工填写）", "",
             "> 每行 A/B 随机匿名（一为模板、一为 LLM，顺序随样本随机）。",
             "> 评估维度：事实准确 / 增量价值 / 优先级 / 可执行性 / 克制性 / 简洁度；",
             "> 末列填：更好 / 持平 / 更差（指另一侧相对本侧）。key 见 review-key.json。", ""]
    key = {}
    for i, s in enumerate(samples, 1):
        llm = s["llm"]
        tmpl_txt = "；".join(f"{a['claim']}｜{a['recommendation']}" for a in s["template"]) or "（无）"
        llm_txt = "；".join(f"{a['claim']}｜{a['recommendation']}" for a in llm["advices"]) \
            if llm["ok"] else f"（fallback：{llm['fallback_reason']}）"
        llm_first = rng.random() < 0.5
        a_txt, b_txt = (llm_txt, tmpl_txt) if llm_first else (tmpl_txt, llm_txt)
        key[f"sample_{i:03d}"] = {"scenario": s["scenario"], "day": s["day"],
                                  "A": "llm" if llm_first else "template",
                                  "B": "template" if llm_first else "llm"}
        lines += [f"## sample_{i:03d} · {s['scenario']} · day{s['day']} "
                  f"（候选 {s['candidates']}）",
                  f"- A：{a_txt}",
                  f"- B：{b_txt}",
                  "- 事实准确：/  增量价值：/  优先级：/  可执行性：/  克制性：/  简洁度：",
                  "- 结论：A ___ B（更好/持平/更差）", ""]
    (out_dir / "review.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out_dir / "review-key.json").write_text(json.dumps(key, ensure_ascii=False, indent=2),
                                             encoding="utf-8")
    return key


# ── 汇总（需求 8）──────────────────────────────────────────
def _n(xs):
    return round(statistics.fmean(xs), 1) if xs else 0.0


def summarize(samples: list[dict]) -> dict:
    total = len(samples)
    ok = [s for s in samples if s["llm"]["ok"]]
    fallback = [s for s in samples if s["llm"]["fallback"]]
    reasons: dict = {}
    for s in fallback:
        reasons[s["llm"]["fallback_reason"]] = reasons.get(s["llm"]["fallback_reason"], 0) + 1
    guard_hits = sum(1 for s in samples if s["llm"]["guard_violations"])
    lat = [s["llm"]["latency_ms"] for s in ok]
    itok = [s["llm"]["input_tokens"] for s in ok]
    otok = [s["llm"]["output_tokens"] for s in ok]
    order_diff = sum(1 for s in ok if s["llm"]["order_diff"])
    by_scenario: dict = {}
    for s in samples:
        b = by_scenario.setdefault(s["scenario"], {"n": 0, "ok": 0, "fallback": 0})
        b["n"] += 1
        b["ok"] += 1 if s["llm"]["ok"] else 0
        b["fallback"] += 1 if s["llm"]["fallback"] else 0
    llm_advice_counts = [len(s["llm"]["advices"]) for s in ok]
    return {
        "samples": total,
        "llm_ok": len(ok),
        "fallback": len(fallback),
        "fallback_ratio": round(len(fallback) / total, 3) if total else 0,
        "fallback_reasons": reasons,
        "guard_interception": guard_hits,
        "guard_interception_ratio": round(guard_hits / total, 3) if total else 0,
        "order_diff_samples": order_diff,
        "latency_ms_avg": _n(lat),
        "input_tokens_avg": _n(itok),
        "output_tokens_avg": _n(otok),
        "llm_advices_avg": _n(llm_advice_counts),
        "max_advices_ok": max(llm_advice_counts) if llm_advice_counts else 0,
        "by_scenario": by_scenario,
        # 人工评估统计位（填写 review-key.json 后回填）
        "human_tally": {"llm_better": None, "equal": None, "llm_worse": None,
                        "note": "见 review.md 人工填写后统计"},
    }


# ── 敏感信息扫描（需求 9）────────────────────────────────────
_SECRET_PATTERNS = [
    ("api_key", re.compile(r"sk-[A-Za-z0-9_\-]{12,}|AIza[0-9A-Za-z_\-]{20,}|xai-[A-Za-z0-9]{16,}")),
    ("auth_header", re.compile(r"authorization\s*[:=]|bearer\s+[A-Za-z0-9._\-]{10,}",
                               re.IGNORECASE)),
    ("secret_field", re.compile(r'"(api[_-]?key|access[_-]?token|password|secret)"\s*:', re.I)),
]
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}")
# 允许的合成邮箱（示例/测试域）
_ALLOWED_EMAIL_RE = re.compile(r"@(x\.com|example|example\.com|y\.com|x\.example)$", re.I)


def scan_artifacts(root: Path) -> dict:
    findings: list[dict] = []
    emails: set[str] = set()
    for p in sorted(Path(root).rglob("*")):
        if not p.is_file() or p.suffix not in (".json", ".md", ".jsonl", ".txt"):
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for kind, pat in _SECRET_PATTERNS:
            if pat.search(text):
                findings.append({"file": str(p.relative_to(root)), "kind": kind})
        for m in _EMAIL_RE.findall(text):
            emails.add(m.lower())
    unallowed = sorted(e for e in emails if not _ALLOWED_EMAIL_RE.search(e))
    return {
        "files_scanned": sum(1 for p in Path(root).rglob("*") if p.is_file()),
        "secret_findings": findings,
        "secret_clean": not findings,
        "emails_seen": sorted(emails),
        "unmasked_pii": unallowed,
        "pii_clean": not unallowed,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="LLM 影子评估与压缩")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sample")
    s.add_argument("--out", required=True)
    s.add_argument("--scenarios", default=",".join(SCENARIOS))
    s.add_argument("--days", type=int, default=3)
    s.add_argument("--real", action="store_true")
    s.add_argument("--model", default=None)
    s.add_argument("--force", action="store_true")

    sc = sub.add_parser("scan")
    sc.add_argument("--dir", required=True)

    args = ap.parse_args()
    if args.cmd == "scan":
        print(json.dumps(scan_artifacts(Path(args.dir)), ensure_ascii=False, indent=2))
    else:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        model = args.model or "openai/gpt-4o-mini"
        client = HTTPLLMClient(model=model, timeout=60, max_tokens=DEFAULT_MAX_TOKENS) if args.real else None
        advisor = LLMAdvisor(client, model=model, max_tokens=DEFAULT_MAX_TOKENS) if args.real else None
        scenarios = [x for x in args.scenarios.split(",") if x]
        samples = collect_samples(scenarios, args.days, advisor, out, force=args.force)
        (out / "samples.jsonl").write_text(
            "\n".join(json.dumps(s, ensure_ascii=False) for s in samples), encoding="utf-8")
        write_review(out, samples)
        summary = summarize(samples)
        (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2),
                                          encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
