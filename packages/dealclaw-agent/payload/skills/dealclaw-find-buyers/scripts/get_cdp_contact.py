#!/usr/bin/env python
# -- coding: UTF-8 --
"""买家联系人：POST /agent/buyer/aiSearchGetCdpContact.json"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, parse_json_array, post_json


def main() -> None:
	p = argparse.ArgumentParser(description="小元-买家联系人 aiSearchGetCdpContact")
	add_auth_args(p)
	p.add_argument(
		"--company-cdp-ids-json",
		required=True,
		help="公司 CDP ID：单个 CDP_ID，或多个 CDP1,CDP2；亦支持 JSON 数组",
	)
	p.add_argument("--page-num", type=int, default=1)
	p.add_argument("--page-size", type=int, default=10)
	p.add_argument("--is-previous-on-exhibition-buyer", choices=["true", "false"], default=None)
	p.add_argument("--is-this-exhibition-pre-buyer", choices=["true", "false"], default=None)
	p.add_argument("--is-kp", choices=["true", "false"], default=None)
	args = p.parse_args()

	try:
		ids = parse_json_array("company-cdp-ids-json", args.company_cdp_ids_json)
	except ValueError as e:
		fail(str(e))
		return
	if not ids:
		fail("company-cdp-ids-json 不能为空数组")
		return

	body = {
		"companyCdpIds": ids,
		"pageNum": args.page_num,
		"pageSize": args.page_size,
	}
	if args.is_previous_on_exhibition_buyer is not None:
		body["isPreviousOnExhibitionBuyer"] = args.is_previous_on_exhibition_buyer == "true"
	if args.is_this_exhibition_pre_buyer is not None:
		body["isThisExhibitionPreBuyer"] = args.is_this_exhibition_pre_buyer == "true"
	if args.is_kp is not None:
		body["isKp"] = args.is_kp == "true"

	resp = post_json(
		base_url=args.base_url,
		path="/agent/buyer/aiSearchGetCdpContact.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "aiSearchGetCdpContact", "request": body, "response": resp})


if __name__ == "__main__":
	main()
