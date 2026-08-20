#!/usr/bin/env python
# -- coding: UTF-8 --
"""查类目：POST /agent/colleague/getCategoryList.json"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, post_json


def main() -> None:
	import argparse

	p = argparse.ArgumentParser(description="小元-搜同行 getCategoryList")
	add_auth_args(p)
	p.add_argument("--tax-number", default="", help="税号；空则查当前登录供应商类目")
	args = p.parse_args()

	body = {}
	tax = (args.tax_number or "").strip()
	if tax:
		body["taxNumber"] = tax

	resp = post_json(
		base_url=args.base_url,
		path="/agent/colleague/getCategoryList.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "getCategoryList", "request": body, "response": resp})


if __name__ == "__main__":
	main()
