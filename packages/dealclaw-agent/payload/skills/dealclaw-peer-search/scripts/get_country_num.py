#!/usr/bin/env python
# -- coding: UTF-8 --
"""各国同行数量：POST /agent/colleague/getCountryNum.json"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, parse_json_array, post_json


def main() -> None:
	import argparse

	p = argparse.ArgumentParser(description="小元-搜同行 getCountryNum")
	add_auth_args(p)
	p.add_argument("--t4-tag-ids-json", required=True, help="T4 类目 ID：t4_a 或 t4_a,t4_b")
	args = p.parse_args()

	try:
		t4_tag_ids = parse_json_array("t4-tag-ids-json", args.t4_tag_ids_json)
	except ValueError as e:
		fail(str(e))
		return
	if not t4_tag_ids:
		fail("请提供 --t4-tag-ids-json")
		return

	body = {"t4TagIds": t4_tag_ids}
	resp = post_json(
		base_url=args.base_url,
		path="/agent/colleague/getCountryNum.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "getCountryNum", "request": body, "response": resp})


if __name__ == "__main__":
	main()
