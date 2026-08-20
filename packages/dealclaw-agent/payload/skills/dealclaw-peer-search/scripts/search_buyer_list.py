#!/usr/bin/env python
# -- coding: UTF-8 --
"""同行买家列表：POST /agent/colleague/searchBuyerList.json"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, parse_json_array, post_json


def main() -> None:
	import argparse

	p = argparse.ArgumentParser(description="小元-搜同行 searchBuyerList")
	add_auth_args(p)
	p.add_argument("--supplier-ids-json", required=True, help="同行 id：123 或 123,456（searchList.records[].id）")
	p.add_argument("--countries-json", default="", help="国家二字码：US 或 US,DE")
	p.add_argument("--tag-ids-json", default="", help="买家交易类目 T4 ID")
	p.add_argument("--exhibition-ids-json", default="", help="展会 ID")
	p.add_argument("--is-contact-info", type=int, default=None, help="有联系方式：0/1")
	p.add_argument("--is-miao", type=int, default=None, help="米奥到展：0/1")
	p.add_argument("--is-vip", type=int, default=None, help="VIP：0/1")
	p.add_argument("--sort-type", type=int, default=3, help="1 VIP到展 2 次数 3 金额 4 时间")
	p.add_argument("--page-num", type=int, default=1)
	p.add_argument("--page-size", type=int, default=20)
	args = p.parse_args()

	try:
		supplier_ids = parse_json_array("supplier-ids-json", args.supplier_ids_json)
		countries = parse_json_array("countries-json", args.countries_json)
		tag_ids = parse_json_array("tag-ids-json", args.tag_ids_json)
		exhibition_ids = parse_json_array("exhibition-ids-json", args.exhibition_ids_json)
	except ValueError as e:
		fail(str(e))
		return
	if not supplier_ids:
		fail("请提供 --supplier-ids-json")
		return

	body = {
		"supplierIds": supplier_ids,
		"countries": countries,
		"tagIds": tag_ids,
		"exhibitionIds": exhibition_ids,
		"isContactInfo": args.is_contact_info,
		"isMiao": args.is_miao,
		"isVip": args.is_vip,
		"sortType": args.sort_type,
		"pageNum": args.page_num,
		"pageSize": args.page_size,
	}
	body = {k: v for k, v in body.items() if v is not None}

	resp = post_json(
		base_url=args.base_url,
		path="/agent/colleague/searchBuyerList.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "searchBuyerList", "request": body, "response": resp})


if __name__ == "__main__":
	main()
