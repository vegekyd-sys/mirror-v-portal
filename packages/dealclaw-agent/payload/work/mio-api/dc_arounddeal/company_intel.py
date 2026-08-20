#!/usr/bin/env python
# -- coding: UTF-8 --
"""公司情报，6 选 1：clients / suppliers / events / products / jobs / orgchart。

注意 jobs 命中但无在招职位时会返回空 list；events 只覆盖近 12 个月；
clients/suppliers 只返回 name+website 两个字段。"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run

TYPES = ("clients", "suppliers", "events", "products", "jobs", "orgchart")


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-公司情报")
	add_common_args(p)
	p.add_argument("--type", required=True, choices=TYPES, help="要查的情报类型")
	p.add_argument("--linkedin-url", default=None, help="公司 LinkedIn URL（jobs/orgchart 支持）")
	p.add_argument("--website", default=None, help="公司官网域名")
	p.add_argument("--name", default=None, help="公司名称")
	args = p.parse_args()

	c = client(args)
	req = {"type": args.type, "linkedin_url": args.linkedin_url,
		   "website": args.website, "name": args.name}
	kw_nw = {"name": args.name, "website": args.website}
	kw_all = {"linkedin_url": args.linkedin_url, "website": args.website, "name": args.name}
	table = {
		"clients":   ("company_clients",   lambda: c.company_clients(**kw_nw)),
		"suppliers": ("company_suppliers", lambda: c.company_suppliers(**kw_nw)),
		"events":    ("company_events",    lambda: c.company_events(**kw_nw)),
		"products":  ("company_product",   lambda: c.company_product(**kw_nw)),
		"jobs":      ("company_job",       lambda: c.company_job(**kw_all)),
		"orgchart":  ("orgchart",          lambda: c.orgchart(**kw_all)),
	}
	tool, call = table[args.type]
	run(tool, call, req)


if __name__ == "__main__":
	main()
