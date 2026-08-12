#!/usr/bin/env python3
"""Run tenant-guarded TradeChina retrieval and deterministic scoring."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from typing import Any, Callable

import profile_matcher
import tenant_run_guard
import tradechina_buyer_leads


class PipelineError(RuntimeError):
    """Raised when a scoped lead run cannot be completed safely."""


MATCHER_RECORD_FIELDS = {
    "线索ID",
    "产品类别T1",
    "产品类别T2",
    "关注产品",
    "买家类型",
    "买家国家",
    "需求意向",
    "买家特征",
    "买家公司简介",
    "需求时间",
}


def positive_integer(value: Any, default: int, maximum: int, field: str) -> int:
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= maximum:
        raise PipelineError(f"{field} must be an integer from 1 to {maximum}")
    return value


def run_pipeline(
    payload: Any,
    get_countries_fn: Callable[[], list[dict[str, Any]]] = tradechina_buyer_leads.get_countries,
    fetch_buyers_fn: Callable[..., dict[str, Any]] = tradechina_buyer_leads.fetch_buyers,
    score_fn: Callable[[Any], dict[str, Any]] = profile_matcher.score_envelope,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise PipelineError("input must be an object")
    extra = sorted(set(payload) - {"context", "days", "limit", "max_pages"})
    if extra:
        raise PipelineError(f"input contains disallowed fields: {', '.join(extra)}")
    days = payload.get("days", 7)
    if days not in tradechina_buyer_leads.VALID_DAYS:
        raise PipelineError("days must be 3, 7, 15, or 30")
    limit = positive_integer(payload.get("limit"), 20, 200, "limit")
    max_pages = positive_integer(payload.get("max_pages"), 5, 50, "max_pages")
    context = tenant_run_guard.validate_context(payload.get("context"))

    countries = get_countries_fn()
    profile = copy.deepcopy(context["profile"])
    country_by_key: dict[str, dict[str, Any]] = {}
    for target in profile["target_countries"]:
        resolved = tradechina_buyer_leads.resolve_country(target["name"], countries)
        aliases = {tenant_run_guard.normalized(value): value for value in target["aliases"]}
        for key in ("cnName", "enName"):
            value = resolved.get(key)
            if isinstance(value, str) and value.strip():
                aliases.setdefault(tenant_run_guard.normalized(value), value.strip())
        target["aliases"] = [aliases[key] for key in sorted(aliases)]
        country_by_key[tenant_run_guard.normalized(target["name"])] = resolved

    records_by_id: dict[str, dict[str, Any]] = {}
    query_audit = []
    for job in context["query_jobs"]:
        resolved = country_by_key[tenant_run_guard.normalized(job["country_name"])]
        result = fetch_buyers_fn(
            supplier_id=context["supplier_id"],
            country_id=str(resolved["countryId"]),
            product_keyword=job["product_keyword"],
            days=days,
            limit=limit,
            max_pages=max_pages,
        )
        records = result.get("records")
        if not isinstance(records, list):
            raise PipelineError("Sanitized buyer result records must be an array")
        for record in records:
            if not isinstance(record, dict):
                raise PipelineError("Sanitized buyer record must be an object")
            lead_id = record.get("线索ID")
            if not isinstance(lead_id, str) or not lead_id.strip():
                raise PipelineError("Sanitized buyer record lacks a usable lead ID")
            records_by_id.setdefault(lead_id.strip(), record)
        query_audit.append(
            {
                "country_name": job["country_name"],
                "country_id": str(resolved["countryId"]),
                "product_keyword": job["product_keyword"],
                "pages_fetched": result.get("pagesFetched", 0),
                "records_returned": len(records),
                "rejected_missing_lead_id": result.get("rejectedMissingLeadId", 0),
            }
        )

    matcher_records = []
    for lead_id in sorted(records_by_id):
        record = records_by_id[lead_id]
        projected = {field: record.get(field, "") for field in MATCHER_RECORD_FIELDS}
        projected["飞书群ID"] = context["chat_id"]
        matcher_records.append(projected)
    scored = score_fn(
        {
            "chat_id": context["chat_id"],
            "run_at": context["run_at"],
            "source_timezone": context["source_timezone"],
            "profile": profile,
            "records": matcher_records,
            "penalty_rules": context["penalty_rules"],
        }
    )
    score_by_id = {record["线索ID"]: record for record in scored["records"]}
    output = []
    for scored_record in scored["records"]:
        lead_id = scored_record["线索ID"]
        source = records_by_id[lead_id]
        merged = dict(source)
        merged.update(scored_record)
        merged["画像企业名称"] = context["company_name"]
        merged["企业画像版本"] = context["profile_hash"]
        merged["运行上下文ID"] = context["run_context_id"]
        output.append(merged)
    if set(score_by_id) != set(records_by_id):
        raise PipelineError("Matcher output lead IDs differ from sanitized input")

    plan = tenant_run_guard.public_plan(context)
    return {
        "chat_id": context["chat_id"],
        "state_revision": context["state_revision"],
        "company_name": context["company_name"],
        "profile_hash": context["profile_hash"],
        "run_context_id": context["run_context_id"],
        "knowledge_doc_fingerprint": plan["knowledge_doc_fingerprint"],
        "base_fingerprint": plan["base_fingerprint"],
        "supplier_binding_fingerprint": plan["supplier_binding_fingerprint"],
        "weight_version": scored["weight_version"],
        "query_audit": query_audit,
        "records": output,
    }


def self_test() -> None:
    context = tenant_run_guard.fixture()

    def fake_countries() -> list[dict[str, Any]]:
        return [{"countryId": "br", "cnName": "巴西", "enName": "Brazil"}]

    seen_supplier_ids = []

    def fake_fetch(**kwargs: Any) -> dict[str, Any]:
        seen_supplier_ids.append(kwargs["supplier_id"])
        return {
            "pagesFetched": 1,
            "rejectedMissingLeadId": 0,
            "records": [
                {
                    "线索ID": "lead-1",
                    "买家CDPID": "cdp-1",
                    "联系人ID": "contact-1",
                    "买家公司名称": "巴西买家有限公司",
                    "买家公司简介": "",
                    "买家国家": "Brazil",
                    "产品类别T1": "床上用品",
                    "产品类别T2": "",
                    "需求意向": "",
                    "关注产品": "绗缝被",
                    "买家类型": "",
                    "买家特征": "",
                    "报名参展展会": "",
                    "需求时间": "2026-08-12T09:00:00+08:00",
                }
            ],
        }

    result = run_pipeline({"context": context}, fake_countries, fake_fetch)
    assert seen_supplier_ids == ["supplier-for-oc-a"]
    assert result["company_name"] == "真实企业"
    assert result["records"][0]["画像企业名称"] == "真实企业"
    assert result["records"][0]["买家公司名称"] == "巴西买家有限公司"
    assert result["records"][0]["核心匹配通过"] is True
    assert "supplier_id" not in result

    bad = tenant_run_guard.fixture()
    bad["formal_document"]["title"] = "错误固定企业｜企业知识库"
    try:
        run_pipeline({"context": bad}, fake_countries, fake_fetch)
    except tenant_run_guard.RunGuardError:
        pass
    else:
        raise AssertionError("Mismatched fixed company title was not rejected")
    print("scoped_lead_pipeline self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("run", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = run_pipeline(json.load(sys.stdin))
    except (
        PipelineError,
        tenant_run_guard.RunGuardError,
        tradechina_buyer_leads.ContractError,
        profile_matcher.MatchError,
        json.JSONDecodeError,
    ) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
