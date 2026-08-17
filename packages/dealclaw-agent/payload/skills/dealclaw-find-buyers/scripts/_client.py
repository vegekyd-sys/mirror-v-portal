#!/usr/bin/env python
# -- coding: UTF-8 --
"""小元买家 Skill：调用 blade-agent-adapter /agent/buyer/* 的公共客户端。"""

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
	"""countries / cdpIds / keywords / companyAttributes 等应为字符串元素。"""
	n = (name or "").lower()
	return any(k in n for k in ("countries", "cdp", "keyword", "attribute", "exhibition"))


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

	优先按 JSON 数组解析；失败且不像损坏的 JSON 时，回退为逗号分隔：
	- 字符串场景：`--countries-json RU` / `RU,US`（避免 PowerShell 吃掉 [\\"RU\\"] 引号）
	- 数字场景：`--features-json 5,7` 或 shell 友好的 `[5,7]`
	"""
	if raw is None or str(raw).strip() == "":
		return []
	s = str(raw).strip()
	try:
		v = json.loads(s)
	except json.JSONDecodeError as e:
		# 以 [/{ 开头说明本意是 JSON，但被 shell 弄坏了——直接报错便于排查
		if s.startswith("[") or s.startswith("{"):
			raise ValueError(
				f"{name} 不是合法 JSON: {e}；"
				f"Windows/PowerShell 传字符串数组请用 RU 或 RU,US，勿写 [\\\"RU\\\"]"
			) from e
		as_string = _array_prefers_string_items(name)
		out: list = []
		for part in s.split(","):
			item = _coerce_csv_item(part, as_string=as_string)
			if item is not None:
				out.append(item)
		return out
	if not isinstance(v, list):
		raise ValueError(f"{name} 必须是 JSON 数组")
	return v


def parse_json_object(name: str, raw: Optional[str]) -> Dict[str, Any]:
	if raw is None or str(raw).strip() == "":
		return {}
	try:
		v = json.loads(raw)
	except json.JSONDecodeError as e:
		raise ValueError(f"{name} 不是合法 JSON: {e}") from e
	if not isinstance(v, dict):
		raise ValueError(f"{name} 必须是 JSON 对象")
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
	payload = b"null" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
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
