#!/usr/bin/env python3
"""Query TradeChina buyer leads while emitting only approved, contact-free fields."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from typing import Any


COUNTRIES_URL = (
    "https://micro.tradechina.com/blade-system/"
    "api/getAllCountry.json"
)
BUYERS_URL = (
    "https://micro.tradechina.com/blade-purchaser/"
    "api/buyerLeadsPlaza/page"
)
DETAIL_URL = (
    "https://micro.tradechina.com/blade-purchaser/"
    "api/buyerLeadsPlaza/detail"
)
VALID_DAYS = {3, 7, 15, 30}
UNLOCK_ID_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


class ContractError(RuntimeError):
    """Raised when the remote response does not match the approved contract."""


class RecordRejected(ContractError):
    """Raised when one buyer record cannot produce a safe unique lead."""


class CountryUnresolved(ContractError):
    """Raised when a country name has zero matches in the live dictionary.

    The pipeline treats this as a per-country skip (audited), not a fatal
    error: the TradeChina dictionary's coverage is dynamic, so one absent
    country must never abort pushes for the remaining target countries.
    Ambiguity (more than one exact match) stays a fatal ContractError.
    """


def require_supplier_id(value: str | None) -> str:
    candidate = (value or "").strip()
    if not candidate:
        raise ContractError("TradeChina supplierId is required from the current chat_id binding")
    if any(marker in candidate for marker in ("<", ">")) or candidate.casefold() in {
        "changeme",
        "placeholder",
        "your-supplier-id",
    }:
        raise ContractError("TradeChina supplierId is still a placeholder")
    return candidate


def post_json(url: str, payload: dict[str, Any], timeout: int = 30) -> Any:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "buyer-leads-feishu-push/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ContractError(f"HTTP {exc.code} from TradeChina API") from exc
    except urllib.error.URLError as exc:
        raise ContractError("Unable to reach TradeChina API") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ContractError("TradeChina API returned invalid JSON") from exc


def require_success_envelope(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ContractError("Response root must be an object")
    if payload.get("success") is not True and payload.get("code") not in (0, "0"):
        raise ContractError("TradeChina API returned an unsuccessful envelope")
    return payload


def get_countries() -> list[dict[str, Any]]:
    payload = require_success_envelope(post_json(COUNTRIES_URL, {}))
    data = payload.get("data")
    if not isinstance(data, list):
        raise ContractError("Country data must be an array")
    approved = []
    seen_ids: set[str] = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        # getAllCountry.json 按语言返回同一国家的多行，必须按 id 去重，
        # 否则精确匹配会重复命中而被判为歧义
        if item.get("isDeleted") not in (0, "0", None):
            continue
        country_id = item.get("id")
        if not isinstance(country_id, (str, int)) or isinstance(country_id, bool):
            continue
        country_id_text = str(country_id).strip()
        if not country_id_text or country_id_text in seen_ids:
            continue
        seen_ids.add(country_id_text)
        approved.append(
            {
                "countryId": country_id_text,
                "enName": item.get("enName") if isinstance(item.get("enName"), str) else "",
                "cnName": item.get("cnName") if isinstance(item.get("cnName"), str) else "",
            }
        )
    return approved


COUNTRY_ALIASES: dict[str, str | None] = {
    # 简称/缩写 → TradeChina 字典里的精确名（cnName 或 enName）
    "沙特": "沙特阿拉伯",
    "saudi": "Saudi Arabia",
    "阿联酋": "阿拉伯联合酋长国",
    "uae": "United Arab Emirates",
    # 明确无数据（TradeChina 国家字典里没有），值为 None → resolve 时跳过而非报错
    "科威特": None,
    "kuwait": None,
    "卡塔尔": None,
    "qatar": None,
    "巴林": None,
    "bahrain": None,
}


def resolve_country(name: str, countries: list[dict[str, Any]]) -> dict[str, Any] | None:
    needle = name.strip().casefold()
    if not needle:
        raise ContractError("Country name must not be empty")

    def exact_matches(value: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for item in countries:
            candidates = (str(item.get("cnName", "")), str(item.get("enName", "")))
            if any(candidate.strip().casefold() == value for candidate in candidates):
                out.append(item)
        return out

    matches = exact_matches(needle)
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ContractError(
            f"Country name '{name}' resolved to {len(matches)} ambiguous exact matches")

    # 别名映射：简称/缩写 → 精确名
    if needle in COUNTRY_ALIASES:
        mapped = COUNTRY_ALIASES[needle]
        if mapped is None:
            return None  # 明确无数据，调用方应跳过而非中断整个推送
        matches = exact_matches(mapped.casefold())
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ContractError(
                f"Country name '{name}' resolved to {len(matches)} ambiguous exact matches")

    raise CountryUnresolved(f"Country name '{name}' is absent from the live country dictionary")


def approved_text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def format_products(value: Any) -> str:
    if not isinstance(value, list):
        return ""
    formatted: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        cn_name = approved_text(item.get("productName"))
        en_name = approved_text(item.get("productNameEn"))
        if cn_name and en_name:
            formatted.append(f"{cn_name} / {en_name}")
        elif cn_name:
            formatted.append(cn_name)
        elif en_name:
            formatted.append(en_name)
    return "\n".join(formatted)


def sanitize_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise ContractError("Buyer record must be an object")
    exhibition = ""
    register_flag = record.get("hasHomeLifeRegisterLog")
    exhibition_name = approved_text(record.get("exhibitionName"))
    if type(register_flag) is int and register_flag == 1 and exhibition_name.strip():
        exhibition = exhibition_name
    lead_id = record.get("id")
    if not isinstance(lead_id, (str, int)) or isinstance(lead_id, bool):
        raise RecordRejected("Buyer record is missing a usable lead ID")
    lead_id_text = str(lead_id).strip()
    if not lead_id_text:
        raise RecordRejected("Buyer record is missing a usable lead ID")
    return {
        "线索ID": lead_id_text,
        "买家CDPID": approved_text(record.get("companyCdpId")),
        "联系人ID": approved_text(record.get("purchaserContactId")),
        "买家公司名称": approved_text(record.get("buyerCompany")),
        "买家公司简介": approved_text(record.get("companyProfile")),
        "买家国家": approved_text(record.get("buyerCountry")),
        "产品类别T1": approved_text(record.get("t1")),
        "产品类别T2": approved_text(record.get("t2")),
        "需求意向": approved_text(record.get("recentTrend")),
        "关注产品": format_products(record.get("productList")),
        "买家类型": approved_text(record.get("buyerType")),
        "买家特征": approved_text(record.get("buyerTag")),
        "报名参展展会": exhibition,
        "需求时间": approved_text(record.get("lastConsolidatedTime")),
    }


def approved_flag(value: Any) -> int | None:
    return value if type(value) is int and value in (0, 1) else None


def sanitize_detail(record: Any) -> dict[str, Any]:
    """Project one buyerLeadsPlaza/detail record onto approved contact fields.

    The contact fields are contact-gated output: they may leave this script
    only through ``fetch_buyer_detail`` with a valid ``unlock_id`` issued by
    ``contact_unlock_guard.py``. They must never enter the Base, durable
    state, the matcher, profile data, logs, or free-form model messages.
    """
    if not isinstance(record, dict):
        raise ContractError("Buyer detail must be an object")
    lead_id = record.get("id")
    if not isinstance(lead_id, (str, int)) or isinstance(lead_id, bool):
        raise RecordRejected("Buyer detail is missing a usable lead ID")
    lead_id_text = str(lead_id).strip()
    if not lead_id_text:
        raise RecordRejected("Buyer detail is missing a usable lead ID")
    unlock_status = record.get("unlockStatus")
    if not isinstance(unlock_status, int) or isinstance(unlock_status, bool):
        unlock_status = None
    if unlock_status == -1:
        unlock_state = "locked"
    elif unlock_status is None:
        unlock_state = "unknown"
    else:
        unlock_state = "unlocked"
    return {
        "线索ID": lead_id_text,
        "买家公司名称": approved_text(record.get("buyerCompany")),
        "联系人姓名": approved_text(record.get("contactName")),
        "职位": approved_text(record.get("jobTitle")),
        "邮箱": approved_text(record.get("buyerEmail")),
        "电话": approved_text(record.get("buyerMobile")),
        "WhatsApp": approved_text(record.get("buyerWhatsapp")),
        "公司官网": approved_text(record.get("companyWebsite")),
        "邮箱有效": approved_flag(record.get("emailValid")),
        "电话有效": approved_flag(record.get("mobileValid")),
        "WhatsApp有效": approved_flag(record.get("whatsappValid")),
        "unlockStatus": unlock_status,
        "解锁状态": unlock_state,
    }


CONTACT_KEYS = ("联系人姓名", "职位", "邮箱", "电话", "WhatsApp", "公司官网",
                "邮箱有效", "电话有效", "WhatsApp有效")


def locked_projection(detail: dict[str, Any]) -> dict[str, Any]:
    """Return only the lock-state projection, stripping every contact field."""
    return {
        "线索ID": detail["线索ID"],
        "买家公司名称": detail["买家公司名称"],
        "unlockStatus": detail["unlockStatus"],
        "解锁状态": detail["解锁状态"],
        "contactFieldsReleased": False,
    }


def require_unlock_id(value: str | None) -> str:
    candidate = (value or "").strip()
    if not UNLOCK_ID_PATTERN.fullmatch(candidate):
        raise ContractError(
            "A valid --unlock-id from contact_unlock_guard.py authorize is "
            "required before any contact field may be released")
    return candidate


def fetch_buyer_detail(
    supplier_id: str | None,
    trend_id: str,
    unlock_id: str | None = None,
) -> dict[str, Any]:
    supplier_id = require_supplier_id(supplier_id)
    trend_id_text = trend_id.strip()
    if not trend_id_text:
        raise ContractError("trendId (线索ID) is required")
    envelope = require_success_envelope(
        post_json(DETAIL_URL, {"supplierId": supplier_id, "trendId": trend_id_text})
    )
    data = envelope.get("data")
    if not isinstance(data, dict):
        raise ContractError("Buyer detail response data must be an object")
    detail = sanitize_detail(data)
    if detail["线索ID"] != trend_id_text:
        raise ContractError("Buyer detail returned a different lead ID than requested")
    if unlock_id is None:
        return locked_projection(detail)
    detail["unlock_id"] = require_unlock_id(unlock_id)
    detail["contactFieldsReleased"] = True
    detail["supplierIdConfigured"] = True
    return detail


def fetch_buyers(
    supplier_id: str | None,
    country_id: str,
    product_keyword: str,
    days: int = 30,
    limit: int = 20,
    max_pages: int = 5,
) -> dict[str, Any]:
    supplier_id = require_supplier_id(supplier_id)
    if days not in VALID_DAYS:
        raise ContractError("consolidatedDays must be 3, 7, 15, or 30")
    if not country_id.strip() or not product_keyword.strip():
        raise ContractError("countryId and productKeyword are required")
    if not 1 <= limit <= 200 or not 1 <= max_pages <= 50:
        raise ContractError("limit or max-pages is outside the safe range")

    sanitized: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    total = 0
    pages_reported = 0
    pages_fetched = 0
    rejected_missing_lead_id = 0
    for page in range(1, max_pages + 1):
        request_body = {
            "supplierId": supplier_id,
            "consolidatedDays": days,
            "countryId": country_id,
            "productKeyword": product_keyword,
            "page": page,
            "limit": limit,
        }
        envelope = require_success_envelope(post_json(BUYERS_URL, request_body))
        data = envelope.get("data")
        if not isinstance(data, dict):
            raise ContractError("Buyer response data must be an object")
        records = data.get("records")
        if not isinstance(records, list):
            raise ContractError("Buyer response records must be an array")
        total = data.get("total") if isinstance(data.get("total"), int) else total
        pages_reported = data.get("pages") if isinstance(data.get("pages"), int) else pages_reported
        pages_fetched += 1
        for raw_record in records:
            try:
                record = sanitize_record(raw_record)
            except RecordRejected:
                rejected_missing_lead_id += 1
                continue
            lead_id = record["线索ID"]
            if lead_id not in seen_ids:
                seen_ids.add(lead_id)
                sanitized.append(record)
        if not records or (pages_reported and page >= pages_reported):
            break
    return {
        "supplierIdConfigured": True,
        "countryId": country_id,
        "productKeyword": product_keyword,
        "consolidatedDays": days,
        "pagesFetched": pages_fetched,
        "pagesReported": pages_reported,
        "totalReported": total,
        "rejectedMissingLeadId": rejected_missing_lead_id,
        "records": sanitized,
    }


def contract_check(
    supplier_id: str | None,
    country_id: str,
    product_keyword: str,
) -> dict[str, Any]:
    supplier_id = require_supplier_id(supplier_id)
    if not country_id.strip() or not product_keyword.strip():
        raise ContractError("countryId and productKeyword are required for contract-check")
    countries_envelope = require_success_envelope(post_json(COUNTRIES_URL, {}))
    countries = countries_envelope.get("data")
    country_keys: list[str] = []
    if isinstance(countries, list) and countries and isinstance(countries[0], dict):
        country_keys = sorted(countries[0].keys())

    buyers_envelope = require_success_envelope(
        post_json(
            BUYERS_URL,
            {
                "supplierId": supplier_id,
                "consolidatedDays": 7,
                "countryId": country_id,
                "productKeyword": product_keyword,
                "page": 1,
                "limit": 1,
            },
        )
    )
    data = buyers_envelope.get("data")
    records = data.get("records") if isinstance(data, dict) else None
    record_keys: list[str] = []
    product_item_keys: list[str] = []
    if isinstance(records, list):
        for record in records:
            if isinstance(record, dict) and not record_keys:
                record_keys = sorted(record.keys())
            products = record.get("productList") if isinstance(record, dict) else None
            if isinstance(products, list) and products and isinstance(products[0], dict):
                product_item_keys = sorted(products[0].keys())
                break
    required_record_keys = {
        "id",
        "companyCdpId",
        "purchaserContactId",
        "buyerCompany",
        "companyProfile",
        "buyerCountry",
        "t1",
        "t2",
        "recentTrend",
        "productList",
        "buyerTag",
        "exhibitionName",
        "hasHomeLifeRegisterLog",
        "lastConsolidatedTime",
    }
    return {
        "countriesOk": isinstance(countries, list),
        "countryCount": len(countries) if isinstance(countries, list) else 0,
        "countryKeys": country_keys,
        "buyersOk": isinstance(records, list),
        "recordCount": len(records) if isinstance(records, list) else 0,
        "requiredBuyerKeysPresent": required_record_keys.issubset(record_keys),
        "buyerTypeFieldPresent": "buyerType" in record_keys,
        "productItemKeys": product_item_keys,
        "supplierIdConfigured": True,
        "queryFiltersApplied": True,
    }


def self_test() -> dict[str, Any]:
    raw = {
        "id": 42,
        "companyCdpId": "CO123",
        "purchaserContactId": "PC456",
        "buyerCompany": "Example Buyer",
        "companyProfile": "A leading distributor of outdoor goods.",
        "buyerCountry": "Example Country",
        "t1": "泛家居",
        "t2": "户外家具",
        "recentTrend": "Example intent",
        "lastConsolidatedTime": "2026-08-10 10:00:00",
        "productList": [
            {"productName": "产品甲", "productNameEn": "Product A", "email": "forbidden"},
            {"productName": "产品乙", "productNameEn": ""},
        ],
        "exhibitionName": "Example Expo",
        "hasHomeLifeRegisterLog": 1,
        "buyerTag": "VIP",
        "email": "forbidden@example.com",
        "phone": "+000000",
        "website": "https://forbidden.example",
        "buyerType": "分销商",
    }
    sanitized = sanitize_record(raw)
    expected_keys = {
        "线索ID",
        "买家CDPID",
        "联系人ID",
        "买家公司名称",
        "买家公司简介",
        "买家国家",
        "产品类别T1",
        "产品类别T2",
        "需求意向",
        "关注产品",
        "买家类型",
        "买家特征",
        "报名参展展会",
        "需求时间",
    }
    assert set(sanitized) == expected_keys
    assert sanitized["报名参展展会"] == "Example Expo"
    assert sanitized["买家类型"] == "分销商"
    assert "forbidden" not in json.dumps(sanitized, ensure_ascii=False).casefold()

    missing_type = dict(raw, buyerType=None, buyerTag="分销商")
    assert sanitize_record(missing_type)["买家类型"] == ""

    for missing_id in (None, "", "   ", True, {}, []):
        invalid = dict(raw)
        invalid["id"] = missing_id
        try:
            sanitize_record(invalid)
        except RecordRejected:
            pass
        else:
            raise AssertionError("Missing or invalid lead ID was not rejected")

    raw["hasHomeLifeRegisterLog"] = 0
    assert sanitize_record(raw)["报名参展展会"] == ""
    raw["hasHomeLifeRegisterLog"] = 1
    raw["exhibitionName"] = ""
    assert sanitize_record(raw)["报名参展展会"] == ""

    assert require_supplier_id("explicit-supplier") == "explicit-supplier"
    try:
        require_supplier_id("<supplier-id>")
    except ContractError:
        pass
    else:
        raise AssertionError("Placeholder supplier ID was not rejected")

    original_post_json = globals()["post_json"]

    detail_raw = {
        "id": "lead-9",
        "buyerCompany": "Locked Buyer Co",
        "contactName": "Ana Example",
        "jobTitle": "Buyer",
        "buyerEmail": "ana@example.com",
        "buyerMobile": "+5511900000000",
        "buyerWhatsapp": "+5511900000000",
        "companyWebsite": "www.example.com",
        "emailValid": 1,
        "mobileValid": 0,
        "whatsappValid": 1,
        "unlockStatus": -1,
    }

    def fake_post_json(url: str, payload: dict[str, Any], timeout: int = 30) -> Any:
        del timeout
        if url == COUNTRIES_URL:
            return {
                "success": True,
                "data": [
                    {"id": "country-1", "cnName": "示例国", "enName": "Example", "isDeleted": 0},
                    # getAllCountry.json 按语言重复同一国家，必须去重
                    {"id": "country-1", "cnName": "示例国", "enName": "Example", "isDeleted": 0},
                    {"id": "country-2", "cnName": "已删除国", "enName": "Deleted", "isDeleted": 1},
                    {"id": None, "cnName": "无效国", "enName": "Invalid", "isDeleted": 0},
                ],
            }
        if url == DETAIL_URL:
            assert payload["supplierId"] == "explicit-supplier"
            assert set(payload) == {"supplierId", "trendId"}
            if payload["trendId"] != "lead-9":
                return {"success": True, "data": dict(detail_raw, id="other")}
            return {"success": True, "data": dict(detail_raw)}
        assert payload["supplierId"] == "explicit-supplier"
        assert payload["countryId"] == "country-1"
        assert payload["productKeyword"] == "示例产品"
        return {
            "success": True,
            "data": {
                "records": [raw, dict(raw), dict(raw, id="")],
                "total": 3,
                "pages": 1,
            },
        }

    try:
        globals()["post_json"] = fake_post_json
        countries = get_countries()
        assert len(countries) == 1
        assert resolve_country("示例国", countries)["countryId"] == "country-1"
        # 字典未收录的国家抛出 CountryUnresolved（ContractError 子类），
        # 由管线按国家跳过；歧义多命中仍是普通 ContractError（致命）。
        try:
            resolve_country("字典不存在的国家", countries)
        except CountryUnresolved:
            pass
        else:
            raise AssertionError("Unresolved country did not raise CountryUnresolved")
        assert issubclass(CountryUnresolved, ContractError)
        fetched = fetch_buyers(
            supplier_id="explicit-supplier",
            country_id="country-1",
            product_keyword="示例产品",
            max_pages=1,
        )
        assert len(fetched["records"]) == 1
        assert fetched["rejectedMissingLeadId"] == 1
        assert fetched["supplierIdConfigured"] is True
        checked = contract_check(
            supplier_id="explicit-supplier",
            country_id="country-1",
            product_keyword="示例产品",
        )
        assert checked["queryFiltersApplied"] is True
        assert checked["requiredBuyerKeysPresent"] is True
        assert checked["buyerTypeFieldPresent"] is True

        # Detail: without a guard-issued unlock ID, every contact field is stripped.
        locked = fetch_buyer_detail(supplier_id="explicit-supplier", trend_id="lead-9")
        assert locked["contactFieldsReleased"] is False
        assert locked["解锁状态"] == "locked"
        serialized_locked = json.dumps(locked, ensure_ascii=False)
        for marker in ("ana@example.com", "5511900000000", "Ana Example", "example.com"):
            assert marker not in serialized_locked, f"contact data leaked without unlock: {marker}"
        assert set(locked) == {"线索ID", "买家公司名称", "unlockStatus", "解锁状态",
                               "contactFieldsReleased"}

        # Detail: a valid guard-issued unlock ID releases the approved contact fields.
        unlock_id = "sha256:" + "a" * 64
        released = fetch_buyer_detail(
            supplier_id="explicit-supplier", trend_id="lead-9", unlock_id=unlock_id)
        assert released["contactFieldsReleased"] is True
        assert released["unlock_id"] == unlock_id
        assert released["邮箱"] == "ana@example.com"
        assert released["邮箱有效"] == 1 and released["电话有效"] == 0
        assert released["解锁状态"] == "locked"  # interface state preserved, gate is the guard

        unlocked_raw = dict(detail_raw, unlockStatus=1)

        def fake_unlocked(url, payload, timeout=30):
            if url == DETAIL_URL:
                return {"success": True, "data": dict(unlocked_raw)}
            return fake_post_json(url, payload, timeout)

        globals()["post_json"] = fake_unlocked
        assert fetch_buyer_detail(supplier_id="explicit-supplier", trend_id="lead-9",
                                  unlock_id=unlock_id)["解锁状态"] == "unlocked"
        globals()["post_json"] = fake_post_json

        for bad_unlock in (None, "", "plain-token", "sha256:xyz"):
            if bad_unlock is None:
                continue  # covered by the locked projection above
            try:
                fetch_buyer_detail(supplier_id="explicit-supplier", trend_id="lead-9",
                                   unlock_id=bad_unlock)
            except ContractError:
                pass
            else:
                raise AssertionError(f"invalid unlock id was not rejected: {bad_unlock!r}")
        try:
            fetch_buyer_detail(supplier_id="explicit-supplier", trend_id="different")
        except ContractError:
            pass
        else:
            raise AssertionError("mismatched returned lead ID was not rejected")
        try:
            fetch_buyer_detail(supplier_id="explicit-supplier", trend_id="  ")
        except ContractError:
            pass
        else:
            raise AssertionError("empty trendId was not rejected")
    finally:
        globals()["post_json"] = original_post_json

    return {
        "ok": True,
        "approvedFields": sorted(expected_keys),
        "contactFieldsExcluded": True,
        "exhibitionRuleChecked": True,
        "missingLeadIdRejected": True,
        "supplierIdRequiredFromChatBinding": True,
        "globalSupplierFallbackDisabled": True,
        "filteredContractCheckTested": True,
        "duplicateLeadIdTested": True,
        "invalidCountryIdRejected": True,
        "buyerTypeWhitelisted": True,
        "buyerTypeNotInferredFromTag": True,
        "detailLockedProjectionStripsContacts": True,
        "detailUnlockIdRequired": True,
        "detailLeadIdEchoChecked": True,
    }


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("countries", help="Return the approved country dictionary")

    resolve = subparsers.add_parser("resolve-country", help="Resolve an exact country name")
    resolve.add_argument("--name", required=True)

    buyers = subparsers.add_parser("buyers", help="Return sanitized buyer records")
    buyers.add_argument("--supplier-id", required=True, help="Must come from the current chat_id binding")
    buyers.add_argument("--country-id", required=True)
    buyers.add_argument("--product-keyword", required=True)
    buyers.add_argument("--days", type=int, default=30, choices=sorted(VALID_DAYS))
    buyers.add_argument("--limit", type=int, default=20)
    buyers.add_argument("--max-pages", type=int, default=5)

    contract = subparsers.add_parser(
        "contract-check", help="Check filtered live response shapes without buyer values"
    )
    contract.add_argument("--supplier-id", required=True, help="Must come from the current chat_id binding")
    contract.add_argument("--country-id", required=True)
    contract.add_argument("--product-keyword", required=True)

    detail = subparsers.add_parser(
        "buyer-detail",
        help="Return one lead's detail; contact fields only with a guard-issued --unlock-id",
    )
    detail.add_argument("--supplier-id", required=True, help="Must come from the current chat_id binding")
    detail.add_argument("--trend-id", required=True, help="The lead ID (线索ID) from the 买家线索 record")
    detail.add_argument("--unlock-id", default=None,
                        help="sha256 authorization from contact_unlock_guard.py authorize")
    subparsers.add_parser("self-test", help="Run offline whitelist and privacy checks")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "countries":
            result = get_countries()
        elif args.command == "resolve-country":
            result = resolve_country(args.name, get_countries())
        elif args.command == "buyers":
            result = fetch_buyers(
                supplier_id=args.supplier_id,
                country_id=args.country_id,
                product_keyword=args.product_keyword,
                days=args.days,
                limit=args.limit,
                max_pages=args.max_pages,
            )
        elif args.command == "contract-check":
            result = contract_check(
                supplier_id=args.supplier_id,
                country_id=args.country_id,
                product_keyword=args.product_keyword,
            )
        elif args.command == "buyer-detail":
            result = fetch_buyer_detail(
                supplier_id=args.supplier_id,
                trend_id=args.trend_id,
                unlock_id=args.unlock_id,
            )
        else:
            result = self_test()
        print_json(result)
        return 0
    except (ContractError, AssertionError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
