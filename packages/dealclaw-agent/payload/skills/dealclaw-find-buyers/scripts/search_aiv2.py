#!/usr/bin/env python
# -- coding: UTF-8 --
"""多条件搜买家：POST /agent/buyer/searchAIV2.json"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, fail, parse_json_array, post_json


def main() -> None:
	p = argparse.ArgumentParser(description="小元-多条件搜买家 searchAIV2")
	add_auth_args(p)
	p.add_argument("--tag-keyword", default="", help="产品/品牌关键词（英文优先）")
	p.add_argument("--company-name", default="", help="公司名关键字")
	p.add_argument("--profile-keyword", default="", help="公司简介关键字")
	p.add_argument("--countries-json", default="[]", help="国家二字码：RU 或 RU,US；亦支持 JSON 数组")
	p.add_argument("--pre-exhibition-ids-json", default="[]", help="展会预注册买家过滤：展会 ID 数组，如 152996309411 或 152996309411,xxx")
	p.add_argument("--features-json", default="[]", help="features：5,7 或 [5,7]")
	p.add_argument("--company-info-json", default="[]", help="companyInfo：1,3 或 [1,3]")
	p.add_argument("--contact-info-json", default="[]", help="contactInfo：3,4 或 [3,4]")
	p.add_argument("--company-attributes-json", default="[]", help="companyAttributes：2,3（字符串元素）")
	p.add_argument("--staff-size-level-json", default="[]", help="staffSizeLevel：2 或 [2,3]")
	p.add_argument("--trade-scale-level-json", default="[]", help="tradeScaleLevel：3 或 [2,3]")
	p.add_argument("--annual-revenue-level-json", default="[]", help="annualRevenueLevel：3 或 [3,4]")
	p.add_argument("--page-num", type=int, default=1)
	p.add_argument("--page-size", type=int, default=100)
	p.add_argument("--sort-type", type=int, default=2, help="0不排 1VIP到展 2综合")
	p.add_argument("--search-similarity", action="store_true")

	# 状态过滤（依赖 supplierId/ppsId 真实值）
	p.add_argument("--invitation-flag", type=int, default=None, help="邀约状态: 0未邀约 1已邀约 2全部")
	p.add_argument("--check-flag", type=int, default=None, help="查看状态: 0未查看 1已查看 2全部")
	p.add_argument("--unlock-flag", type=int, default=None, help="解锁标记: 0未解锁 1已解锁 2全部")
	# 触达条件
	p.add_argument("--require-contact", action="store_true", help="至少有一种联系方式")
	# 翻页
	p.add_argument("--backend-param", default=None, help="翻页 token（第2页起回传上次响应值）")
	# company-attributes 扩展编码 6-9: 6物流 7媒体 8咨询 9商超
	args = p.parse_args()

	try:
		body = {
			"tagKeyword": args.tag_keyword or "",
			"companyName": args.company_name or "",
			"profileKeyword": args.profile_keyword or "",
			"countries": parse_json_array("countries-json", args.countries_json),
			"preExhibitionIds": parse_json_array("pre-exhibition-ids-json", args.pre_exhibition_ids_json),
			"features": parse_json_array("features-json", args.features_json),
			"companyInfo": parse_json_array("company-info-json", args.company_info_json),
			"contactInfo": parse_json_array("contact-info-json", args.contact_info_json),
			"companyAttributes": parse_json_array("company-attributes-json", args.company_attributes_json),
			"staffSizeLevel": parse_json_array("staff-size-level-json", args.staff_size_level_json),
			"tradeScaleLevel": parse_json_array("trade-scale-level-json", args.trade_scale_level_json),
			"annualRevenueLevel": parse_json_array("annual-revenue-level-json", args.annual_revenue_level_json),
			"pageNum": args.page_num,
			"pageSize": args.page_size,
			"sortType": args.sort_type,
			"searchSimilarity": bool(args.search_similarity),
			"invitationFlag": args.invitation_flag,
			"checkFlag": args.check_flag,
			"unlockFlag": args.unlock_flag,
			"requireContact": bool(args.require_contact) if args.require_contact else None,
			"backendParam": args.backend_param or "",
		}
	except ValueError as e:
		fail(str(e))
		return

	resp = post_json(
		base_url=args.base_url,
		path="/agent/buyer/searchAIV2.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "searchAIV2", "request": body, "response": resp})


if __name__ == "__main__":
	main()
