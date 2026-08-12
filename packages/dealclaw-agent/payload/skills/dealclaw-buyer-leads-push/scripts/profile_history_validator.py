#!/usr/bin/env python3
"""Validate one-group history evidence and build an isolated matcher profile."""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime
import json
import re
import sys
from typing import Any


class EvidenceError(RuntimeError):
    """Raised when history evidence is ambiguous, malformed, or cross-group."""


SCORING_FIELDS = {
    "product.name",
    "product.alias",
    "product.category",
    "target_country",
    "buyer_type.name",
    "buyer_type.alias",
    "moq",
    "desired_buyer_tag",
    "buyer_profile_keyword",
    "intent_keyword",
}
DOCUMENT_FIELDS = {
    "company.full_name",
    "company.founded_year",
    "company.type",
    "company.office_address",
    "company.factory_address",
    "company.factory_scale",
    "company.export_value",
    "company.business_model",
    "company.certification",
    "company.store_url",
    "production.configuration",
    "market.existing",
    "market.exhibition",
    "buyer.decision_maker",
    "buyer.key_requirement",
    "material.item",
    "analysis.strength",
    "analysis.weakness",
    "analysis.action",
}
CORE_FIELDS = {"product.name", "product.category", "target_country"}
SOURCE_KINDS = {"message", "pinned_message", "group_attachment"}
FORBIDDEN_FIELD_MARKERS = (
    "email",
    "phone",
    "whatsapp",
    "wechat",
    "social_account",
    "contact_detail",
)


def normalized(value: Any) -> str:
    return " ".join(value.split()).casefold() if isinstance(value, str) else ""


def require_text(value: Any, field: str) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text:
        raise EvidenceError(f"{field} must be a non-empty string")
    return text


def parse_time(value: Any, field: str) -> str:
    text = require_text(value, field)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EvidenceError(f"{field} must be ISO-8601") from exc
    if parsed.tzinfo is None:
        raise EvidenceError(f"{field} must include a timezone")
    return text


def validate_evidence(value: Any, chat_id: str, field: str) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        raise EvidenceError(f"{field} must be a non-empty evidence array")
    output = []
    seen = set()
    for index, item in enumerate(value):
        label = f"{field}[{index}]"
        if not isinstance(item, dict):
            raise EvidenceError(f"{label} must be an object")
        allowed = {"source_chat_id", "message_id", "sent_at", "author_id", "excerpt", "source_kind"}
        extra = sorted(set(item) - allowed)
        if extra:
            raise EvidenceError(f"{label} contains disallowed fields: {', '.join(extra)}")
        if require_text(item.get("source_chat_id"), f"{label}.source_chat_id") != chat_id:
            raise EvidenceError("Evidence crosses the current chat_id boundary")
        result = {
            "source_chat_id": chat_id,
            "message_id": require_text(item.get("message_id"), f"{label}.message_id"),
            "sent_at": parse_time(item.get("sent_at"), f"{label}.sent_at"),
            "author_id": require_text(item.get("author_id"), f"{label}.author_id"),
            "excerpt": require_text(item.get("excerpt"), f"{label}.excerpt"),
            "source_kind": require_text(item.get("source_kind"), f"{label}.source_kind"),
        }
        if result["source_kind"] not in SOURCE_KINDS:
            raise EvidenceError(f"{label}.source_kind is unsupported")
        key = (result["message_id"], normalized(result["excerpt"]))
        if key not in seen:
            seen.add(key)
            output.append(result)
    return sorted(output, key=lambda item: (item["sent_at"], item["message_id"]))


