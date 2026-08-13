#!/usr/bin/env python3
"""Build same-chat matcher penalty rules from explicit Base rejection feedback."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import sys
from typing import Any


class FeedbackRuleError(RuntimeError):
    """Raised when feedback is ambiguous, stale, or crosses a chat boundary."""


PENALTIES = {
    "product_name": 10,
    "product_category": 8,
    "country": 6,
    "buyer_type": 4,
    "moq": 3,
    "buyer_tag": 2,
    "company_profile": 1,
    "intent": 1,
}
REASON_DIMENSIONS = {
    "产品名称不匹配": ("product_name", "产品名称"),
    "产品类别不匹配": ("product_category", "产品类别"),
    "国家不匹配": ("country", "买家国家"),
    "买家国家不匹配": ("country", "买家国家"),
    "买家类型不匹配": ("buyer_type", "买家类型"),
    "MOQ不匹配": ("moq", "MOQ"),
    "买家标签不匹配": ("buyer_tag", "买家标签"),
    "买家简介不匹配": ("company_profile", "企业简介"),
    "需求意向不匹配": ("intent", "需求意向"),
}
REJECTION_STATUSES = {"❌不匹配", "不匹配"}
MIN_UNIQUE_REJECTIONS = 3


def text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise FeedbackRuleError(f"{field} must be a non-empty string")
    return result


def normalized(value: str) -> str:
    return " ".join(value.split()).casefold()


def status(value: Any) -> str:
    return "".join(value.split()) if isinstance(value, str) else ""


def instant(value: Any, field: str) -> datetime:
    raw = text(value, field)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FeedbackRuleError(f"{field} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise FeedbackRuleError(f"{field} must include a timezone offset")
    return parsed


def cursor_key(value: str) -> tuple[datetime, str] | None:
    if not value:
        return None
    try:
        timestamp, record_id = value.rsplit("|", 1)
    except ValueError as exc:
        raise FeedbackRuleError("current_cursor must be empty or <ISO-8601>|<record_id>") from exc
    return instant(timestamp, "current_cursor timestamp"), text(record_id, "current_cursor record_id")


def details_by_label(value: Any, field: str) -> dict[str, dict[str, Any]]:
    if not isinstance(value, list):
        raise FeedbackRuleError(f"{field} must be an array")
    output = {}
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise FeedbackRuleError(f"{field}[{index}] must be an object")
        label = text(raw.get("维度"), f"{field}[{index}].维度")
        if label in output:
            raise FeedbackRuleError(f"{field} contains duplicate dimensions")
        output[label] = raw
    return output


def validate_rule(raw: Any, chat_id: str, field: str) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != {"chat_id", "dimension", "value", "points"}:
        raise FeedbackRuleError(f"{field} has an invalid matcher rule schema")
    if raw.get("chat_id") != chat_id:
        raise FeedbackRuleError(f"{field} crosses the current chat_id")
    dimension = raw.get("dimension")
    if dimension not in PENALTIES or raw.get("points") != PENALTIES[dimension]:
        raise FeedbackRuleError(f"{field} uses an unsupported penalty")
    return {"chat_id": chat_id, "dimension": dimension, "value": text(raw.get("value"), f"{field}.value"), "points": PENALTIES[dimension]}


def validate_evidence(raw: Any, chat_id: str, field: str) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != {"chat_id", "dimension", "value", "source_record_ids", "source_lead_ids"}:
        raise FeedbackRuleError(f"{field} has an invalid evidence schema")
    if raw.get("chat_id") != chat_id or raw.get("dimension") not in PENALTIES:
        raise FeedbackRuleError(f"{field} is cross-chat or uses an unsupported dimension")
    record_ids = raw.get("source_record_ids")
    lead_ids = raw.get("source_lead_ids")
    if not isinstance(record_ids, list) or not isinstance(lead_ids, list) or len(record_ids) != len(lead_ids):
        raise FeedbackRuleError(f"{field} source IDs must be parallel arrays")
    pairs = sorted({(text(r, f"{field}.source_record_ids[]"), text(l, f"{field}.source_lead_ids[]")) for r, l in zip(record_ids, lead_ids)})
    return {
        "chat_id": chat_id,
        "dimension": raw["dimension"],
        "value": text(raw.get("value"), f"{field}.value"),
        "source_record_ids": [pair[0] for pair in pairs],
        "source_lead_ids": [pair[1] for pair in pairs],
    }


def build(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {"chat_id", "current_cursor", "records", "existing_rules", "existing_evidence"}:
        raise FeedbackRuleError("input must contain only chat_id, current_cursor, records, existing_rules, and existing_evidence")
    chat_id = text(payload.get("chat_id"), "chat_id")
    current_cursor = payload.get("current_cursor")
    if not isinstance(current_cursor, str):
        raise FeedbackRuleError("current_cursor must be a string")
    lower_bound = cursor_key(current_cursor)
    evidence_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    existing_evidence = payload.get("existing_evidence")
    if not isinstance(existing_evidence, list):
        raise FeedbackRuleError("existing_evidence must be an array")
    for index, raw in enumerate(existing_evidence):
        item = validate_evidence(raw, chat_id, f"existing_evidence[{index}]")
        key = (item["dimension"], normalized(item["value"]))
        if key in evidence_by_key:
            raise FeedbackRuleError("existing_evidence contains duplicate rule keys")
        evidence_by_key[key] = item

    existing_rules = payload.get("existing_rules")
    if not isinstance(existing_rules, list):
        raise FeedbackRuleError("existing_rules must be an array")
    rule_keys = set()
    for index, raw in enumerate(existing_rules):
        rule = validate_rule(raw, chat_id, f"existing_rules[{index}]")
        rule_keys.add((rule["dimension"], normalized(rule["value"])))
    if not rule_keys.issubset(evidence_by_key):
        raise FeedbackRuleError("Every existing rule must have same-chat audit evidence")

    records = payload.get("records")
    if not isinstance(records, list):
        raise FeedbackRuleError("records must be an array")
    pending = []
    for index, raw in enumerate(records):
        if not isinstance(raw, dict) or set(raw) != {"record_id", "飞书群ID", "线索ID", "是否匹配", "不匹配原因", "反馈时间", "评分明细"}:
            raise FeedbackRuleError(f"records[{index}] has an invalid feedback projection")
        if text(raw.get("飞书群ID"), f"records[{index}].飞书群ID") != chat_id:
            raise FeedbackRuleError("Feedback record crosses the current chat_id boundary")
        record_id = text(raw.get("record_id"), f"records[{index}].record_id")
        lead_id = text(raw.get("线索ID"), f"records[{index}].线索ID")
        feedback_at = instant(raw.get("反馈时间"), f"records[{index}].反馈时间")
        key = (feedback_at, record_id)
        if lower_bound is not None and key <= lower_bound:
            continue
        pending.append((key, record_id, lead_id, raw))
    pending.sort(key=lambda item: item[0])

    for _, record_id, lead_id, raw in pending:
        if status(raw.get("是否匹配")) not in REJECTION_STATUSES:
            continue
        reasons = raw.get("不匹配原因")
        if not isinstance(reasons, list):
            raise FeedbackRuleError("不匹配原因 must be an array")
        details = details_by_label(raw.get("评分明细"), f"record {record_id}.评分明细")
        for reason in {text(value, "不匹配原因[]") for value in reasons}:
            mapped = REASON_DIMENSIONS.get(reason)
            if mapped is None:
                continue
            dimension, label = mapped
            detail = details.get(label)
            if not isinstance(detail, dict):
                raise FeedbackRuleError(f"Feedback reason {reason} has no authoritative {label} detail")
            canonical = text(detail.get("画像依据"), f"record {record_id}.{label}.画像依据")
            key = (dimension, normalized(canonical))
            bucket = evidence_by_key.setdefault(
                key,
                {"chat_id": chat_id, "dimension": dimension, "value": canonical, "source_record_ids": [], "source_lead_ids": []},
            )
            pairs = set(zip(bucket["source_record_ids"], bucket["source_lead_ids"]))
            if not any(existing_lead == lead_id for _, existing_lead in pairs):
                pairs.add((record_id, lead_id))
            ordered = sorted(pairs)
            bucket["source_record_ids"] = [pair[0] for pair in ordered]
            bucket["source_lead_ids"] = [pair[1] for pair in ordered]

    learned_rules = []
    newly_activated = []
    for key in sorted(evidence_by_key):
        item = evidence_by_key[key]
        if len(set(item["source_lead_ids"])) < MIN_UNIQUE_REJECTIONS:
            continue
        rule = {"chat_id": chat_id, "dimension": item["dimension"], "value": item["value"], "points": PENALTIES[item["dimension"]]}
        learned_rules.append(rule)
        if key not in rule_keys:
            material = "\n".join([chat_id, item["dimension"], normalized(item["value"])])
            newly_activated.append("sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest())

    new_cursor = current_cursor
    if pending:
        final_key = pending[-1][0]
        new_cursor = final_key[0].isoformat() + "|" + final_key[1]
    return {
        "chat_id": chat_id,
        "feedback_cursor": new_cursor,
        "processed_record_count": len(pending),
        "learned_rules": learned_rules,
        "rule_evidence": [evidence_by_key[key] for key in sorted(evidence_by_key)],
        "newly_activated_rule_ids": newly_activated,
    }


def fixture() -> dict[str, Any]:
    records = []
    for index in range(3):
        records.append(
            {
                "record_id": f"rec-{index}",
                "飞书群ID": "oc_a",
                "线索ID": f"lead-{index}",
                "是否匹配": "❌ 不匹配",
                "不匹配原因": ["产品名称不匹配"],
                "反馈时间": f"2026-08-12T10:0{index}:00+08:00",
                "评分明细": [{"维度": "产品名称", "画像依据": "绗缝被"}],
            }
        )
    return {"chat_id": "oc_a", "current_cursor": "", "records": records, "existing_rules": [], "existing_evidence": []}


def self_test() -> None:
    result = build(fixture())
    assert result["learned_rules"] == [{"chat_id": "oc_a", "dimension": "product_name", "value": "绗缝被", "points": 10}]
    replay = fixture()
    replay["current_cursor"] = result["feedback_cursor"]
    replay["existing_rules"] = result["learned_rules"]
    replay["existing_evidence"] = result["rule_evidence"]
    assert build(replay)["processed_record_count"] == 0
    crossed = fixture()
    crossed["records"][0]["飞书群ID"] = "oc_b"
    try:
        build(crossed)
    except FeedbackRuleError:
        pass
    else:
        raise AssertionError("Cross-chat feedback was not rejected")
    print("feedback_rule_builder self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("build", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = build(json.load(sys.stdin))
    except (FeedbackRuleError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
