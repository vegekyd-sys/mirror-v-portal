#!/usr/bin/env python
# -- coding: UTF-8 --
"""展会列表：POST /agent/buyer/selectAllExhibition.json"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _client import add_auth_args, emit, post_json


def main() -> None:
	p = argparse.ArgumentParser(description="小元-展会列表")
	add_auth_args(p)
	p.add_argument("--page", type=int, default=1)
	p.add_argument("--size", type=int, default=20)
	args = p.parse_args()

	body = {"page": args.page, "size": args.size}
	resp = post_json(
		base_url=args.base_url,
		path="/agent/buyer/selectAllExhibition.json",
		body=body,
		open_id=args.open_id,
		supplier_id=args.supplier_id,
		timeout=args.timeout,
	)
	emit({"tool": "selectAllExhibition", "request": body, "response": resp})


if __name__ == "__main__":
	main()
