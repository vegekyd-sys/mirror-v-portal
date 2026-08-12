#!/usr/bin/env python
# -- coding: UTF-8 --
"""现场买家：POST /agent/buyer/onsiteBuyerSearch.json（勿传 supplierId，由 Header 换票注入）"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, parse_json_array, post_json


def main() -> None:
	p = argparse.ArgumentParser(description="小元-现场买家搜索")
	add_auth_args(p)
	p.add_argument("--exhibition-id", required=True, help="展会 ID")
	p.add_argument("--keywords-json", default="[]", help="产品关键词：solar 或 solar,led；亦支持 JSON 数组")
	p.add_argument("--exact-match-state", type=int, default=0, help="0否 1是")
	p.add_argument("--page-no", type=int, default=1)
	p.add_argument("--page-size", type=int, default=10)
	args = p.parse_args()

	exhibition_id = (args.exhibition_id or "").strip()
	if not exhibition_id:
		fail("exhibition-id 不能为空")
		return

	try:
		keywords = parse_json_array("keywords-json", args.keywords_json)
	except ValueError as e:
		fail(str(e))
		return

	# supplierId 由下游从鉴权上下文注入，这里不要带
	body = {
		"exhibitionId": exhibition_id,
		"keywords": keywords,
		"exactMatchState": args.exact_match_state,
		"pageNo": args.page_no,
		"pageSize": args.page_size,
	}
	resp = post_json(
		base_url=args.base_url,
		path="/agent/buyer/onsiteBuyerSearch.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "onsiteBuyerSearch", "request": body, "response": resp})


if __name__ == "__main__":
	main()
