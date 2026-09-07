#!/usr/bin/env python3
"""Validate a structured post-exhibition report before formal rendering."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


FORBIDDEN_PATTERNS = (
    r"明确成交可能",
    r"具备明确复购基础",
    r"复购转化可显著",
    r"效果肯定.*翻倍",
    r"一定.*订单",
    r"浪费了?约?\s*\d+.*小时",
)

REQUIRED_TOP_LEVEL = (
    "report_id",
    "report_mode",
    "exhibition_id",
    "scope",
    "executive_summary",
    "funnel",
    "diagnoses",
    "buyer_actions",
    "demand_insights",
    "action_plan",
    "data_completeness",
    "report_version",
)


def iter_strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from iter_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_strings(child)


def validate(report: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    for field in REQUIRED_TOP_LEVEL:
        if field not in report:
            errors.append(f"missing top-level field: {field}")

    if report.get("scope", {}).get("current_exhibition_only") is not True:
        errors.append("scope.current_exhibition_only must be true")

    for text in iter_strings(report):
        for pattern in FORBIDDEN_PATTERNS:
            if re.search(pattern, text):
                errors.append(f"unsupported claim matched /{pattern}/: {text[:100]}")

    funnel = report.get("funnel", [])
    stages = [str(item.get("stage", "")) for item in funnel if isinstance(item, dict)]
    if len(stages) != len(set(stages)):
        errors.append("funnel contains duplicate stage names")

    diagnoses = report.get("diagnoses", [])
    for index, item in enumerate(diagnoses):
        if not isinstance(item, dict):
            errors.append(f"diagnoses[{index}] must be an object")
            continue
        for field in ("observation", "interpretation", "recommended_action", "success_metric"):
            if not item.get(field):
                errors.append(f"diagnoses[{index}].{field} is required")
        if not item.get("evidence_refs"):
            warnings.append(f"diagnoses[{index}] has no evidence_refs; keep it as a low-confidence hypothesis")

    buyers: list[dict[str, Any]] = []
    for group in report.get("buyer_actions", {}).values():
        if isinstance(group, list):
            buyers.extend(item for item in group if isinstance(item, dict))
    priority_buyers = [item for item in buyers if item.get("followup_priority") == "优先跟进"]
    for index, item in enumerate(priority_buyers):
        if len(item.get("evidence_refs") or []) < 2:
            errors.append(f"priority buyer {item.get('customer_id') or index} requires at least 2 evidence_refs")
        next_step = item.get("next_step") or {}
        for field in ("action", "owner", "due"):
            if not next_step.get(field):
                errors.append(f"priority buyer {item.get('customer_id') or index} missing next_step.{field}")

    normalized_reasons = [re.sub(r"\s+", "", str(item.get("priority_reason", ""))) for item in priority_buyers]
    normalized_reasons = [reason for reason in normalized_reasons if reason]
    if len(normalized_reasons) >= 3:
        _, repeated = Counter(normalized_reasons).most_common(1)[0]
        if repeated / len(normalized_reasons) > 0.6:
            errors.append("more than 60% of priority buyers share an identical priority_reason")

    for index, item in enumerate(report.get("demand_insights", [])):
        if not isinstance(item, dict):
            errors.append(f"demand_insights[{index}] must be an object")
            continue
        for field in ("topic", "unique_customers", "mention_count", "sample_customer_count", "evidence_refs"):
            if field not in item:
                errors.append(f"demand_insights[{index}].{field} is required")

    for index, item in enumerate(report.get("action_plan", [])):
        if not isinstance(item, dict):
            errors.append(f"action_plan[{index}] must be an object")
            continue
        for field in ("action", "owner", "due", "success_metric"):
            if not item.get(field):
                errors.append(f"action_plan[{index}].{field} is required")

    completeness = report.get("data_completeness", {})
    if completeness.get("status") not in {"complete", "partial", "insufficient"}:
        errors.append("data_completeness.status must be complete, partial, or insufficient")

    return errors, warnings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    args = parser.parse_args()

    try:
        report = json.loads(args.input.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(json.dumps({"valid": False, "errors": [str(error)], "warnings": []}, ensure_ascii=False, indent=2))
        raise SystemExit(2)

    errors, warnings = validate(report)
    print(json.dumps({"valid": not errors, "errors": errors, "warnings": warnings}, ensure_ascii=False, indent=2))
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()
