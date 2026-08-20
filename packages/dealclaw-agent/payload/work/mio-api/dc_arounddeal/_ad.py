#!/usr/bin/env python
# -- coding: UTF-8 --
"""AroundDeal skill 的公共客户端层：鉴权、枚举纠错、统一 JSON 输出。

约定与 dealclaw-find-buyers/scripts/_client.py 一致：
emit() 打印 JSON，fail() 输出 {"success": false, "msg", "data"} 并退出。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from arounddeal_client import (  # noqa: E402
	AroundDealClient, AroundDealParamError,
	JOB_LEVELS, JOB_FUNCTIONS, EMPLOYEE_RANGES, COMPANY_TYPES,
	INDUSTRIES, INDUSTRY_PARENTS, INDUSTRY_SUBS, COUNTRIES,
	KNOWN_JOB_FUNCTIONS, describe, suggest,
)


def emit(result: Dict[str, Any]) -> None:
	print(json.dumps(result, ensure_ascii=False, indent=2))


def fail(msg: str, code: int = 2, **extra: Any) -> None:
	payload = {"success": False, "msg": msg, "data": None}
	payload.update(extra)
	emit(payload)
	sys.exit(code)


def add_common_args(p: argparse.ArgumentParser) -> None:
	p.add_argument("--timeout", type=int, default=60, help="HTTP 超时秒数")
	p.add_argument("--api-key", default=None, help="覆盖 AROUNDDEAL_API_KEY（默认从 .env 自动加载）")


def client(args: argparse.Namespace) -> AroundDealClient:
	return AroundDealClient(api_key=getattr(args, "api_key", None),
							timeout=getattr(args, "timeout", 60), strict=True)


def csv_list(raw: Optional[str]) -> Optional[List[str]]:
	"""把 "A,B,C" 拆成列表；空值返回 None（不进请求体）。"""
	if raw is None:
		return None
	items = [x.strip() for x in str(raw).split(",") if x.strip()]
	return items or None


# 纠错累积：模型写错但能自动映射的，记下来一起回传，让它下次写对
_CORRECTIONS: List[Dict[str, str]] = []


def norm_enum(field: str, values: Optional[List[str]]) -> Optional[List[str]]:
	"""把模型写的人话映射成合法枚举值；映射不出来直接 fail 并给出合法取值。"""
	if not values:
		return None
	out = []
	for v in values:
		fixed = suggest(field, v)
		if fixed is None:
			_fail_enum(field, v)
		if str(fixed) != str(v):
			_CORRECTIONS.append({"field": field, "from": str(v), "to": str(fixed),
								 "label": describe(field, fixed)})
		out.append(fixed)
	return out


def _fail_enum(field: str, value: str) -> None:
	tables = {"job_level": JOB_LEVELS, "function": JOB_FUNCTIONS,
			  "employee_range": EMPLOYEE_RANGES, "industry": INDUSTRIES,
			  "country_code": COUNTRIES, "company_hq_country_code": COUNTRIES}
	table = tables.get(field, {})
	if len(table) <= 30:
		legal = {k: v for k, v in table.items()}
		hint = "见 legal_values"
	else:
		legal = None
		hint = "取值太多，用 `python3 list_enums.py --field %s --search <关键词>` 查 ID" % field
	fail("%s=%r 不是合法值。%s" % (field, value, hint),
		 field=field, bad_value=value, legal_values=legal,
		 lookup="python3 list_enums.py --field %s" % field)


def run(tool: str, call, request: Dict[str, Any]) -> None:
	"""执行调用并按统一契约输出。参数错误在发请求前被拦下，请求不会发出。

	call 是零参可调用对象，例如 lambda: c.company_enrichment(website=...)
	"""
	try:
		resp = call()
	except AroundDealParamError as e:
		fail(str(e), tool=tool, request=request, sent=False)
		return
	except ValueError as e:
		fail(str(e), tool=tool, request=request, sent=False)
		return

	ok = bool(resp.get("success"))
	out: Dict[str, Any] = {
		"success": ok,
		"tool": tool,
		"request": request,
		"data": resp.get("data"),
	}
	if _CORRECTIONS:
		out["corrections"] = _CORRECTIONS
		out["msg"] = "部分参数已自动纠正，请按 corrections 里的 to 值书写"
	if not ok:
		err = resp.get("error") or {}
		out["msg"] = "%s: %s" % (err.get("code", "?"), err.get("detail") or "(无 detail)")
		out["data"] = None
	emit(out)
	sys.exit(0 if ok else 1)
