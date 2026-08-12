#!/usr/bin/env python
# -- coding: UTF-8 --
"""按公司名搜买家+贸易：POST /agent/buyer/searchCompanyNameWithTrade.json"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, post_json


def main() -> None:
	p = argparse.ArgumentParser(description="小元-按公司名搜买家")
	add_auth_args(p)
	p.add_argument("--company-name", required=True, help="公司名称")
	args = p.parse_args()

	name = (args.company_name or "").strip()
	if not name:
		fail("company-name 不能为空")
		return

	body = {"companyName": name}
	resp = post_json(
		base_url=args.base_url,
		path="/agent/buyer/searchCompanyNameWithTrade.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "searchCompanyNameWithTrade", "request": body, "response": resp})


if __name__ == "__main__":
	main()
