#!/usr/bin/env python3
"""Agent-Friendly CLI common utilities for CRM/CDP wrappers."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterable


def emit(data: list | dict | None = None, *, error: dict | None = None, meta: dict | None = None, exit_code: int = 0) -> None:
    """Emit the unified Agent-Friendly JSON envelope.

    Contract: always prints JSON with count/data/error, never Python traceback for user-facing failures.
    """
    if data is None:
        data = []
    if isinstance(data, list):
        count = len(data)
    elif isinstance(data, dict) and isinstance(data.get('data'), list):
        count = len(data['data'])
    elif isinstance(data, dict) and 'count' in data:
        count = data.get('count') or 0
    else:
        count = 1 if data else 0
    payload = {"count": count, "data": data, "error": error}
    if meta:
        payload["meta"] = meta
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    if exit_code:
        raise SystemExit(exit_code)


def fail(code: str, message: str, *, detail: Any = None, exit_code: int = 1) -> None:
    err = {"code": code, "message": message}
    if detail is not None:
        err["detail"] = detail
    emit([], error=err, exit_code=exit_code)


def split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [x.strip() for x in value.split(',') if x.strip()]


def coql_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def like_criteria(field: str, value: str) -> str:
    return f"{field} like '%{str(value).replace(chr(39), chr(39)+chr(39))}%'"


def eq_criteria(field: str, value: str) -> str:
    return f"{field} = {coql_quote(value)}"


def ge_criteria(field: str, value: str) -> str:
    return f"{field} >= {coql_quote(value)}"


def le_criteria(field: str, value: str) -> str:
    return f"{field} <= {coql_quote(value)}"


def and_criteria(parts: Iterable[str]) -> str:
    parts = [p for p in parts if p]
    return ' and '.join(parts) if parts else 'id is not null'


def pick(obj: Any, *keys: str) -> Any:
    cur = obj
    for key in keys:
        if isinstance(cur, dict):
            cur = cur.get(key)
        else:
            return None
    return cur


def normalize_record(record: dict, mapping: dict[str, str]) -> dict:
    """Add Chinese/business aliases without dropping raw API fields."""
    out = dict(record)
    for label, api_name in mapping.items():
        if api_name in record:
            out[label] = record.get(api_name)
    return out


def ensure_env(names: list[str]) -> None:
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        fail('MISSING_ENV', '缺少必要环境变量', detail=missing)


def safe_call(fn):
    try:
        return fn()
    except SystemExit:
        raise
    except Exception as exc:
        fail(type(exc).__name__, str(exc))
