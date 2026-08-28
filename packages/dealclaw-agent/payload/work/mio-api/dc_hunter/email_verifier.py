#!/usr/bin/env python
# -- coding: UTF-8 --
"""邮箱验证：email-verifier。可投递性 / score / smtp_check。"""
from __future__ import annotations
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _hunter import add_common_args, client, run

def main():
    p = argparse.ArgumentParser(description="Hunter-邮箱验证")
    add_common_args(p)
    p.add_argument("--email", required=True, help="要验证的邮箱")
    args = p.parse_args()
    req = {"email": args.email}
    c = client(args)
    run("email_verifier", lambda: c.email_verifier(args.email), req)

if __name__ == "__main__":
    main()
