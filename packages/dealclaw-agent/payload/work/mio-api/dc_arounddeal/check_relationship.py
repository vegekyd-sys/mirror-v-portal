#!/usr/bin/env python
# -- coding: UTF-8 --
"""判断两家公司是否存在关联：company_relationship_check。$0.30/次。

只返回一个 type 枚举，没有置信度也没有证据来源，做尽调时证据链偏弱。
取值：SAME/INVESTMENT/PARENT/SUPPLY_CHAIN/SHARED_PEOPLE/PARTNERSHIP/NO_RELATIONS"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-公司关联判断")
	add_common_args(p)
	p.add_argument("--name-a", default=None, help="公司 A 名称")
	p.add_argument("--website-a", default=None, help="公司 A 官网")
	p.add_argument("--name-b", default=None, help="公司 B 名称")
	p.add_argument("--website-b", default=None, help="公司 B 官网")
	args = p.parse_args()

	req = {"name_a": args.name_a, "website_a": args.website_a,
		   "name_b": args.name_b, "website_b": args.website_b}
	c = client(args)
	run("company_relationship_check",
		lambda: c.company_relationship_check(**req), req)


if __name__ == "__main__":
	main()
