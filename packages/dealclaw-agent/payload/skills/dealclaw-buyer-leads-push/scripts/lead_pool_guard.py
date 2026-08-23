#!/usr/bin/env python3
"""Unified company lead pool (统一线索池) guard: ensure + sync.

Replaces per-company ad-hoc Base creation with one deterministic pool per
company: `企业名称｜企业线索池` containing the main table `线索池` and the
linked sub-tables `评分明细` and `参展行为`. Each lead row carries the
deterministic `企业键` (company_id) and `来源 = AI猎客`.

Commands:
    ensure   — validate an existing pool descriptor or emit a creation plan
    map      — sync_buyerleads_to_pool: map guarded pipeline records into
               pool upsert payloads plus linked sub-table records
    self-test

Contact fields are never mappable. Tenant isolation is enforced by
`飞书群ID == chat_id` on every record and by stamping every payload with the
binding's `company_id`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from typing import Any


class LeadPoolError(RuntimeError):
    """Raised when a pool descriptor or sync mapping is unsafe."""


POOL_BASE_TITLE_SUFFIX = "｜企业线索池"
MAIN_TABLE = "线索池"
SCORE_TABLE = "评分明细"
EXHIBITION_TABLE = "参展行为"
REQUIRED_TABLES = (MAIN_TABLE, SCORE_TABLE, EXHIBITION_TABLE)
LEAD_SOURCE = "AI猎客"

CONTACT_FIELD_MARKERS = (
    "联系人姓名", "邮箱", "电话", "WhatsApp", "whatsapp", "公司官网",
    "email", "phone", "mobile", "wechat", "contact",
)

# 线索池主表承载的字段（接口事实 + 反馈 + 解锁 + 系统字段）；
# AI 评分细节在 评分明细 子表，参展行为在 参展行为 子表。
MAIN_RECORD_FIELDS = (
    "唯一去重键", "企业键", "来源", "线索ID", "买家CDPID", "联系人ID",
    "买家公司名称", "买家公司简介", "买家国家", "产品类别T1", "产品类别T2",
    "需求意向", "关注产品", "买家类型", "买家特征", "需求时间",
    "AI匹配分", "AI匹配等级", "核心匹配通过", "飞书群ID",
)
SCORE_RECORD_FIELDS = (
    "唯一去重键", "企业键", "线索ID", "AI匹配分", "AI原始分", "反馈扣分",
    "AI匹配等级", "核心匹配通过", "AI匹配理由", "评分明细", "线索明确MOQ",
    "评分权重版本", "企业画像版本", "企业画像群ID", "画像企业名称",
    "运行上下文ID", "AI处理时间",
)
EXHIBITION_RECORD_FIELDS = ("唯一去重键", "企业键", "线索ID", "展会名称", "记录时间")


def normalized(value: Any) -> str:
    return " ".join(value.split()).casefold() if isinstance(value, str) else ""


def require_text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise LeadPoolError(f"{field} must be a non-empty string")
    return result


def company_key(company_name: str) -> str:
    """Deterministic 企业键: cmp_ + sha256(normalized name)[:16]."""
    name = require_text(company_name, "company_name")
    return "cmp_" + hashlib.sha256(normalized(name).encode("utf-8")).hexdigest()[:16]


def ensure(payload: Any) -> dict[str, Any]:
    """ensure_company_lead_pool: validate or plan the company's lead pool."""
    if not isinstance(payload, dict):
        raise LeadPoolError("input must be an object")
    unknown = set(payload) - {"company_name", "existing_pool"}
    if unknown:
        raise LeadPoolError(f"unexpected input keys: {sorted(unknown)}")
    company = require_text(payload.get("company_name"), "company_name")
    pool_id = company_key(company)
    expected_title = company + POOL_BASE_TITLE_SUFFIX

    existing = payload.get("existing_pool")
    if existing is None:
        return {
            "action": "create",
            "company_id": pool_id,
            "base_title": expected_title,
            "required_tables": list(REQUIRED_TABLES),
            "missing_tables": list(REQUIRED_TABLES),
            "main_table": MAIN_TABLE,
        }
    if not isinstance(existing, dict):
        raise LeadPoolError("existing_pool must be an object")
    unknown = set(existing) - {"base_app_token", "title", "tables"}
    if unknown:
        raise LeadPoolError(f"existing_pool contains unexpected keys: {sorted(unknown)}")
    token = require_text(existing.get("base_app_token"), "existing_pool.base_app_token")
    title = require_text(existing.get("title"), "existing_pool.title")
    if title != expected_title:
        raise LeadPoolError(
            f"existing pool title {title!r} does not match {expected_title!r}; "
            "never reuse another company's pool")
    tables = existing.get("tables")
    if not isinstance(tables, list) or not all(isinstance(t, str) for t in tables):
        raise LeadPoolError("existing_pool.tables must be an array of table names")
    missing = [t for t in REQUIRED_TABLES if t not in tables]
    return {
        "action": "reuse" if not missing else "reconcile_tables",
        "company_id": pool_id,
        "base_title": expected_title,
        "base_app_token": token,
        "required_tables": list(REQUIRED_TABLES),
        "missing_tables": missing,
        "main_table": MAIN_TABLE,
    }


