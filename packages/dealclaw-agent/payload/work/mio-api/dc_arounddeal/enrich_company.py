#!/usr/bin/env python
# -- coding: UTF-8 --
"""公司画像富化：company_enrichment。$0.30/次。

匹配优先级 linkedin_url > website > name。只传域名/公司名可能匹配到子品牌
（实测 www.microsoft.com 命中 Microsoft for Startups），务必核对返回的
linkedin_identifier 是否为目标实体。"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-公司画像富化")
	add_common_args(p)
	p.add_argument("--linkedin-url", default=None, help="公司 LinkedIn URL（最准，优先用）")
	p.add_argument("--website", default=None, help="公司官网域名")
	p.add_argument("--name", default=None, help="公司名称")
	args = p.parse_args()

	req = {"linkedin_url": args.linkedin_url, "website": args.website, "name": args.name}
	c = client(args)
	run("company_enrichment",
		lambda: c.company_enrichment(linkedin_url=args.linkedin_url,
									 website=args.website, name=args.name), req)


if __name__ == "__main__":
	main()
