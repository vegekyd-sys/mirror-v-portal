#!/usr/bin/env python
# -- coding: UTF-8 --
"""人物富化。默认 people_enrichment（联系方式+当前职位，$0.10~0.50）；
加 --resume 改用 resume_enrichment（履历/教育/技能，$0.10，但不含邮箱电话）。

两者互补，要完整画像需分别调用两次。"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-人物富化")
	add_common_args(p)
	p.add_argument("--linkedin-url", default=None, help="个人 LinkedIn URL")
	p.add_argument("--email", default=None, help="邮箱")
	p.add_argument("--name", default=None, help="姓名（需同时给 --company）")
	p.add_argument("--company", default=None, help="公司名（配合 --name）")
	p.add_argument("--resume", action="store_true",
				   help="改查履历/教育/技能（resume_enrichment），不返回邮箱电话")
	args = p.parse_args()

	c = client(args)
	if args.resume:
		req = {"linkedin_url": args.linkedin_url, "email": args.email}
		run("resume_enrichment",
			lambda: c.resume_enrichment(linkedin_url=args.linkedin_url, email=args.email), req)
	else:
		req = {"linkedin_url": args.linkedin_url, "email": args.email,
			   "name": args.name, "company": args.company}
		run("people_enrichment",
			lambda: c.people_enrichment(linkedin_url=args.linkedin_url, email=args.email,
										name=args.name, company=args.company), req)


if __name__ == "__main__":
	main()
