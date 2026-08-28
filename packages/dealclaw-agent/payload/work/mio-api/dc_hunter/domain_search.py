#!/usr/bin/env python
# -- coding: UTF-8 --
"""域名搜邮箱：domain-search。某公司所有人的邮箱 + 来源。"""
from __future__ import annotations
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _hunter import add_common_args, client, run

def main():
    p = argparse.ArgumentParser(description="Hunter-域名搜邮箱")
    add_common_args(p)
    p.add_argument("--domain", default=None, help="公司域名，如 stripe.com")
    p.add_argument("--company", default=None, help="公司名（domain 优先）")
    p.add_argument("--limit", type=int, default=10, help="返回邮箱数，默认10")
    p.add_argument("--type", default=None, help="personal / generic")
    p.add_argument("--seniority", default=None, help="junior/senior/executive（逗号分隔）")
    p.add_argument("--department", default=None, help="executive/it/finance/sales/procurement 等（逗号分隔）")
    p.add_argument("--decision-maker", action="store_true", help="只取决策人")
    args = p.parse_args()
    req = {"domain": args.domain, "company": args.company, "limit": args.limit}
    c = client(args)
    run("domain_search",
        lambda: c.domain_search(domain=args.domain, company=args.company, limit=args.limit,
                                type=args.type, seniority=args.seniority,
                                department=args.department,
                                decision_maker=args.decision_maker or None), req)

if __name__ == "__main__":
    main()
