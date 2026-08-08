#!/usr/bin/env python3
"""Read-only client for 米奥数据圈选平台 API.

Token is read from env only. Never print token.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from typing import Any, Dict, Optional

import requests

BASE_URL = os.getenv("MIAO_DATA_SELECTION_BASE_URL", "https://supplier.datathink.com")
TOKEN_ENV_KEYS = ("MIAO_DATA_SELECTION_API_TOKEN", "MIAO_DATA_SELECTION_TOKEN")


class MiaoApiError(RuntimeError):
    pass


@dataclass
class MiaoClient:
    token: str
    base_url: str = BASE_URL
    timeout: int = 30

    @classmethod
    def from_env(cls) -> "MiaoClient":
        token = ""
        for key in TOKEN_ENV_KEYS:
            token = (os.getenv(key) or "").strip()
            if token:
                break
        if not token:
            raise MiaoApiError(f"Missing token env: one of {', '.join(TOKEN_ENV_KEYS)}")
        return cls(token=token)

    @property
    def headers(self) -> Dict[str, str]:
        return {"token": self.token, "Content-Type": "application/json; charset=utf-8"}

    def post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        url = self.base_url.rstrip("/") + path
        r = requests.post(
            url,
            headers=self.headers,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            timeout=self.timeout,
        )
        try:
            data = r.json()
        except Exception as exc:
            raise MiaoApiError(f"HTTP {r.status_code}, non-json response: {r.text[:200]}") from exc
        if r.status_code != 200:
            raise MiaoApiError(f"HTTP {r.status_code}: {data}")
        if data.get("errCode") not in (0, None):
            raise MiaoApiError(f"API errCode={data.get('errCode')}, errMsg={data.get('errMsg')}")
        return data

    def supplier_search(self, company_name: Optional[str] = None, **filters: Any) -> Dict[str, Any]:
        body: Dict[str, Any] = dict(filters)
        if company_name:
            body["company_name"] = company_name
        return self.post("/ds/authApi/dcZohoSupplierBusinessSearch", body)

    def business_info(self, tax_number: str) -> Dict[str, Any]:
        return self.post("/ds/authApi/dcDimBussinessInfo", {"tax_number": tax_number})

    def supplier_basic(self, tax_number: str) -> Dict[str, Any]:
        return self.post("/ds/authApi/dcDimZohoSupplierBusinessInfo", {"tax_number": tax_number})

    def trade_records(self, tax_number: str, page_num: int = 1, page_size: int = 10, **filters: Any) -> Dict[str, Any]:
        body = {"tax_number": tax_number, "page_num": page_num, "page_size": page_size, **filters}
        return self.post("/ds/authApi/dcTradeRecord", body)

    def export_trend(self, tax_number: str, **filters: Any) -> Dict[str, Any]:
        return self.post("/ds/authApi/dcExportTrend", {"tax_number": tax_number, **filters})

    def exhibitions(self, tax_number: str, exhibition_type: str = "1", page_num: int = 1, page_size: int = 10) -> Dict[str, Any]:
        return self.post(
            "/ds/authApi/dcHisExhibition",
            {"tax_number": tax_number, "exhibition_type": exhibition_type, "page_num": page_num, "page_size": page_size},
        )

    def product_tags(self, tax_number: str, page_num: int = 1, page_size: int = 10) -> Dict[str, Any]:
        return self.post("/ds/authApi/dcProductTagList", {"tax_number": tax_number, "page_num": page_num, "page_size": page_size})

    def exhibition_search(self, page_num: int = 1, page_size: int = 10, **filters: Any) -> Dict[str, Any]:
        return self.post("/ds/authApi/dcExhibitionSearch", {"page_num": page_num, "page_size": page_size, **filters})


def summarize(data: Dict[str, Any]) -> Dict[str, Any]:
    rows = data.get("data")
    item: Dict[str, Any] = {"errCode": data.get("errCode"), "errMsg": data.get("errMsg"), "total": data.get("total")}
    if isinstance(rows, list):
        item["data_count"] = len(rows)
        if rows and isinstance(rows[0], dict):
            item["first_keys"] = list(rows[0].keys())[:15]
    elif rows is not None:
        item["data_type"] = type(rows).__name__
    return item


def build_opportunity_card(client: MiaoClient, company_name: str) -> Dict[str, Any]:
    search = client.supplier_search(company_name=company_name)
    rows = search.get("data") or []
    if not rows:
        return {"company_name": company_name, "found": False, "search": summarize(search)}
    row = rows[0]
    tax = row.get("tax_number") or row.get("taxNumber")
    card: Dict[str, Any] = {
        "found": True,
        "company_name": row.get("company_name") or company_name,
        "tax_number": tax,
        "province": row.get("province"),
        "city": row.get("city"),
        "industry": row.get("indus_name_t0") or row.get("industry"),
        "products": row.get("company_products") or row.get("exhibition_product"),
        "last_exhibition_name": row.get("last_exhibition_name"),
        "exhibition_cnt": row.get("exhibition_cnt"),
        "website": row.get("offficial_website"),
    }
    if not tax:
        return card
    probes = {
        "business_info": lambda: client.business_info(tax),
        "supplier_basic": lambda: client.supplier_basic(tax),
        "trade_records": lambda: client.trade_records(tax, page_num=1, page_size=5),
        "export_trend": lambda: client.export_trend(tax, start_date="202401", end_date="202612"),
        "exhibitions_domestic": lambda: client.exhibitions(tax, exhibition_type="1", page_num=1, page_size=5),
        "product_tags": lambda: client.product_tags(tax, page_num=1, page_size=10),
    }
    card["api_summary"] = {}
    for name, fn in probes.items():
        try:
            card["api_summary"][name] = summarize(fn())
        except Exception as exc:
            card["api_summary"][name] = {"error": str(exc)}
    return card


def main() -> int:
    parser = argparse.ArgumentParser(description="Miao data selection read-only demo")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_probe = sub.add_parser("probe", help="Run sample endpoint probe")
    p_probe.add_argument("--company", default="江苏海狮汽车部件有限公司")
    p_card = sub.add_parser("card", help="Build sample opportunity card JSON")
    p_card.add_argument("--company", default="江苏海狮汽车部件有限公司")
    args = parser.parse_args()

    client = MiaoClient.from_env()
    if args.cmd == "probe":
        company = args.company
        search = client.supplier_search(company_name=company)
        rows = search.get("data") or []
        tax = rows[0].get("tax_number") if rows and isinstance(rows[0], dict) else ""
        result = {"supplier_search": summarize(search)}
        if tax:
            result.update({
                "business_info": summarize(client.business_info(tax)),
                "trade_records": summarize(client.trade_records(tax, page_num=1, page_size=5)),
                "supplier_basic": summarize(client.supplier_basic(tax)),
                "export_trend": summarize(client.export_trend(tax, start_date="202401", end_date="202612")),
                "exhibitions_domestic": summarize(client.exhibitions(tax, exhibition_type="1", page_num=1, page_size=5)),
                "product_tags": summarize(client.product_tags(tax, page_num=1, page_size=5)),
            })
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "card":
        print(json.dumps(build_opportunity_card(client, args.company), ensure_ascii=False, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
