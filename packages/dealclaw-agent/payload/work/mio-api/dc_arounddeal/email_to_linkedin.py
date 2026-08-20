#!/usr/bin/env python
# -- coding: UTF-8 --
"""邮箱反查 LinkedIn 档案：email_to_linkedin_profile。$0.50/次。

注意该接口返回的 function 是 string，而 people_* 系列是 array。
实测出现过 company_name 与 company_linkedin_url 不一致的情况，用前请核对。"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-邮箱反查 LinkedIn")
	add_common_args(p)
	p.add_argument("--email", required=True, help="工作邮箱")
	args = p.parse_args()

	c = client(args)
	run("email_to_linkedin_profile",
		lambda: c.email_to_linkedin_profile(args.email), {"email": args.email})


if __name__ == "__main__":
	main()
