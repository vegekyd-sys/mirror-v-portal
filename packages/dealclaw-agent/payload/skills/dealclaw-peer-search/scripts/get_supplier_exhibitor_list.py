#!/usr/bin/env python
# -- coding: UTF-8 --
"""按公司名查展商：POST /agent/colleague/getSupplierExhibitorList.json"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, post_json


def main() -> None:
	import argparse

	p = argparse.ArgumentParser(description="小元-搜同行 getSupplierExhibitorList")
	add_auth_args(p)
	p.add_argument("--company-name", required=True, help="公司名称关键字")
	p.add_argument("--page-num", type=int, default=1)
	p.add_argument("--page-size", type=int, default=10)
	args = p.parse_args()

	company_name = (args.company_name or "").strip()
	if not company_name:
		fail("请提供 --company-name")
		return

	body = {
		"companyName": company_name,
		"pageNum": args.page_num,
		"pageSize": args.page_size,
	}
	resp = post_json(
		base_url=args.base_url,
		path="/agent/colleague/getSupplierExhibitorList.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "getSupplierExhibitorList", "request": body, "response": resp})


if __name__ == "__main__":
	main()
