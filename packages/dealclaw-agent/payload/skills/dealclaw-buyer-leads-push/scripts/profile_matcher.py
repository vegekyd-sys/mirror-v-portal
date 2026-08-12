#!/usr/bin/env python3
"""Score one group's leads with an isolated, auditable nine-dimension policy."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import re
import sys
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


WEIGHTS = {
    "product_name": 32,
    "product_category": 24,
    "country": 18,
    "buyer_type": 10,
    "moq": 6,
    "buyer_tag": 4,
    "company_profile": 2,
    "intent": 2,
    "recency": 2,
}
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
CORE_DIMENSIONS = ("product_name", "product_category", "country")
MOQ_MARKER = r"(?:MOQ|minimum\s+order|minimum\s+quantity|起订|最小起订量|采购量|需求量)"
MOQ_NUMBER = r"(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"


class MatchError(RuntimeError):
    """Raised when matching input is invalid or crosses a group boundary."""


def normalized(value: Any) -> str:
    return " ".join(value.split()).casefold() if isinstance(value, str) else ""


def require_text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise MatchError(f"{field} must be a non-empty string")
    return result


def reject_extra_keys(value: dict[str, Any], allowed: set[str], field: str) -> None:
    extra = sorted(set(value) - allowed)
    if extra:
        raise MatchError(f"{field} contains disallowed fields: {', '.join(extra)}")


def strings(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise MatchError(f"{field} must be an array")
    result: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        item_text = require_text(item, f"{field}[{index}]")
        key = normalized(item_text)
        if key not in seen:
            seen.add(key)
            result.append(item_text)
    return sorted(result, key=normalized)


def profile_objects(
    value: Any, field: str, categories: bool, required: bool = True
) -> list[dict[str, Any]]:
    if value is None and not required:
        return []
    if not isinstance(value, list):
        raise MatchError(f"profile.{field} must be an array")
    if not value:
        if required:
            raise MatchError(f"profile.{field} must be a non-empty array")
        return []
    output = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise MatchError(f"profile.{field}[{index}] must be an object")
        allowed = {"name", "aliases", "categories"} if categories else {"name", "aliases"}
        reject_extra_keys(item, allowed, f"profile.{field}[{index}]")
        result = {
            "name": require_text(item.get("name"), f"profile.{field}[{index}].name"),
            "aliases": strings(item.get("aliases", []), f"profile.{field}[{index}].aliases"),
        }
        if categories:
            result["categories"] = strings(
                item.get("categories", []), f"profile.{field}[{index}].categories"
            )
            if not result["categories"]:
                raise MatchError(f"profile.{field}[{index}].categories must not be empty")
        output.append(result)
    return sorted(output, key=lambda item: normalized(item["name"]))


def profile_moq(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise MatchError("profile.moq must be an object or null")
    reject_extra_keys(value, {"value", "unit"}, "profile.moq")
    quantity = value.get("value")
    if not isinstance(quantity, (int, float)) or isinstance(quantity, bool) or quantity <= 0:
        raise MatchError("profile.moq.value must be a positive number")
    return {"value": float(quantity), "unit": require_text(value.get("unit"), "profile.moq.unit")}


def watched_products(value: Any) -> list[str]:
    output = []
    seen = set()
    source = value if isinstance(value, str) else ""
    for line in source.splitlines():
        for item in line.split(" / "):
            item = item.strip()
            key = normalized(item)
            if key and key not in seen:
                seen.add(key)
                output.append(item)
    return output


def exact(profile_values: list[str], lead_values: list[str]) -> tuple[str, str] | None:
    lead_by_key = {normalized(value): value for value in lead_values if normalized(value)}
    for value in profile_values:
        if normalized(value) in lead_by_key:
            return value, lead_by_key[normalized(value)]
    return None


def literal_phrase(keywords: list[str], source: Any) -> tuple[str, str] | None:
    normalized_source = normalized(source)
    if not normalized_source:
        return None
    for keyword in keywords:
        if normalized(keyword) in normalized_source:
            return keyword, source.strip()
    return None


def dimension(points: int, canonical: str = "", lead: str = "", note: str = "") -> dict[str, Any]:
    return {"points": points, "canonical": canonical, "lead": lead, "note": note}


def product_dimensions(products: list[dict[str, Any]], record: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    watched = watched_products(record.get("关注产品"))
    categories = [
        value.strip()
        for value in (record.get("产品类别T1"), record.get("产品类别T2"))
        if isinstance(value, str) and value.strip()
    ]
    for product in products:
        name_match = exact([product["name"], *product["aliases"]], watched)
        if name_match:
            category_match = exact(product["categories"], categories)
            return (
                dimension(WEIGHTS["product_name"], product["name"], name_match[1]),
                dimension(
                    WEIGHTS["product_category"] if category_match else 0,
                    category_match[0] if category_match else "",
                    category_match[1] if category_match else "",
                ),
            )
    return dimension(0), dimension(0, note="产品类别只在产品名称命中同一画像产品后计分")


def buyer_type_dimension(buyer_types: list[dict[str, Any]], record: dict[str, Any]) -> dict[str, Any]:
    lead_value = record.get("买家类型")
    if not isinstance(lead_value, str) or not lead_value.strip():
        return dimension(0, note="接口买家类型为空")
    for buyer_type in buyer_types:
        matched = exact([buyer_type["name"], *buyer_type["aliases"]], [lead_value.strip()])
        if matched:
            return dimension(WEIGHTS["buyer_type"], buyer_type["name"], lead_value.strip())
    return dimension(0, lead=lead_value.strip())


def exact_list_dimension(values: list[str], lead_value: Any, weight: int) -> dict[str, Any]:
    if not isinstance(lead_value, str) or not lead_value.strip():
        return dimension(0)
    matched = exact(values, [lead_value.strip()])
    return dimension(weight, matched[0], matched[1]) if matched else dimension(0, lead=lead_value.strip())


def extract_moq(value: Any, expected_unit: str) -> dict[str, Any] | None:
    if not isinstance(value, str):
        return None
    unit = re.escape(expected_unit.strip())
    patterns = (
        re.compile(rf"{MOQ_MARKER}\s*[:：=]?\s*({MOQ_NUMBER})\s*({unit})", re.IGNORECASE),
        re.compile(rf"({MOQ_NUMBER})\s*({unit})\s*{MOQ_MARKER}", re.IGNORECASE),
    )
    for pattern in patterns:
        matched = pattern.search(value)
        if matched:
            quantity = float(matched.group(1).replace(",", ""))
            unit = matched.group(2).strip()
            if quantity > 0 and unit:
                return {"value": quantity, "unit": unit, "text": matched.group(0)}
    return None


def moq_dimension(profile: dict[str, Any] | None, intent: Any) -> dict[str, Any]:
    if profile is None:
        return dimension(0, note="画像未提供明确MOQ")
    lead = extract_moq(intent, profile["unit"])
    if lead is None:
        return dimension(0, note="需求意向无与画像同单位的可验证明确MOQ")
    canonical = f"{profile['value']:g} {profile['unit']}"
    lead_value = f"{lead['value']:g} {lead['unit']}"
    if lead["value"] < profile["value"]:
        return dimension(0, canonical, lead_value, "线索明确数量低于企业MOQ")
    return dimension(WEIGHTS["moq"], canonical, lead_value, lead["text"])


def parse_time(value: Any, timezone: ZoneInfo) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone)
    return parsed


def recency_dimension(value: Any, run_at: datetime, timezone: ZoneInfo) -> tuple[dict[str, Any], float]:
    parsed = parse_time(value, timezone)
    if parsed is None:
        return dimension(0, note="需求时间缺失或无效"), float("-inf")
    seconds = (run_at - parsed.astimezone(run_at.tzinfo)).total_seconds()
    epoch = parsed.timestamp()
    if seconds < 0 or seconds > 7 * 86400:
        return dimension(0, lead=parsed.isoformat(), note="未来时间或超过7天"), epoch
    points = 2 if seconds <= 3 * 86400 else 1
    return dimension(points, "0-3天" if points == 2 else "4-7天", parsed.isoformat()), epoch


def validate_penalties(value: Any, chat_id: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise MatchError("penalty_rules must be an array")
    output = []
    seen = set()
    for index, rule in enumerate(value):
        if not isinstance(rule, dict):
            raise MatchError(f"penalty_rules[{index}] must be an object")
        reject_extra_keys(rule, {"chat_id", "dimension", "value", "points"}, f"penalty_rules[{index}]")
        if require_text(rule.get("chat_id"), f"penalty_rules[{index}].chat_id") != chat_id:
            raise MatchError("Penalty rule crosses the current chat_id boundary")
        name = rule.get("dimension")
        if name not in PENALTIES:
            raise MatchError("Penalty dimension is not allowed")
        if rule.get("points") != PENALTIES[name]:
            raise MatchError(f"Penalty points for {name} must be {PENALTIES[name]}")
        canonical = require_text(rule.get("value"), f"penalty_rules[{index}].value")
        key = (name, normalized(canonical))
        if key not in seen:
            seen.add(key)
            output.append({"dimension": name, "value": canonical, "points": PENALTIES[name]})
    return output


def apply_penalties(parts: dict[str, dict[str, Any]], rules: list[dict[str, Any]]) -> tuple[int, list[str]]:
    total = 0
    applied = []
    for rule in rules:
        part = parts[rule["dimension"]]
        if part["points"] and normalized(part["canonical"]) == normalized(rule["value"]):
            total += rule["points"]
            applied.append(f"{rule['dimension']}:-{rule['points']}")
    return total, applied


def evidence(parts: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    labels = {
        "product_name": "产品名称",
        "product_category": "产品类别",
        "buyer_type": "买家类别",
        "country": "买家国家",
        "moq": "MOQ",
        "buyer_tag": "买家标签",
        "company_profile": "买家企业简介",
        "intent": "需求意向",
        "recency": "线索时间",
    }
    return [
        {
            "维度": labels[name],
            "得分": parts[name]["points"],
            "画像依据": parts[name]["canonical"],
            "线索依据": parts[name]["lead"],
            "说明": parts[name]["note"],
        }
        for name in WEIGHTS
    ]


def score_envelope(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise MatchError("Input root must be an object")
    reject_extra_keys(payload, {"chat_id", "run_at", "source_timezone", "profile", "records", "penalty_rules"}, "input")
    chat_id = require_text(payload.get("chat_id"), "chat_id")
    try:
        timezone = ZoneInfo(require_text(payload.get("source_timezone"), "source_timezone"))
    except ZoneInfoNotFoundError as exc:
        raise MatchError("source_timezone is unknown") from exc
    run_at = parse_time(payload.get("run_at"), timezone)
    if run_at is None:
        raise MatchError("run_at must be a valid ISO-8601 datetime")
    profile = payload.get("profile")
    if not isinstance(profile, dict):
        raise MatchError("profile must be an object")
    reject_extra_keys(
        profile,
        {"source_chat_id", "products", "buyer_types", "target_countries", "moq", "desired_buyer_tags", "buyer_profile_keywords", "intent_keywords"},
        "profile",
    )
    if require_text(profile.get("source_chat_id"), "profile.source_chat_id") != chat_id:
        raise MatchError("Profile crosses the current chat_id boundary")
    products = profile_objects(profile.get("products"), "products", categories=True)
    buyer_types = profile_objects(
        profile.get("buyer_types", []), "buyer_types", categories=False, required=False
    )
    countries = profile_objects(profile.get("target_countries"), "target_countries", categories=False)
    tags = strings(profile.get("desired_buyer_tags", []), "profile.desired_buyer_tags")
    profile_keywords = strings(profile.get("buyer_profile_keywords", []), "profile.buyer_profile_keywords")
    intent_keywords = strings(profile.get("intent_keywords", []), "profile.intent_keywords")
    moq = profile_moq(profile.get("moq"))
    rules = validate_penalties(payload.get("penalty_rules", []), chat_id)
    records = payload.get("records")
    if not isinstance(records, list):
        raise MatchError("records must be an array")

    allowed_record = {"飞书群ID", "线索ID", "产品类别T1", "产品类别T2", "关注产品", "买家类型", "买家国家", "需求意向", "买家特征", "买家公司简介", "需求时间"}
    output = []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise MatchError(f"records[{index}] must be an object")
        reject_extra_keys(record, allowed_record, f"records[{index}]")
        if require_text(record.get("飞书群ID"), f"records[{index}].飞书群ID") != chat_id:
            raise MatchError("Lead record crosses the current chat_id boundary")
        lead_id = require_text(record.get("线索ID"), f"records[{index}].线索ID")
        product_name, product_category = product_dimensions(products, record)
        buyer_type = buyer_type_dimension(buyer_types, record)
        country = dimension(0, lead=record.get("买家国家", "") if isinstance(record.get("买家国家"), str) else "")
        for target_country in countries:
            country_match = exact(
                [target_country["name"], *target_country["aliases"]],
                [record.get("买家国家", "")] if isinstance(record.get("买家国家"), str) else [],
            )
            if country_match:
                country = dimension(WEIGHTS["country"], target_country["name"], country_match[1])
                break
        moq_part = moq_dimension(moq, record.get("需求意向"))
        buyer_tag = exact_list_dimension(tags, record.get("买家特征"), WEIGHTS["buyer_tag"])
        profile_match = literal_phrase(profile_keywords, record.get("买家公司简介"))
        company_profile = dimension(WEIGHTS["company_profile"], profile_match[0], profile_match[1]) if profile_match else dimension(0)
        intent_match = literal_phrase(intent_keywords, record.get("需求意向"))
        intent = dimension(WEIGHTS["intent"], intent_match[0], intent_match[1]) if intent_match else dimension(0)
        recency, demand_epoch = recency_dimension(record.get("需求时间"), run_at, timezone)
        parts = {
            "product_name": product_name,
            "product_category": product_category,
            "buyer_type": buyer_type,
            "country": country,
            "moq": moq_part,
            "buyer_tag": buyer_tag,
            "company_profile": company_profile,
            "intent": intent,
            "recency": recency,
        }
        raw_score = sum(part["points"] for part in parts.values())
        core_pass = all(parts[name]["points"] == WEIGHTS[name] for name in CORE_DIMENSIONS)
        penalty, applied = apply_penalties(parts, rules)
        final_score = max(0, min(100, raw_score - penalty))
        if final_score >= 80 and core_pass:
            level, action = "高", "push"
        elif final_score >= 65:
            level, action = "中", "pool_only"
        else:
            level, action = "低", "exclude"
        output.append(
            {
                "飞书群ID": chat_id,
                "企业画像群ID": chat_id,
                "线索ID": lead_id,
                "AI原始分": raw_score,
                "反馈扣分": penalty,
                "AI匹配分": final_score,
                "AI匹配等级": level,
                "核心匹配通过": core_pass,
                "匹配动作": action,
                "线索明确MOQ": moq_part["lead"] if moq_part["lead"] else "",
                "评分明细": evidence(parts),
                "已应用反馈规则": applied,
                "_demand_epoch": demand_epoch,
            }
        )
    output.sort(key=lambda item: (-item["AI匹配分"], -item["AI原始分"], -item["_demand_epoch"], item["线索ID"]))
    for item in output:
        item.pop("_demand_epoch", None)
    return {"chat_id": chat_id, "weight_version": "v7-32-24-18-10-6-4-2-2-2", "records": output}


def fixture() -> dict[str, Any]:
    return {
        "chat_id": "chat-a",
        "run_at": "2026-08-12T10:00:00+08:00",
        "source_timezone": "Asia/Shanghai",
        "profile": {
            "source_chat_id": "chat-a",
            "products": [{"name": "绗缝被", "aliases": ["Quilt"], "categories": ["床上用品"]}],
            "buyer_types": [{"name": "分销商", "aliases": ["Distributor"]}],
            "target_countries": [{"name": "巴西", "aliases": ["Brazil"]}],
            "moq": {"value": 500, "unit": "件"},
            "desired_buyer_tags": ["连锁零售"],
            "buyer_profile_keywords": ["家居用品进口商"],
            "intent_keywords": ["寻找新供应商"],
        },
        "records": [{
            "飞书群ID": "chat-a", "线索ID": "lead-1", "关注产品": "绗缝被 / Quilt",
            "产品类别T1": "家居", "产品类别T2": "床上用品", "买家类型": "Distributor",
            "买家国家": "巴西", "需求意向": "寻找新供应商，MOQ 1000 件", "买家特征": "连锁零售",
            "买家公司简介": "专业家居用品进口商", "需求时间": "2026-08-11 10:00:00"
        }],
        "penalty_rules": [],
    }


def self_test() -> dict[str, Any]:
    assert sum(WEIGHTS.values()) == 100
    assert WEIGHTS["product_name"] > WEIGHTS["product_category"] > WEIGHTS["country"]
    assert WEIGHTS["country"] > WEIGHTS["buyer_type"]
    assert WEIGHTS["buyer_type"] > max(
        WEIGHTS[name] for name in WEIGHTS if name not in {*CORE_DIMENSIONS, "buyer_type"}
    )
    base = fixture()
    perfect = score_envelope(base)["records"][0]
    assert perfect["AI原始分"] == 100 and perfect["AI匹配分"] == 100
    assert perfect["核心匹配通过"] is True and perfect["匹配动作"] == "push"
    assert perfect["线索明确MOQ"] == "1000 件"

    no_name = json.loads(json.dumps(base, ensure_ascii=False))
    no_name["records"][0]["关注产品"] = "其他产品"
    scored_no_name = score_envelope(no_name)["records"][0]
    assert scored_no_name["AI原始分"] == 44
    assert scored_no_name["匹配动作"] == "exclude"

    no_type = json.loads(json.dumps(base, ensure_ascii=False))
    no_type["records"][0]["买家类型"] = ""
    scored_no_type = score_envelope(no_type)["records"][0]
    assert scored_no_type["AI原始分"] == 90
    assert scored_no_type["核心匹配通过"] is True
    assert scored_no_type["匹配动作"] == "push"

    no_profile_types = json.loads(json.dumps(base, ensure_ascii=False))
    no_profile_types["profile"]["buyer_types"] = []
    scored_no_profile_types = score_envelope(no_profile_types)["records"][0]
    assert scored_no_profile_types["AI原始分"] == 90
    assert scored_no_profile_types["核心匹配通过"] is True
    assert scored_no_profile_types["匹配动作"] == "push"

    no_country = json.loads(json.dumps(base, ensure_ascii=False))
    no_country["records"][0]["买家国家"] = "其他国家"
    scored_no_country = score_envelope(no_country)["records"][0]
    assert scored_no_country["AI原始分"] == 82
    assert scored_no_country["核心匹配通过"] is False
    assert scored_no_country["匹配动作"] == "pool_only"

    low_moq = json.loads(json.dumps(base, ensure_ascii=False))
    low_moq["records"][0]["需求意向"] = "寻找新供应商，MOQ 200 件"
    assert score_envelope(low_moq)["records"][0]["AI原始分"] == 94

    wrong_unit = json.loads(json.dumps(base, ensure_ascii=False))
    wrong_unit["records"][0]["需求意向"] = "寻找新供应商，MOQ 1000 箱"
    assert score_envelope(wrong_unit)["records"][0]["AI原始分"] == 94

    ranged_moq = json.loads(json.dumps(base, ensure_ascii=False))
    ranged_moq["records"][0]["需求意向"] = "寻找新供应商，MOQ 500-1000 件"
    assert score_envelope(ranged_moq)["records"][0]["AI原始分"] == 94

    bare_number = json.loads(json.dumps(base, ensure_ascii=False))
    bare_number["records"][0]["需求意向"] = "寻找新供应商，1000 件"
    assert score_envelope(bare_number)["records"][0]["AI原始分"] == 94

    comma_moq = json.loads(json.dumps(base, ensure_ascii=False))
    comma_moq["records"][0]["需求意向"] = "寻找新供应商，MOQ 1,000 件产品"
    assert score_envelope(comma_moq)["records"][0]["AI原始分"] == 100

    country_alias = json.loads(json.dumps(base, ensure_ascii=False))
    country_alias["records"][0]["买家国家"] = "Brazil"
    assert score_envelope(country_alias)["records"][0]["AI原始分"] == 100

    old_lead = json.loads(json.dumps(base, ensure_ascii=False))
    old_lead["records"][0]["需求时间"] = "2026-08-06 09:59:59"
    assert score_envelope(old_lead)["records"][0]["AI原始分"] == 99

    future_lead = json.loads(json.dumps(base, ensure_ascii=False))
    future_lead["records"][0]["需求时间"] = "2026-08-13 10:00:00"
    assert score_envelope(future_lead)["records"][0]["AI原始分"] == 98

    penalized = json.loads(json.dumps(base, ensure_ascii=False))
    penalized["penalty_rules"] = [{"chat_id": "chat-a", "dimension": "product_name", "value": "绗缝被", "points": 10}]
    assert score_envelope(penalized)["records"][0]["AI匹配分"] == 90

    cross = json.loads(json.dumps(base, ensure_ascii=False))
    cross["records"][0]["飞书群ID"] = "chat-b"
    try:
        score_envelope(cross)
    except MatchError:
        pass
    else:
        raise AssertionError("Cross-group lead was not rejected")

    extra = json.loads(json.dumps(base, ensure_ascii=False))
    extra["records"][0]["未批准字段"] = "x"
    try:
        score_envelope(extra)
    except MatchError:
        pass
    else:
        raise AssertionError("Disallowed field was not rejected")

    return {
        "ok": True,
        "weightsTotal": sum(WEIGHTS.values()),
        "coreWeights": [32, 24, 18],
        "buyerTypeSecondaryWeight": 10,
        "otherAuxiliaryWeights": [6, 4, 2, 2, 2],
        "coreGateTested": True,
        "buyerTypeOptionalBonusTested": True,
        "targetCountryCoreGateTested": True,
        "explicitMoqTested": True,
        "moqRangeAndBareNumberRejected": True,
        "moqThousandsSeparatorTested": True,
        "countryAliasTested": True,
        "recencyBoundariesTested": True,
        "feedbackPenaltyTested": True,
        "crossGroupRejected": True,
        "disallowedFieldsRejected": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("score", "self-test"))
    args = parser.parse_args()
    try:
        result = self_test() if args.command == "self-test" else score_envelope(json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (MatchError, AssertionError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
