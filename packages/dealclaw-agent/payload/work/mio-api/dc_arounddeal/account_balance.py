#!/usr/bin/env python
# -- coding: UTF-8 --
"""查询 AroundDeal 账户余额。"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ad import add_common_args, client, csv_list, emit, fail, norm_enum, run


def main() -> None:
	p = argparse.ArgumentParser(description="AroundDeal-查余额（免费）")
	add_common_args(p)
	args = p.parse_args()
	c = client(args)
	run("account_overview", lambda: c.account_overview(), {})


if __name__ == "__main__":
	main()
