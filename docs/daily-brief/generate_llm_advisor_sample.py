#!/usr/bin/env python3
"""generate_llm_advisor_sample.py — LLM Advisor 影子结果（mock + 真实接口小规模）

产出：
  - mock/  ：确定性 mock 影子记录（正常 / 幻觉 / 非法JSON / 超时）
  - real/  ：真实 LLM 接口小规模测试（OpenRouter，1 次调用；无密钥/失败则记录降级）
所有记录都不含密钥、不改 Provider、不写企业 Memory、不展示用户。

用法：python3 docs/daily-brief/generate_llm_advisor_sample.py [--out docs/daily-brief/llm-advisor] [--real]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MIO = HERE.parents[1] / "packages" / "dealclaw-agent" / "payload" / "work" / "mio-api"
sys.path.insert(0, str(MIO))

from dc_daily_brief import BriefContext  # noqa: E402
from dc_daily_pipeline import run_morning_brief  # noqa: E402
from dc_email_provider import template_advise  # noqa: E402
from dc_llm_advisor import (  # noqa: E402
    LLMAdvisor, MockLLMClient, ShadowRunner, snapshot_from_plan,
    HTTPLLMClient, LLMAdvisorError, ERROR_TIMEOUT,
)

COMPANY = "152600996207"
DATE = "2026-09-11"


def iso_ago(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


class EmailStore:
    def __init__(self, outbounds):
        self._o = outbounds

    def list_outbound_records(self, company_id=None):
        return self._o

    def list_inbound_records(self, company_id=None):
        return []


class OppStore:
    def __init__(self, leads, interactions):
        self._l, self._i = leads, interactions

    def list_opportunities(self, company_id):
        return self._l

    def list_interactions(self, company_id):
        return self._i


def scenario():
    outbounds = [{"direction": "outbound", "provider_status": "delivered",
                  "recipients": [f"buyer{i}@x.com"], "resend_id": f"re_{i}",
                  "sent_at": iso_ago(3), "created_at": iso_ago(3), "touch_number": 0,
                  "company_id": COMPANY, "subject": "巴西展邀请"} for i in range(8)]
    leads = [
        {"company": "Reply Co", "company_cdp_id": "C001", "contact": "buyer0@x.com",
         "stage": "已回复", "match_grade": "B", "opportunity_status": "active",
         "contact_policy": "active"},
        {"company": "Overdue Co", "company_cdp_id": "C002", "contact": "buyer1@x.com",
         "stage": "需求明确", "match_grade": "B", "opportunity_status": "active",
         "contact_policy": "active", "next_action": "发送正式报价", "due": iso_ago(1)},
        {"company": "Quote Co", "company_cdp_id": "C003", "contact": "buyer2@x.com",
         "stage": "报价中", "match_grade": "A", "opportunity_status": "active",
         "contact_policy": "active"},
    ]
    interactions = [
        {"interaction_id": "it_reply", "customer_id": "C001", "channel": "email",
         "direction": "inbound", "occurred_at": iso_ago(1), "subject": "Re: 巴西展邀请"},
        {"interaction_id": "it_overdue", "customer_id": "C002", "channel": "email",
         "direction": "outbound", "occurred_at": iso_ago(2), "subject": "Re: 巴西展"},
        {"interaction_id": "it_quote", "customer_id": "C003", "channel": "email",
         "direction": "outbound", "occurred_at": iso_ago(1), "subject": "Re: 巴西展",
         "signals": [{"type": "quote_request", "value": "询价",
                      "evidence_text": "please send your quotation",
                      "origin": "agent_extracted", "confidence": 0.9}]},
    ]
    return EmailStore(outbounds), OppStore(leads, interactions)


def build_snapshot_and_template():
    now = datetime.now(timezone.utc).isoformat()
    ctx = BriefContext(tenant="meorient", company=COMPANY, report_type="morning", date=DATE,
                       tz="Asia/Shanghai", as_of=now, window_start=now, window_end=now)
    import tempfile
    base = Path(tempfile.mkdtemp(prefix="dc-llm-gen-"))
    r = run_morning_brief(ctx, base, email_store=EmailStore(scenario()[0]._o),
                          opp_store=scenario()[1], exh_store=None)
    plan = r["plan"]
    snap = snapshot_from_plan(plan, tenant="meorient", company=COMPANY, report_type="morning",
                              date=DATE, tz="Asia/Shanghai", as_of=now,
                              exhibition_stage="live", preferences={"revised": {"tone": "short"}})
    return plan, snap, template_advise(snap)


MOCK_OK = json.dumps({"advices": [{
    "advice_key": "llm_1", "claim": "优先处理逾期与已回复客户", "confidence": "medium",
    "confidence_reason": "基于候选事实", "assumptions": [], "counter_evidence": [],
    "limitations": ["影子模式，不生效"], "recommendation": "先跟进逾期与已回复客户",
    "evidence_refs": [{"type": "record", "source": "opportunity", "id": "C002"}],
    "proposed_actions": [], "action_refs": [], "fact_refs": ["stage"]}]}, ensure_ascii=False)
MOCK_HALLUCINATION = json.dumps({"advices": [{
    "advice_key": "llm_1", "claim": "客户承诺下单 100 万", "confidence": "high",
    "confidence_reason": "编造", "assumptions": [], "counter_evidence": [], "limitations": [],
    "recommendation": "催单", "evidence_refs": [], "action_refs": [], "fact_refs": ["ghost_fact"],
    "proposed_actions": []}]}, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "llm-advisor"))
    ap.add_argument("--real", action="store_true", help="调用真实 LLM 接口（需 OPENROUTER_API_KEY）")
    args = ap.parse_args()
    out = Path(args.out)
    (out / "mock").mkdir(parents=True, exist_ok=True)
    (out / "real").mkdir(parents=True, exist_ok=True)

    plan, snap, tmpl = build_snapshot_and_template()
    results = {}

    cases = {
        "ok": MockLLMClient(MOCK_OK),
        "hallucination": MockLLMClient(MOCK_HALLUCINATION),
        "invalid_json": MockLLMClient("this is not json"),
        "timeout": MockLLMClient(exc=LLMAdvisorError(ERROR_TIMEOUT, "read timeout")),
    }
    for name, client in cases.items():
        rec = ShadowRunner(out / "mock" / "_evals" / name, LLMAdvisor(client)).run(snap, tmpl)
        (out / "mock" / f"{name}.json").write_text(
            json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
        results[name] = (rec["ok"], rec["fallback"], rec["fallback_reason"], rec["order_diff"])
        print(f"[mock] {name}: ok={rec['ok']} fallback={rec['fallback_reason'] or '-'} "
              f"order_diff={len(rec['order_diff'])}")

    if args.real:
        model = os.environ.get("LLM_ADVISOR_MODEL", "openai/gpt-4o-mini")
        client = HTTPLLMClient(model=model, timeout=60, max_tokens=2048)
        rec = ShadowRunner(out / "real" / "_evals",
                           LLMAdvisor(client, model=model, max_tokens=2048)).run(snap, tmpl)
        (out / "real" / "openrouter.json").write_text(
            json.dumps({**rec, "model": model}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[real] model={model} ok={rec['ok']} fallback={rec['fallback_reason'] or '-'} "
              f"latency_ms={rec['latency_ms']} in={rec['input_tokens']} out={rec['output_tokens']} "
              f"guards={len(rec['guard_violations'])}")

    summary = {"generated_at": datetime.now(timezone.utc).isoformat(),
               "candidates": len(snap.candidates), "mock": results}
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
    print("wrote", out)


if __name__ == "__main__":
    main()
