#!/usr/bin/env python
# -- coding: UTF-8 --
"""邮箱查找：email-finder。域名 + 姓名 → 最可能邮箱。找不到不扣费。"""
from __future__ import annotations
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _hunter import add_common_args, client, run

def main():
    p = argparse.ArgumentParser(description="Hunter-邮箱查找")
    add_common_args(p)
    p.add_argument("--domain", default=None, help="公司域名")
    p.add_argument("--company", default=None, help="公司名（domain 优先）")
    p.add_argument("--linkedin-handle", default=None, help="LinkedIn 个人主页 handle")
    p.add_argument("--first-name", default=None, help="名")
    p.add_argument("--last-name", default=None, help="姓")
    p.add_argument("--full-name", default=None, help="全名（不如名+姓准）")
    args = p.parse_args()
    req = {"domain": args.domain, "first_name": args.first_name, "last_name": args.last_name}
    c = client(args)
    run("email_finder",
        lambda: c.email_finder(domain=args.domain, company=args.company,
                               linkedin_handle=args.linkedin_handle,
                               first_name=args.first_name, last_name=args.last_name,
                               full_name=args.full_name), req)

if __name__ == "__main__":
    main()
