#!/usr/bin/env python
# -- coding: UTF-8 --
"""验证邮箱或手机号。邮箱 $0.01/次，手机 $0.02/次 —— 全线最便宜，
清洗存量联系人数据优先用这个。"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-联系方式验证")
	add_common_args(p)
	p.add_argument("--email", default=None, help="要验证的邮箱")
	p.add_argument("--phone", default=None, help="要验证的手机号，E.164 格式如 +8613512345678")
	args = p.parse_args()

	if not args.email and not args.phone:
		fail("必须提供 --email 或 --phone 之一")
	c = client(args)
	if args.email:
		run("contact_verification_email", lambda: c.verify_email(args.email), {"email": args.email})
	else:
		run("contact_verification_phone", lambda: c.verify_phone(args.phone), {"phone": args.phone})


if __name__ == "__main__":
	main()