def map_records(payload: Any) -> dict[str, Any]:
    """sync_buyerleads_to_pool: project guarded records into pool payloads."""
    if not isinstance(payload, dict):
        raise LeadPoolError("input must be an object")
    unknown = set(payload) - {"chat_id", "company_name", "records", "mapped_at"}
    if unknown:
        raise LeadPoolError(f"unexpected input keys: {sorted(unknown)}")
    chat_id = require_text(payload.get("chat_id"), "chat_id")
    pool_id = company_key(require_text(payload.get("company_name"), "company_name"))
    mapped_at = require_text(payload.get("mapped_at"), "mapped_at")
    records = payload.get("records")
    if not isinstance(records, list):
        raise LeadPoolError("records must be an array")

    main_records: list[dict[str, Any]] = []
    score_records: list[dict[str, Any]] = []
    exhibition_records: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise LeadPoolError(f"records[{index}] must be an object")
        leaked = [k for k in record
                  if any(marker in str(k) for marker in CONTACT_FIELD_MARKERS)
                  and k != "联系人ID"]
        if leaked:
            raise LeadPoolError(
                f"records[{index}] carries contact-like fields {leaked}; "
                "contact data is never written to the pool")
        if record.get("飞书群ID") != chat_id:
            raise LeadPoolError(f"records[{index}] crosses the invocation group")
        lead_id = require_text(record.get("线索ID"), f"records[{index}].线索ID")
        dedupe = f"{pool_id}:{lead_id}"
        if dedupe in seen_keys:
            raise LeadPoolError(f"records[{index}] duplicates key {dedupe}")
        seen_keys.add(dedupe)

        main = {"唯一去重键": dedupe, "企业键": pool_id, "来源": LEAD_SOURCE}
        for field in MAIN_RECORD_FIELDS:
            if field in ("唯一去重键", "企业键", "来源"):
                continue
            value = record.get(field, "")
            main[field] = value if isinstance(value, (str, int, float, bool)) else ""
        main_records.append(main)

        score = {"唯一去重键": dedupe, "企业键": pool_id, "线索ID": lead_id}
        for field in SCORE_RECORD_FIELDS:
            if field in ("唯一去重键", "企业键", "线索ID"):
                continue
            value = record.get(field, "")
            if field == "评分明细" and not isinstance(value, str):
                value = json.dumps(value, ensure_ascii=False, sort_keys=True)
            score[field] = value
        score_records.append(score)

        exhibition = record.get("报名参展展会")
        if isinstance(exhibition, str) and exhibition.strip():
            exhibition_records.append({
                "唯一去重键": dedupe,
                "企业键": pool_id,
                "线索ID": lead_id,
                "展会名称": exhibition.strip(),
                "记录时间": mapped_at,
            })

    return {
        "chat_id": chat_id,
        "company_id": pool_id,
        "main_table": MAIN_TABLE,
        "pool_records": main_records,
        "score_detail_table": SCORE_TABLE,
        "score_detail_records": score_records,
        "exhibition_table": EXHIBITION_TABLE,
        "exhibition_records": exhibition_records,
        "mapped_count": len(main_records),
    }


