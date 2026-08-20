#!/usr/bin/env python
# -- coding: UTF-8 --
"""按条件搜公司：company_search。$0.10/次。

size 上限 10、page 上限 1000；count 超过 10000 时固定返回 10001。
行业要传数字 ID，不是名称 —— 用 list_enums.py 查。"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-搜公司")
	add_common_args(p)
	p.add_argument("--keyword", default=None, help="关键词")
	p.add_argument("--country", default=None, help="国家 ISO2，逗号分隔，如 US,DE")
	p.add_argument("--industry", default=None, help="行业 ID，逗号分隔，如 1594（用 list_enums.py 查）")
	p.add_argument("--employee-range", default=None, help="规模档 A~I，逗号分隔（A 最小，I 最大）")
	p.add_argument("--page", type=int, default=None, help="页码，上限 1000")
	p.add_argument("--size", type=int, default=None, help="每页条数，上限 10")
	args = p.parse_args()

	country = norm_enum("country_code", csv_list(args.country))
	industry = norm_enum("industry", csv_list(args.industry))
	emp = norm_enum("employee_range", csv_list(args.employee_range))
	req = {"keyword": args.keyword, "country_code": country, "industry": industry,
		   "employee_range": emp, "page": args.page, "size": args.size}
	c = client(args)
	run("company_search",
		lambda: c.company_search(keyword=args.keyword, country_code=country,
								 industry=industry, employee_range=emp,
								 page=args.page, size=args.size), req)


if __name__ == "__main__":
	main()
