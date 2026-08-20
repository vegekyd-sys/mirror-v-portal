#!/usr/bin/env python
# -- coding: UTF-8 --
"""找公司内的联系人：company_contact_discovery。

--limit 必填，上限 5。
务必优先传 --linkedin-url：实测同一家 Microsoft，传 linkedin_url
候选池 10001 人，传 website 只有 18 人且匹配到了子品牌。"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run

PRESETS = {
	"sourcing": (["CXO", "VP", "DIRECTOR", "MANAGER"],
				 ["PURCHASING", "SUPPLY_CHAIN", "LOGISTICS_AND_SUPPLY_CHAIN", "OPERATIONS"]),
	"brand": (["OWNER", "PARTNER", "CXO", "VP", "DIRECTOR"],
			  ["MARKETING", "PRODUCT_MANAGEMENT", "BD", "SALES"]),
}


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-找公司联系人")
	add_common_args(p)
	p.add_argument("--linkedin-url", default=None, help="公司 LinkedIn URL（强烈建议用这个）")
	p.add_argument("--website", default=None, help="公司官网域名")
	p.add_argument("--name", default=None, help="公司名称")
	p.add_argument("--preset", choices=sorted(PRESETS), default=None,
				   help="人群预设：sourcing=采购/供应链决策人，brand=高管/品牌负责人")
	p.add_argument("--job-level", default=None, help="职级，逗号分隔（覆盖预设）")
	p.add_argument("--function", default=None, help="职能，逗号分隔（覆盖预设）")
	p.add_argument("--country", default=None, help="联系人所在国家 ISO2，逗号分隔")
	p.add_argument("--require-business-email", action="store_true", help="只要有企业邮箱的")
	p.add_argument("--limit", type=int, default=None,
				   help="返回人数，必填，上限 5（不传会被拦下并返回 JSON 错误）")
	args = p.parse_args()

	jl = csv_list(args.job_level)
	fn = csv_list(args.function)
	if args.preset and not jl and not fn:
		jl, fn = PRESETS[args.preset]
	jl = norm_enum("job_level", jl)
	fn = norm_enum("function", fn)
	cc = norm_enum("country_code", csv_list(args.country))
	req = {"linkedin_url": args.linkedin_url, "website": args.website, "name": args.name,
		   "job_level": jl, "function": fn, "country_code": cc, "limit": args.limit,
		   "require_email_business": args.require_business_email or None}
	c = client(args)
	run("company_contact_discovery",
		lambda: c.company_contact_discovery(
			linkedin_url=args.linkedin_url, website=args.website, name=args.name,
			job_level=jl, function=fn, country_code=cc, limit=args.limit,
			require_email_business=args.require_business_email or None), req)


if __name__ == "__main__":
	main()
