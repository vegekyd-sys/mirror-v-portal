#!/usr/bin/env python
# -- coding: UTF-8 --
"""同行买家类目：POST /agent/colleague/getBuyerCategoryList.json"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, parse_json_array, post_json


def main() -> None:
	import argparse

	p = argparse.ArgumentParser(description="小元-搜同行 getBuyerCategoryList")
	add_auth_args(p)
	p.add_argument("--supplier-ids-json", required=True, help="同行 id：123 或 123,456（searchList.records[].id）")
	p.add_argument("--countries-json", default="", help="国家二字码：US 或 US,DE")
	args = p.parse_args()

	try:
		supplier_ids = parse_json_array("supplier-ids-json", args.supplier_ids_json)
		countries = parse_json_array("countries-json", args.countries_json)
	except ValueError as e:
		fail(str(e))
		return
	if not supplier_ids:
		fail("请提供 --supplier-ids-json")
		return

	body = {"supplierIds": supplier_ids, "countries": countries}
	resp = post_json(
		base_url=args.base_url,
		path="/agent/colleague/getBuyerCategoryList.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "getBuyerCategoryList", "request": body, "response": resp})


if __name__ == "__main__":
	main()
