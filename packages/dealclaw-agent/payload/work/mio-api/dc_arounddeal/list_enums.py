#!/usr/bin/env python
# -- coding: UTF-8 --
"""查 AroundDeal 数据字典。纯本地，免费，不发请求。

调接口前先用它把人话换成合法 ID，例如：
	python3 list_enums.py --field industry --search steel
	python3 list_enums.py --field job_level"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run

from arounddeal_client import (JOB_LEVELS, JOB_FUNCTIONS, EMPLOYEE_RANGES, COMPANY_TYPES,
							   INDUSTRIES, INDUSTRY_PARENTS, COUNTRIES, suggest)

TABLES = {
	"job_level": JOB_LEVELS,
	"function": JOB_FUNCTIONS,
	"employee_range": EMPLOYEE_RANGES,
	"company_type": COMPANY_TYPES,
	"industry": INDUSTRIES,
	"industry_parent": INDUSTRY_PARENTS,
	"country_code": COUNTRIES,
}


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-查数据字典（免费）")
	p.add_argument("--field", required=True, choices=sorted(TABLES), help="要查的字典")
	p.add_argument("--search", default=None, help="按名称模糊搜索（不传则全列）")
	p.add_argument("--suggest", default=None, help="把一个写法映射成合法值，如 --suggest CEO")
	args = p.parse_args()

	table = TABLES[args.field]
	if args.suggest is not None:
		field = "industry" if args.field == "industry_parent" else args.field
		fixed = suggest(field, args.suggest)
		emit({"success": fixed is not None, "tool": "list_enums",
			  "request": {"field": args.field, "suggest": args.suggest},
			  "data": {"input": args.suggest, "mapped_to": fixed,
					   "label": table.get(fixed) if fixed else None},
			  "msg": None if fixed else "映射不出来，请用 --search 关键词 自行查找"})
		return

	items = table.items()
	if args.search:
		kw = args.search.strip().lower()
		items = [(k, v) for k, v in items if kw in str(v).lower() or kw in str(k).lower()]
	else:
		items = list(items)
	emit({"success": True, "tool": "list_enums",
		  "request": {"field": args.field, "search": args.search},
		  "data": {"count": len(items), "values": [{"id": k, "label": v} for k, v in items]}})


if __name__ == "__main__":
	main()
