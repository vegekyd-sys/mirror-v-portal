#!/usr/bin/env python
# -- coding: UTF-8 --
"""小元搜同行 Skill：调用 blade-agent-adapter /agent/colleague/* 的公共客户端。"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# ── 自动加载 .env ──────────────────────────────────────────
_ENV_DIRS = []
_d = os.path.dirname(os.path.abspath(__file__))
while _d and _d != os.path.dirname(_d):
    _ENV_DIRS.append(os.path.join(_d, "work", "mio-api"))
    _ENV_DIRS.append(_d)
    _d = os.path.dirname(_d)
_ENV_DIRS.append(os.path.join(os.environ.get("HOME", ""), ".openclaw"))
# ── 加载 tenant-env.json（租户可写，优先级高于 .env/Secret）──────
try:
    import json as _json
    _troot = os.environ.get("OPENCLAW_WORKSPACE_DIR", "")
    if not _troot:
        _tp = os.path.dirname(os.path.abspath(__file__))
        while _tp and _tp != os.path.dirname(_tp):
            if os.path.isdir(os.path.join(_tp, "work", "mio-api")):
                _troot = _tp
                break
            _tp = os.path.dirname(_tp)
    _tfile = os.path.join(_troot, "data", "memory", "tenant-env.json")
    if _troot and os.path.isfile(_tfile):
        for _tk, _tv in _json.load(open(_tfile, encoding="utf-8")).items():
            if _tv is not None:
                os.environ[_tk] = str(_tv)
except Exception:
    pass
for _d in _ENV_DIRS:
    _ENV_FILE = os.path.join(_d, ".env")
    if os.path.exists(_ENV_FILE):
        with open(_ENV_FILE) as _f:
            for _line in _f:
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _k, _v = _line.split("=", 1)
                    if _k not in os.environ:
                        os.environ[_k] = _v.strip()

DEFAULT_BASE_URL = "https://micro.tradechina.com/blade-agent-adapter"


def env(name: str, default: Optional[str] = None) -> Optional[str]:
	v = os.environ.get(name)
	if v is None or str(v).strip() == "":
		return default
	return v.strip()


def add_auth_args(p: argparse.ArgumentParser) -> None:
	p.add_argument("--open-id", default=env("MIO_V_OPEN_ID", ""), help="飞书数字人 X-Feishu-Open-Id（默认从 MIO_V_OPEN_ID 取）")
	p.add_argument("--supplier-id", default=env("MIO_CDP_SUPPLIER_ID", ""), help="供应商 X-Supplier-Id（默认从 MIO_CDP_SUPPLIER_ID 取）")
	p.add_argument(
		"--base-url",
		default=env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL),
		help="adapter Base URL，默认 https://micro.tradechina.com/blade-agent-adapter",
	)
	p.add_argument("--timeout", type=int, default=60, help="HTTP 超时秒数")


def _array_prefers_string_items(name: str) -> bool:
	n = (name or "").lower()
	return any(k in n for k in ("t4", "tag", "countries", "country", "exhibition", "counties"))


def _coerce_csv_item(token: str, *, as_string: bool) -> Any:
	t = token.strip().strip('"').strip("'")
	if not t:
		return None
	if as_string:
		return t
	if t.isdigit() or (t.startswith("-") and t[1:].isdigit()):
		return int(t)
	return t


def parse_json_array(name: str, raw: Optional[str]) -> list:
	"""解析 CLI 数组参数。

	优先 JSON；失败且不像损坏的 [/{ 时，按逗号分隔。
	Windows/PowerShell 请用 T4A,T4B 或 123,456，勿写 [\\\"T4A\\\"]。
	"""
	if raw is None or str(raw).strip() == "":
		return []
	s = str(raw).strip()
	try:
		v = json.loads(s)
	except json.JSONDecodeError as e:
		if s.startswith("[") or s.startswith("{"):
			raise ValueError(
				f"{name} 不是合法 JSON: {e}；"
				f"Windows/PowerShell 传数组请用 A,B 或 1,2，勿写 [\\\"A\\\"]"
			) from e
		as_string = _array_prefers_string_items(name)
		out: list = []
		for part in s.split(","):
			item = _coerce_csv_item(part, as_string=as_string)
			if item is not None:
				out.append(item)
		return out
	if not isinstance(v, list):
		# 单值标量（如 "123" / "RU"）→ 包成单元素数组；字符串类字段统一转字符串
		v = [str(v)] if _array_prefers_string_items(name) else [v]
	return v


def post_json(
	*,
	base_url: str,
	path: str,
	body: Any,
	open_id: str,
	supplier_id: str,
	timeout: int = 60,
) -> Dict[str, Any]:
	url = base_url.rstrip("/") + path
	payload = b"{}" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
	req = urllib.request.Request(
		url,
		method="POST",
		data=payload,
		headers={
			"Content-Type": "application/json; charset=utf-8",
			"Accept": "application/json",
			"X-Feishu-Open-Id": open_id.strip(),
			"X-Supplier-Id": supplier_id.strip(),
		},
	)
	try:
		with urllib.request.urlopen(req, timeout=timeout) as resp:
			raw = resp.read().decode("utf-8", errors="replace")
			return json.loads(raw) if raw.strip() else {}
	except urllib.error.HTTPError as e:
		err_body = e.read().decode("utf-8", errors="replace")
		try:
			parsed = json.loads(err_body) if err_body.strip() else {}
		except json.JSONDecodeError:
			parsed = {"raw": err_body}
		return {
			"success": False,
			"code": e.code,
			"msg": f"HTTP {e.code}",
			"data": None,
			"errorBody": parsed,
		}
	except urllib.error.URLError as e:
		return {
			"success": False,
			"code": -1,
			"msg": f"网络错误: {e.reason}",
			"data": None,
		}


def emit(result: Dict[str, Any]) -> None:
	print(json.dumps(result, ensure_ascii=False, indent=2))


def fail(msg: str, code: int = 2) -> None:
	emit({"success": False, "msg": msg, "data": None})
	sys.exit(code)