def fixture_records() -> list[dict[str, Any]]:
    return [{
        "飞书群ID": "oc_a",
        "线索ID": "lead-1",
        "买家CDPID": "cdp-1",
        "联系人ID": "pc-1",
        "买家公司名称": "巴西买家有限公司",
        "买家公司简介": "",
        "买家国家": "巴西",
        "产品类别T1": "床上用品",
        "产品类别T2": "",
        "需求意向": "寻找供应商",
        "关注产品": "绗缝被",
        "买家类型": "进口商",
        "买家特征": "连锁零售",
        "需求时间": "2026-08-12 09:00:00",
        "报名参展展会": "HomeLife Brazil 2026",
        "AI匹配分": 91,
        "AI原始分": 91,
        "反馈扣分": 0,
        "AI匹配等级": "高",
        "核心匹配通过": True,
        "AI匹配理由": "产品匹配",
        "评分明细": [{"维度": "产品名称", "得分": 32}],
        "线索明确MOQ": "",
        "评分权重版本": "v10",
        "企业画像版本": "sha256:profile-a",
        "企业画像群ID": "oc_a",
        "画像企业名称": "真实企业",
        "运行上下文ID": "sha256:run-a",
        "AI处理时间": "2026-08-20 10:00:00",
    }]


def self_test() -> None:
    # ensure: create plan
    created = ensure({"company_name": "真实企业"})
    assert created["action"] == "create"
    assert created["company_id"] == company_key("真实企业")
    assert created["base_title"] == "真实企业｜企业线索池"
    assert created["missing_tables"] == ["线索池", "评分明细", "参展行为"]

    # ensure: reuse intact pool
    reuse = ensure({"company_name": "真实企业", "existing_pool": {
        "base_app_token": "base_pool_a", "title": "真实企业｜企业线索池",
        "tables": ["线索池", "评分明细", "参展行为"]}})
    assert reuse["action"] == "reuse" and reuse["missing_tables"] == []

    # ensure: missing sub-table → reconcile
    partial = ensure({"company_name": "真实企业", "existing_pool": {
        "base_app_token": "base_pool_a", "title": "真实企业｜企业线索池",
        "tables": ["线索池"]}})
    assert partial["action"] == "reconcile_tables"
    assert partial["missing_tables"] == ["评分明细", "参展行为"]

    # map: full projection
    mapped = map_records({
        "chat_id": "oc_a", "company_name": "真实企业",
        "records": fixture_records(), "mapped_at": "2026-08-20T10:00:00+08:00"})
    assert mapped["mapped_count"] == 1
    main = mapped["pool_records"][0]
    assert main["唯一去重键"] == f"{company_key('真实企业')}:lead-1"
    assert main["来源"] == "AI猎客" and main["企业键"] == company_key("真实企业")
    assert main["核心匹配通过"] is True  # checkbox 布尔值必须保留
    assert "报名参展展会" not in main  # 展会进子表
    assert len(mapped["score_detail_records"]) == 1
    assert mapped["score_detail_records"][0]["评分明细"].startswith("[")
    assert len(mapped["exhibition_records"]) == 1
    assert mapped["exhibition_records"][0]["展会名称"] == "HomeLife Brazil 2026"

    bad = []
    crossed = {"chat_id": "oc_a", "company_name": "真实企业",
               "records": [dict(fixture_records()[0], 飞书群ID="oc_b")],
               "mapped_at": "2026-08-20T10:00:00+08:00"}
    bad.append(crossed)
    contact = {"chat_id": "oc_a", "company_name": "真实企业",
               "records": [dict(fixture_records()[0], 邮箱="a@b.c")],
               "mapped_at": "2026-08-20T10:00:00+08:00"}
    bad.append(contact)
    dup = {"chat_id": "oc_a", "company_name": "真实企业",
           "records": fixture_records() * 2, "mapped_at": "2026-08-20T10:00:00+08:00"}
    bad.append(dup)
    wrong_title = {"company_name": "真实企业", "existing_pool": {
        "base_app_token": "x", "title": "别家企业｜企业线索池", "tables": []}}
    for item in bad:
        try:
            map_records(item)
        except LeadPoolError:
            pass
        else:
            raise AssertionError("unsafe sync input was not rejected")
    try:
        ensure(wrong_title)
    except LeadPoolError:
        pass
    else:
        raise AssertionError("cross-company pool reuse was not rejected")
    print("lead_pool_guard self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("ensure", "map", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        payload = json.load(sys.stdin)
        result = ensure(payload) if args.command == "ensure" else map_records(payload)
    except (LeadPoolError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
