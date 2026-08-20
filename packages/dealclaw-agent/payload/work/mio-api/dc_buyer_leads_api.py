#!/usr/bin/env python3
"""
买家线索广场 API 客户端 (TradeChina Blade Microservice)

接口: POST https://micro.tradechina.com/blade-purchaser/api/buyerLeadsPlaza/page
用途: DC-LS 第四数据源 — 产品关键词+国家直接搜索买家线索
"""

import json
import os
import sys
import urllib.request
import urllib.error
from typing import Optional

API_BASE = "https://micro.tradechina.com/blade-purchaser/api"
BUYER_LEADS_URL = f"{API_BASE}/buyerLeadsPlaza/page"

# Auth: 无需鉴权（公开 API）


class BuyerLeadsError(Exception):
    def __init__(self, status: int, msg: str):
        self.status = status
        self.msg = msg
        super().__init__(f"[{status}] {msg}")


def search_buyer_leads(
    product_keyword: str = "",
    country_id: str = "",
    consolidated_days: int = 30,
    contact_status: Optional[int] = None,
    manual_recommend: Optional[int] = None,
    supplier_id: str = "",
    t1_id: str = "",
    t2_id: str = "",
    page: int = 1,
    limit: int = 20,
) -> dict:
    """
    分页查询买家线索广场

    Args:
        product_keyword: 产品关键词（英文）
        country_id: 买家国家 ID
        consolidated_days: 线索合并时间范围 3/7/15/30
        contact_status: 沟通状态 1=已联系 2=已回复
        manual_recommend: 是否推荐 1=是
        supplier_id: 展商 ID
        t1_id: 一级分类 ID
        t2_id: 二级分类 ID
        page: 页码
        limit: 页长

    Returns:
        API 响应 dict，包含 records / total / pages
    """
    # 无需鉴权

    req_data = {
        "consolidatedDays": consolidated_days,
        "limit": limit,
        "page": page,
    }
    if product_keyword:
        req_data["productKeyword"] = product_keyword
    if country_id:
        req_data["countryId"] = country_id
    if contact_status is not None:
        req_data["contactStatus"] = contact_status
    if manual_recommend is not None:
        req_data["manualRecommend"] = manual_recommend
    if supplier_id:
        req_data["supplierId"] = supplier_id
    if t1_id:
        req_data["t1Id"] = t1_id
    if t2_id:
        req_data["t2Id"] = t2_id

    body = json.dumps(req_data).encode("utf-8")

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    # 公开 API，无需 Authorization header

    req = urllib.request.Request(BUYER_LEADS_URL, data=body, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise BuyerLeadsError(e.code, f"HTTP {e.code}: {e.reason}")
    except urllib.error.URLError as e:
        raise BuyerLeadsError(0, f"网络错误: {e.reason}")

    if not raw.get("success"):
        raise BuyerLeadsError(raw.get("code", -1), raw.get("msg", "未知错误"))

    return raw["data"]


def search_buyers(
    keyword: str,
    country_id: str = "",
    limit: int = 10,
    consolidated_days: int = 30,
    supplier_id: str = "123456",
) -> list[dict]:
    """
    简化接口：搜索买家，返回去重后的 records 列表

    对应 DC-LS 管道调用:
      buyer_leads = search_buyers("hand tools", country_id="PL", limit=10)

    返回每条记录的简洁版:
      {company, country, companyCdpId, products, profile, contactStatus, tags}
    """
    data = search_buyer_leads(
        product_keyword=keyword,
        country_id=country_id,
        limit=limit,
        consolidated_days=consolidated_days,
        supplier_id=supplier_id,
    )

    records = data.get("records", [])
    simplified = []
    for r in records:
        products = [p.get("productNameEn", "") or p.get("productName", "")
                    for p in r.get("productList", [])]
        simplified.append({
            "id": r.get("id"),
            "company": r.get("buyerCompany"),
            "country": r.get("buyerCountry"),
            "countryId": r.get("countryId"),
            "companyCdpId": r.get("companyCdpId"),
            "companyProfile": r.get("companyProfile"),
            "products": products,
            "tags": (r.get("buyerTag") or "").split(";") if r.get("buyerTag") else [],
            "recentTrend": r.get("recentTrend"),
            "contactStatus": r.get("contactStatus"),
            "t1": r.get("t1"),
            "t2": r.get("t2"),
            "exhibitionName": r.get("exhibitionName"),
            "unlockStatus": r.get("unlockStatus"),
        })
    return simplified


# ── CLI ──
if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="TradeChina 买家线索广场搜索")
    ap.add_argument("keyword", help="产品关键词（英文）")
    ap.add_argument("--country", "-c", default="", help="国家 ID")
    ap.add_argument("--limit", "-n", type=int, default=10, help="返回条数")
    ap.add_argument("--days", "-d", type=int, default=30, help="线索合并天数")
    ap.add_argument("--supplier", "-s", default="123456", help="展商ID")
    ap.add_argument("--json", action="store_true", help="输出原始 JSON")
    ap.add_argument("--page", "-p", type=int, default=1, help="页码")
    args = ap.parse_args()

    try:
        if args.json:
            data = search_buyer_leads(
                product_keyword=args.keyword,
                country_id=args.country,
                limit=args.limit,
                consolidated_days=args.days,
                page=args.page,
                supplier_id=args.supplier,
            )
            print(json.dumps(data, ensure_ascii=False, indent=2))
        else:
            buyers = search_buyers(
                keyword=args.keyword,
                country_id=args.country,
                limit=args.limit,
                consolidated_days=args.days,
                supplier_id=args.supplier,
            )
            print(json.dumps({
                "status": "success",
                "summary": f"📊 {args.keyword} ({args.country or 'all'}) — {len(buyers)} 条",
                "records": buyers,
                "total_available": len(buyers),
            }, ensure_ascii=False, indent=2))
    except BuyerLeadsError as e:
        print(json.dumps({"status": "error", "code": e.status, "message": e.msg}, ensure_ascii=False))
        sys.exit(1)