def validate_history_scope(value: Any, chat_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EvidenceError("history_scope must be an object")
    allowed = {"source_chat_id", "from", "to", "message_count", "complete", "stop_reason"}
    extra = sorted(set(value) - allowed)
    if extra:
        raise EvidenceError(f"history_scope contains disallowed fields: {', '.join(extra)}")
    if require_text(value.get("source_chat_id"), "history_scope.source_chat_id") != chat_id:
        raise EvidenceError("History scope crosses the current chat_id boundary")
    count = value.get("message_count")
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        raise EvidenceError("history_scope.message_count must be a non-negative integer")
    complete = value.get("complete")
    if not isinstance(complete, bool):
        raise EvidenceError("history_scope.complete must be boolean")
    return {
        "source_chat_id": chat_id,
        "from": parse_time(value.get("from"), "history_scope.from"),
        "to": parse_time(value.get("to"), "history_scope.to"),
        "message_count": count,
        "complete": complete,
        "stop_reason": require_text(value.get("stop_reason"), "history_scope.stop_reason"),
    }


def company_name(value: Any, chat_id: str) -> tuple[str, list[dict[str, str]]]:
    if not isinstance(value, list):
        raise EvidenceError("company_candidates must be an array")
    candidates: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != {"name", "evidence"}:
            raise EvidenceError(f"company_candidates[{index}] must contain only name and evidence")
        name = require_text(item.get("name"), f"company_candidates[{index}].name")
        evidence = validate_evidence(item.get("evidence"), chat_id, f"company_candidates[{index}].evidence")
        key = normalized(name)
        if key in candidates:
            candidates[key]["evidence"].extend(evidence)
        else:
            candidates[key] = {"name": name, "evidence": evidence}
    if not candidates:
        raise EvidenceError("No explicit company candidate in the current group history")
    if len(candidates) > 1:
        names = sorted((item["name"] for item in candidates.values()), key=normalized)
        raise EvidenceError("Multiple company candidates: " + " | ".join(names))
    selected = next(iter(candidates.values()))
    evidence = {(item["message_id"], normalized(item["excerpt"])): item for item in selected["evidence"]}
    return selected["name"], sorted(evidence.values(), key=lambda item: (item["sent_at"], item["message_id"]))


def canonical_value(value: Any) -> str:
    if isinstance(value, str):
        return normalized(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def validated_claims(value: Any, chat_id: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise EvidenceError("claims must be an array")
    output = []
    for index, item in enumerate(value):
        label = f"claims[{index}]"
        if not isinstance(item, dict):
            raise EvidenceError(f"{label} must be an object")
        allowed = {"field", "value", "status", "product_id", "buyer_type_id", "evidence"}
        extra = sorted(set(item) - allowed)
        if extra:
            raise EvidenceError(f"{label} contains disallowed fields: {', '.join(extra)}")
        field = require_text(item.get("field"), f"{label}.field")
        if field not in SCORING_FIELDS and field not in DOCUMENT_FIELDS:
            raise EvidenceError(f"{label}.field is unsupported: {field}")
        if any(marker in field.casefold() for marker in FORBIDDEN_FIELD_MARKERS):
            raise EvidenceError(f"{label}.field contains forbidden contact data")
        status = require_text(item.get("status"), f"{label}.status")
        if status not in {"confirmed", "conflict"}:
            raise EvidenceError(f"{label}.status must be confirmed or conflict")
        claim_value = item.get("value")
        if field == "moq":
            if not isinstance(claim_value, dict) or set(claim_value) != {"value", "unit"}:
                raise EvidenceError(f"{label}.value must contain value and unit")
            quantity = claim_value.get("value")
            if not isinstance(quantity, (int, float)) or isinstance(quantity, bool) or quantity <= 0:
                raise EvidenceError(f"{label}.value.value must be positive")
            claim_value = {"value": quantity, "unit": require_text(claim_value.get("unit"), f"{label}.value.unit")}
        else:
            claim_value = require_text(claim_value, f"{label}.value")
        result = {
            "field": field,
            "value": claim_value,
            "status": status,
            "evidence": validate_evidence(item.get("evidence"), chat_id, f"{label}.evidence"),
        }
        if field.startswith("product."):
            result["product_id"] = require_text(item.get("product_id"), f"{label}.product_id")
        elif "product_id" in item:
            raise EvidenceError(f"{label}.product_id is only allowed for product fields")
        if field.startswith("buyer_type."):
            result["buyer_type_id"] = require_text(item.get("buyer_type_id"), f"{label}.buyer_type_id")
        elif "buyer_type_id" in item:
            raise EvidenceError(f"{label}.buyer_type_id is only allowed for buyer_type fields")
        output.append(result)
    return output


def unique_claim_values(claims: list[dict[str, Any]], field: str) -> list[Any]:
    values = {}
    for claim in claims:
        if claim["field"] == field and claim["status"] == "confirmed":
            values.setdefault(canonical_value(claim["value"]), claim["value"])
    return [values[key] for key in sorted(values)]


def build_profile(chat_id: str, claims: list[dict[str, Any]]) -> tuple[dict[str, Any], list[str], list[str]]:
    conflicts = sorted({claim["field"] for claim in claims if claim["status"] == "conflict"})
    products = []
    product_ids = sorted({claim["product_id"] for claim in claims if "product_id" in claim}, key=normalized)
    product_core_conflict = False
    for product_id in product_ids:
        scoped = [claim for claim in claims if claim.get("product_id") == product_id]
        names = unique_claim_values(scoped, "product.name")
        aliases = unique_claim_values(scoped, "product.alias")
        categories = unique_claim_values(scoped, "product.category")
        scoped_conflict = any(claim["status"] == "conflict" and claim["field"] in {"product.name", "product.category"} for claim in scoped)
        if len(names) > 1:
            scoped_conflict = True
        if scoped_conflict:
            product_core_conflict = True
        if len(names) == 1 and categories and not scoped_conflict:
            products.append({"name": names[0], "aliases": aliases, "categories": categories})

    buyer_types = []
    buyer_type_ids = sorted({claim["buyer_type_id"] for claim in claims if "buyer_type_id" in claim}, key=normalized)
    for buyer_type_id in buyer_type_ids:
        scoped = [claim for claim in claims if claim.get("buyer_type_id") == buyer_type_id]
        names = unique_claim_values(scoped, "buyer_type.name")
        aliases = unique_claim_values(scoped, "buyer_type.alias")
        if len(names) == 1 and not any(claim["status"] == "conflict" for claim in scoped):
            buyer_types.append({"name": names[0], "aliases": aliases})

    countries = unique_claim_values(claims, "target_country")
    country_conflict = "target_country" in conflicts
    moqs = unique_claim_values(claims, "moq")
    moq = moqs[0] if len(moqs) == 1 and "moq" not in conflicts else None
    if len(moqs) > 1 and "moq" not in conflicts:
        conflicts.append("moq")

    missing = []
    if not products:
        missing.extend(["product.name", "product.category"])
    if not countries or country_conflict:
        missing.append("target_country")
    if product_core_conflict:
        for field in ("product.name", "product.category"):
            if field not in conflicts:
                conflicts.append(field)

    profile = {
        "source_chat_id": chat_id,
        "products": sorted(products, key=lambda item: normalized(item["name"])),
        "buyer_types": sorted(buyer_types, key=lambda item: normalized(item["name"])),
        "target_countries": [{"name": value, "aliases": []} for value in countries] if not country_conflict else [],
        "moq": moq,
        "desired_buyer_tags": unique_claim_values(claims, "desired_buyer_tag"),
        "buyer_profile_keywords": unique_claim_values(claims, "buyer_profile_keyword"),
        "intent_keywords": unique_claim_values(claims, "intent_keyword"),
    }
    return profile, sorted(set(missing)), sorted(set(conflicts))


def validate(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise EvidenceError("input must be an object")
    allowed = {"chat_id", "history_scope", "company_candidates", "claims"}
    extra = sorted(set(payload) - allowed)
    if extra:
        raise EvidenceError(f"input contains disallowed fields: {', '.join(extra)}")
    chat_id = require_text(payload.get("chat_id"), "chat_id")
    history_scope = validate_history_scope(payload.get("history_scope"), chat_id)
    selected_company, company_evidence = company_name(payload.get("company_candidates"), chat_id)
    claims = validated_claims(payload.get("claims"), chat_id)
    full_names = unique_claim_values(claims, "company.full_name")
    if len(full_names) > 1:
        raise EvidenceError("Multiple confirmed company.full_name values")
    if full_names and normalized(full_names[0]) != normalized(selected_company):
        raise EvidenceError("company.full_name conflicts with the selected company candidate")
    profile, missing, conflicts = build_profile(chat_id, claims)
    confirmation_ready = not missing and not any(field in CORE_FIELDS for field in conflicts)
    status = "ready_for_confirmation" if confirmation_ready else "draft_incomplete"
    return {
        "chat_id": chat_id,
        "company_name": selected_company,
        "company_evidence": company_evidence,
        "history_scope": history_scope,
        "draft_status": status,
        "confirmation_ready": confirmation_ready,
        "missing_core_fields": missing,
        "conflicted_fields": conflicts,
        "matcher_profile": profile,
        "validated_claim_count": len(claims),
    }


def sample(chat_id: str = "oc_a") -> dict[str, Any]:
    evidence = {
        "source_chat_id": chat_id,
        "message_id": "om_1",
        "sent_at": "2026-08-10T09:30:00+08:00",
        "author_id": "ou_1",
        "excerpt": "我们公司是示例企业，主打绗缝被，属于床上用品，目标开发巴西",
        "source_kind": "message",
    }
    return {
        "chat_id": chat_id,
        "history_scope": {
            "source_chat_id": chat_id,
            "from": "2026-01-01T00:00:00+08:00",
            "to": "2026-08-12T10:00:00+08:00",
            "message_count": 1,
            "complete": True,
            "stop_reason": "earliest_available",
        },
        "company_candidates": [{"name": "示例企业", "evidence": [evidence]}],
        "claims": [
            {"field": "company.full_name", "value": "示例企业", "status": "confirmed", "evidence": [evidence]},
            {"field": "product.name", "product_id": "p1", "value": "绗缝被", "status": "confirmed", "evidence": [evidence]},
            {"field": "product.category", "product_id": "p1", "value": "床上用品", "status": "confirmed", "evidence": [evidence]},
            {"field": "target_country", "value": "巴西", "status": "confirmed", "evidence": [evidence]},
        ],
    }


def self_test() -> None:
    ready = validate(sample())
    assert ready["draft_status"] == "ready_for_confirmation"
    assert ready["confirmation_ready"] is True
    assert ready["matcher_profile"]["products"][0]["categories"] == ["床上用品"]

    draft_payload = sample()
    draft_payload["claims"] = [claim for claim in draft_payload["claims"] if claim["field"] != "target_country"]
    draft = validate(draft_payload)
    assert draft["draft_status"] == "draft_incomplete"
    assert draft["confirmation_ready"] is False
    assert "target_country" in draft["missing_core_fields"]

    ambiguous = sample()
    ambiguous["company_candidates"].append({"name": "另一企业", "evidence": ambiguous["company_candidates"][0]["evidence"]})
    try:
        validate(ambiguous)
    except EvidenceError as exc:
        assert "Multiple company candidates" in str(exc)
    else:
        raise AssertionError("Multiple company candidates were not rejected")

    crossed = sample()
    crossed["claims"][0]["evidence"][0]["source_chat_id"] = "oc_b"
    try:
        validate(crossed)
    except EvidenceError as exc:
        assert "crosses" in str(exc)
    else:
        raise AssertionError("Cross-group evidence was not rejected")

    print("profile_history_validator self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        payload = json.load(sys.stdin)
        result = validate(payload)
    except (EvidenceError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
