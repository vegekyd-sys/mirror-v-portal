#!/usr/bin/env python
# -- coding: UTF-8 --
"""企业基本信息：POST /agent/company/getBasicInfo.json

接口文档标注「请求参数：暂无」，响应 data.companyId 即 supplierId。
默认不传 body（靠 X-Supplier-Id 头识别当前企业）；也可用 --company-id 显式指定。
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, post_json


def main() -> None:
    p = argparse.ArgumentParser(description="小元-获取企业基本信息 getBasicInfo")
    add_auth_args(p)
    p.add_argument(
        "--company-id",
        default="",
        help="企业ID（supplierId）。缺省则 body 留空，靠 X-Supplier-Id 头识别当前企业",
    )
    args = p.parse_args()

    company_id = (args.company_id or "").strip()
    body: dict = {}
    if company_id:
        body["companyId"] = company_id

    resp = post_json(
        base_url=args.base_url,
        path="/agent/company/getBasicInfo.json",
        body=body,
        open_id=args.open_id,
        supplier_id=args.supplier_id,
        timeout=args.timeout,
    )
    emit({"tool": "getBasicInfo", "request": body, "response": resp})


if __name__ == "__main__":
    main()
