#!/usr/bin/env python3
"""generate_sample.py — 生成 OpportunityProvider 真实早晚报样例（证据用）

场景（端到端验收）：
  - 68 家邮件待跟进（delivered + 超过观察期仍无回复）；
  - 其中 3 家有真实商机证据：买家回复 / 逾期 next_step / 报价承诺；
  - 剩余 65 家保留为「待分层批量跟进」；
  - 早报 Top3 = 3 个有证据的客户级 action（不按读取顺序）；
  - 晚报按真实 followup_sent / quote_sent / sample_sent 事件核销。

用法：python3 docs/daily-brief/generate_sample.py [--out docs/daily-brief]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MIO = HERE.parents[1] / "packages" / "dealclaw-agent" / "payload" / "work" / "mio-api"
sys.path.insert(0, str(MIO))

from dc_daily_brief import BriefContext  # noqa: E402
from dc_daily_pipeline import run_morning_brief, run_evening_brief  # noqa: E402

COMPANY = "152600996207"
COMPANY_NAME = "途达（示例）"
DATE = "2026-09-10"


def iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


class EmailStore:
    def __init__(self, outbounds, inbounds=None):
        self._out, self._in = outbounds, inbounds or []

    def list_outbound_records(self, company_id=None):
        return self._out

    def list_inbound_records(self, company_id=None):
        return self._in


class OppStore:
    def __init__(self, leads, interactions):
        self._leads, self._inter = leads, interactions

    def list_opportunities(self, company_id):
        return self._leads

    def list_interactions(self, company_id):
        return self._inter


def ctx(report_type):
    return BriefContext(tenant="meorient", company=COMPANY, report_type=report_type,
                        date=DATE, tz="Asia/Shanghai", as_of=iso_days_ago(0),
                        window_start=iso_days_ago(0), window_end=iso_days_ago(0))


def scenario():
    outbounds = [{"direction": "outbound", "provider_status": "delivered",
                  "recipients": [f"buyer{i}@x.com"], "resend_id": f"re_{i}",
                  "sent_at": iso_days_ago(3), "created_at": iso_days_ago(3),
                  "touch_number": 0, "company_id": COMPANY,
                  "campaign_id": "brazil-expo", "subject": "巴西展邀请"}
                 for i in range(68)]
    leads = [
        {"company": "Reply Co", "company_cdp_id": "C001", "website": "reply.example",
         "contact": "Maria|buyer0@x.com|", "stage": "已回复", "match_grade": "B",
         "opportunity_status": "active", "contact_policy": "active"},
        {"company": "Overdue Co", "company_cdp_id": "C002", "website": "overdue.example",
         "contact": "buyer1@x.com", "stage": "需求明确", "match_grade": "B",
         "opportunity_status": "active", "contact_policy": "active",
         "next_action": "发送正式报价", "due": iso_days_ago(1)},
        {"company": "Quote Co", "company_cdp_id": "C003", "website": "quote.example",
         "contact": "buyer2@x.com", "stage": "报价中", "match_grade": "A",
         "opportunity_status": "active", "contact_policy": "active"},
    ]
    interactions = [
        {"interaction_id": "it_reply", "customer_id": "C001", "channel": "email",
         "direction": "inbound", "occurred_at": iso_days_ago(1), "subject": "Re: 巴西展邀请"},
        {"interaction_id": "it_overdue", "customer_id": "C002", "channel": "email",
         "direction": "outbound", "occurred_at": iso_days_ago(2), "subject": "Re: 巴西展邀请"},
        {"interaction_id": "it_quote", "customer_id": "C003", "channel": "email",
         "direction": "outbound", "occurred_at": iso_days_ago(1), "subject": "Re: 巴西展邀请",
         "signals": [{"type": "quote_request", "value": "询价",
                      "evidence_text": "please send your best quotation",
                      "origin": "agent_extracted", "confidence": 0.9}]},
    ]
    return EmailStore(outbounds), OppStore(leads, interactions)


def render_morning(plan, layering):
    by_key = {a["action_key"]: a for a in plan["actions"]}
    top = [by_key[k] for k in plan["top_n_action_keys"]]
    batch = [a for a in plan["actions"] if a["source"] == "email"]
    lines = [f"# 早报 · {DATE} · {COMPANY_NAME}", "",
             "## Top3 优先跟进（有商机证据，不按读取顺序）"]
    for i, a in enumerate(top, 1):
        lines.append(f"{i}. [{a['priority']}] {a['title']}｜{a['reason']}")
    lines += ["", "## 待分层批量跟进"]
    for a in batch:
        lines.append(f"- {a['title']}｜{a['reason']}（{a['detail']['overdue_count']} 家）")
    ctx_items = plan.get("context", [])
    lines += ["", "## 指标与事实"]
    for c in ctx_items:
        lines.append(f"- {c['title']}")
    lines += ["", "## 分层",
              f"- 客户级 action 覆盖 {len(layering['deducted_emails'])} 家："
              f"{'、'.join(layering['deducted_emails'])}",
              f"- 扣除后剩余批量跟进 {layering['remaining_count']} 家"]
    return "\n".join(lines) + "\n"


def render_evening(review, by_key):
    lines = [f"# 晚报 · {DATE} · {COMPANY_NAME}", "", "## 核销结果（只依据真实事件）"]
    for rv in review["reviews"]:
        a = by_key.get(rv["action_key"], {})
        lines.append(f"- {a.get('title', rv['action_key'])}：**{rv['status']}**")
    if review.get("warnings"):
        lines += ["", "## 警告"] + [f"- {w}" for w in review["warnings"]]
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    base = out / "_run"

    email_store, opp_store = scenario()
    m = run_morning_brief(ctx("morning"), base, email_store=email_store, opp_store=opp_store)
    plan = m["plan"]
    (out / f"plan-{DATE}.json").write_text(
        json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / f"{DATE}-morning.md").write_text(render_morning(plan, m["layering"]), encoding="utf-8")

    # 晚报：真实事件 — 批量 40/65 followup_sent + 报价客户 quote_sent，回复/逾期未处理
    batch = next(a for a in plan["actions"] if a["source"] == "email")
    quote = next(a for a in plan["actions"] if a["category"] == "quote")
    events = []
    for i in range(40):
        events.append({"action_key": batch["action_key"], "kind": "followup_sent",
                       "target_id": f"buyer{i + 3}@x.com", "event_id": f"fu_{i}",
                       "occurred_at": iso_days_ago(0)})
    events.append({"action_key": quote["action_key"], "kind": "quote_sent",
                   "target_id": "buyer2@x.com", "event_id": "q_1",
                   "occurred_at": iso_days_ago(0)})
    e = run_evening_brief(ctx("evening"), base, email_store=email_store, events=events)
    (out / f"review-{DATE}.json").write_text(
        json.dumps(e["review"], ensure_ascii=False, indent=2), encoding="utf-8")
    by_key = {a["action_key"]: a for a in plan["actions"]}
    (out / f"{DATE}-evening.md").write_text(render_evening(e["review"], by_key), encoding="utf-8")

    print(f"morning actions: {len(plan['actions'])} (top{plan['top_n']}={len(plan['top_n_action_keys'])})")
    print(f"layering: deducted={len(m['layering']['deducted_emails'])} "
          f"remaining={m['layering']['remaining_count']}")
    print(f"review statuses: {[r['status'] for r in e['review']['reviews']]}")
    print(f"wrote samples to {out}")


if __name__ == "__main__":
    main()
