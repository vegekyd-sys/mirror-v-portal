#!/usr/bin/env python
# -- coding: UTF-8 --
"""公司富化：companies/find。domain / company → 公司信息。"""
from __future__ import annotations
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _hunter import add_common_args, client, run

def main():
    p = argparse.ArgumentParser(description="Hunter-公司富化")
    add_common_args(p)
    p.add_argument("--domain", default=None, help="公司域名")
    p.add_argument("--company", default=None, help="公司名（domain 优先）")
    args = p.parse_args()
    req = {"domain": args.domain, "company": args.company}
    c = client(args)
    run("companies_find",
        lambda: c.companies_find(domain=args.domain, company=args.company), req)

if __name__ == "__main__":
    main()
