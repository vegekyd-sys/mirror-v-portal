#!/usr/bin/env python
# -- coding: UTF-8 --
"""搜公司：discover。自然语言 query 或结构化过滤（行业/规模/类型/国家）。免费。"""
from __future__ import annotations
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _hunter import add_common_args, client, run

def _csv(raw):
    return [x.strip() for x in raw.split(",") if x.strip()] if raw else None

def main():
    p = argparse.ArgumentParser(description="Hunter-搜公司")
    add_common_args(p)
    p.add_argument("--query", default=None, help="自然语言，如 'Companies in Europe in the Tech Industry'")
    p.add_argument("--industry", default=None, help="行业（逗号分隔）")
    p.add_argument("--headcount", default=None, help="规模 1-10,11-50,51-200,201-500,501-1000,1001-5000,5001-10000,10001+（逗号分隔）")
    p.add_argument("--company-type", default=None, help="类型 privately held/public company 等（逗号分隔）")
    p.add_argument("--country", default=None, help="总部国家 ISO2（逗号分隔）")
    p.add_argument("--limit", type=int, default=None, help="每页条数（Premium）")
    args = p.parse_args()
    filters = {}
    if args.industry:
        filters["industry"] = {"include": _csv(args.industry)}
    if args.headcount:
        filters["headcount"] = _csv(args.headcount)
    if args.company_type:
        filters["company_type"] = {"include": _csv(args.company_type)}
    if args.country:
        filters["headquarters_location"] = {"include": [{"country": c} for c in _csv(args.country)]}
    if args.limit:
        filters["limit"] = args.limit
    req = {"query": args.query, **filters}
    c = client(args)
    run("discover", lambda: c.discover(query=args.query, filters=filters), req)

if __name__ == "__main__":
    main()
