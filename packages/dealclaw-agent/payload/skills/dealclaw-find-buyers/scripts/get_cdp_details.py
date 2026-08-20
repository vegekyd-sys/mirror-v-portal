#!/usr/bin/env python
# -- coding: UTF-8 --
"""买家详情：POST /agent/buyer/getCdpDetails.json"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, post_json


def main() -> None:
	p = argparse.ArgumentParser(description="小元-买家详情 getCdpDetails")
	add_auth_args(p)
	p.add_argument("--company-cdp-id", required=True, help="公司 CDP ID")
	args = p.parse_args()

	cdp_id = (args.company_cdp_id or "").strip()
	if not cdp_id:
		fail("company-cdp-id 不能为空")
		return

	body = {"companyCdpId": cdp_id}
	resp = post_json(
		base_url=args.base_url,
		path="/agent/buyer/getCdpDetails.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "getCdpDetails", "request": body, "response": resp})


if __name__ == "__main__":
	main()
