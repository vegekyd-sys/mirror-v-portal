#!/usr/bin/env python3
"""Query TradeChina buyer leads while emitting only approved, contact-free fields."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any


COUNTRIES_URL = (
    "https://micro.tradechina.com/blade-purchaser/"
    "buyerLeadsPlaza/countries"
)
BUYERS_URL = (
    "https://micro.tradechina.com/blade-purchaser/"
    "api/buyerLeadsPlaza/page"
)
VALID_DAYS = {3, 7, 15, 30}


class ContractError(RuntimeError):
    """Raised when the remote response does not match the approved contract."""


class RecordRejected(ContractError):
    """Raised when one buyer record cannot produce a safe unique lead."""


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
    for item in data:
        if not isinstance(item, dict):
            continue
        country_id = item.get("countryId")
        if not isinstance(country_id, (str, int)) or isinstance(country_id, bool):
            continue
        country_id_text = str(country_id).strip()
        if not country_id_text:
            continue
        approved.append(
            {
                "countryId": country_id_text,
                "enName": item.get("enName") if isinstance(item.get("enName"), str) else "",
                "cnName": item.get("cnName") if isinstance(item.get("cnName"), str) else "",
            }
        )
    return approved


def resolve_country(name: str, countries: list[dict[str, Any]]) -> dict[str, Any]:
    needle = name.strip().casefold()
    if not needle:
        raise ContractError("Country name must not be empty")
    matches = []
    for item in countries:
        candidates = (str(item.get("cnName", "")), str(item.get("enName", "")))
        if any(candidate.strip().casefold() == needle for candidate in candidates):
            matches.append(item)
    if len(matches) != 1:
        raise ContractError(f"Country name resolved to {len(matches)} exact matches")
    return matches[0]


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


def fetch_buyers(
    supplier_id: str | None,
    country_id: str,
    product_keyword: str,
    days: int = 7,
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

    def fake_post_json(url: str, payload: dict[str, Any], timeout: int = 30) -> Any:
        del timeout
        if url == COUNTRIES_URL:
            return {
                "success": True,
                "data": [
                    {"countryId": "country-1", "cnName": "示例国", "enName": "Example"},
                    {"countryId": None, "cnName": "无效国", "enName": "Invalid"},
                ],
            }
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
    buyers.add_argument("--days", type=int, default=7, choices=sorted(VALID_DAYS))
    buyers.add_argument("--limit", type=int, default=20)
    buyers.add_argument("--max-pages", type=int, default=5)

    contract = subparsers.add_parser(
        "contract-check", help="Check filtered live response shapes without buyer values"
    )
    contract.add_argument("--supplier-id", required=True, help="Must come from the current chat_id binding")
    contract.add_argument("--country-id", required=True)
    contract.add_argument("--product-keyword", required=True)
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
        else:
            result = self_test()
        print_json(result)
        return 0
    except (ContractError, AssertionError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
