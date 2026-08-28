#!/usr/bin/env python
# -- coding: UTF-8 --
"""人富化：people/find。email / linkedin → 个人信息（姓名/职位/公司/地点）。"""
from __future__ import annotations
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _hunter import add_common_args, client, run

def main():
    p = argparse.ArgumentParser(description="Hunter-人富化")
    add_common_args(p)
    p.add_argument("--email", default=None, help="邮箱")
    p.add_argument("--linkedin-handle", default=None, help="LinkedIn handle（优先级高于 email）")
    args = p.parse_args()
    req = {"email": args.email, "linkedin_handle": args.linkedin_handle}
    c = client(args)
    run("people_find",
        lambda: c.people_find(email=args.email, linkedin_handle=args.linkedin_handle), req)

if __name__ == "__main__":
    main()
