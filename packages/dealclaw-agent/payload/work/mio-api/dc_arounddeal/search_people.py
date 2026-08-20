#!/usr/bin/env python
# -- coding: UTF-8 --
"""按 persona 搜人：people_search。$0.30/次。

返回 {count, start, limit, list}，分页用 start+limit（不是 page）。
count 超过 10000 固定返回 10001。

注意：不要用已废弃的 role/seniority/region，改用 title/job-level/location。"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-搜人")
	add_common_args(p)
	p.add_argument("--title", default=None, help="职位关键词，自由文本，如 Purchasing Manager")
	p.add_argument("--job-level", default=None, help="职级，逗号分隔，如 CXO,DIRECTOR（不是 CEO）")
	p.add_argument("--function", default=None, help="职能，逗号分隔，如 PURCHASING,SUPPLY_CHAIN")
	p.add_argument("--country", default=None, help="人所在国家 ISO2，逗号分隔")
	p.add_argument("--location", default=None, help="地点关键词，如 New York")
	p.add_argument("--industry", default=None, help="行业 ID，逗号分隔")
	p.add_argument("--employee-range", default=None, help="公司规模档 A~I，逗号分隔")
	p.add_argument("--company-hq-country", default=None, help="公司总部国家 ISO2，逗号分隔")
	p.add_argument("--start", type=int, default=None, help="起始下标")
	p.add_argument("--limit", type=int, default=10, help="返回条数")
	args = p.parse_args()

	jl = norm_enum("job_level", csv_list(args.job_level))
	fn = norm_enum("function", csv_list(args.function))
	cc = norm_enum("country_code", csv_list(args.country))
	ind = norm_enum("industry", csv_list(args.industry))
	emp = norm_enum("employee_range", csv_list(args.employee_range))
	hq = norm_enum("company_hq_country_code", csv_list(args.company_hq_country))
	req = {"title": args.title, "job_level": jl, "function": fn, "country_code": cc,
		   "location": args.location, "industry": ind, "employee_range": emp,
		   "company_hq_country_code": hq, "start": args.start, "limit": args.limit}
	c = client(args)
	run("people_search",
		lambda: c.people_search(title=args.title, job_level=jl, function=fn,
								country_code=cc, location=args.location, industry=ind,
								employee_range=emp, company_hq_country_code=hq,
								start=args.start, limit=args.limit), req)


if __name__ == "__main__":
	main()
