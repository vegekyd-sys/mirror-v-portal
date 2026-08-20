#!/usr/bin/env python
# -- coding: UTF-8 --
"""搜同行列表：POST /agent/colleague/searchList.json"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, parse_json_array, post_json


def main() -> None:
	import argparse

	p = argparse.ArgumentParser(description="小元-搜同行 searchList")
	add_auth_args(p)
	p.add_argument("--t4-tag-ids-json", required=True, help="T4 类目 ID：t4_a 或 t4_a,t4_b")
	p.add_argument("--country", default="", help="出口国家二字码，如 US")
	p.add_argument("--export-scale", type=int, default=None, help="出口规模 0~4；美国勿传")
	p.add_argument("--staff-size", type=int, default=None, help="人员规模 0~3")
	p.add_argument("--search-type", type=int, default=1, help="1 精确匹配 2 推测匹配")
	p.add_argument("--data-source", type=int, default=1, help="1 Meo数据库 2 AI+Meo")
	p.add_argument("--province", default="", help="公司地址-省")
	p.add_argument("--city", default="", help="公司地址-市")
	p.add_argument("--district", default="", help="公司地址-区")
	p.add_argument(
		"--counties-json",
		default="",
		help='多地址 JSON，如 [{"province":"广东","city":"深圳","district":"南山"}]',
	)
	p.add_argument("--page-num", type=int, default=1)
	p.add_argument("--page-size", type=int, default=20)
	args = p.parse_args()

	try:
		t4_tag_ids = parse_json_array("t4-tag-ids-json", args.t4_tag_ids_json)
	except ValueError as e:
		fail(str(e))
		return
	if not t4_tag_ids:
		fail("请提供 --t4-tag-ids-json")
		return

	counties = []
	raw_counties = (args.counties_json or "").strip()
	if raw_counties:
		try:
			parsed = json.loads(raw_counties)
		except json.JSONDecodeError as e:
			fail(f"counties-json 不是合法 JSON: {e}")
			return
		if not isinstance(parsed, list):
			fail("counties-json 必须是 JSON 数组")
			return
		counties = parsed
	elif (args.province or "").strip() or (args.city or "").strip() or (args.district or "").strip():
		counties = [{
			"province": (args.province or "").strip() or None,
			"city": (args.city or "").strip() or None,
			"district": (args.district or "").strip() or None,
		}]

	body = {
		"t4TagIds": t4_tag_ids,
		"country": (args.country or "").strip() or None,
		"counties": counties,
		"exportScale": args.export_scale,
		"staffSize": args.staff_size,
		"searchType": args.search_type,
		"dataSource": args.data_source,
		"pageNum": args.page_num,
		"pageSize": args.page_size,
	}
	body = {k: v for k, v in body.items() if v is not None}

	resp = post_json(
		base_url=args.base_url,
		path="/agent/colleague/searchList.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "searchList", "request": body, "response": resp})


if __name__ == "__main__":
	main()
