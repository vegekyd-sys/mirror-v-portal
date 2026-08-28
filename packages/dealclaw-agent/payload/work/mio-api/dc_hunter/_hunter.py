#!/usr/bin/env python
# -- coding: UTF-8 --
"""Hunter skill 的公共客户端层：鉴权、统一 JSON 输出。

约定与 dc_arounddeal/_ad.py 一致：emit() 打印 JSON，fail() 输出错误并退出。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hunter_client import HunterClient, HunterError  # noqa: E402


def emit(result: Dict[str, Any]) -> None:
    print(json.dumps(result, ensure_ascii=False, indent=2))


def fail(msg: str, code: int = 2, **extra: Any) -> None:
    payload = {"success": False, "msg": msg, "data": None}
    payload.update(extra)
    emit(payload)
    sys.exit(code)


def add_common_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--timeout", type=int, default=30, help="HTTP 超时秒数")
    p.add_argument("--api-key", default=None, help="覆盖 HUNTER_API_KEY（默认从 .env 自动加载）")


def client(args: argparse.Namespace) -> HunterClient:
    return HunterClient(api_key=getattr(args, "api_key", None),
                        timeout=getattr(args, "timeout", 30))


def run(tool: str, call, request: Dict[str, Any]) -> None:
    """执行调用并按统一契约输出。"""
    try:
        resp = call()
    except HunterError as e:
        fail(str(e), tool=tool, request=request, sent=False)
        return

    ok = bool(resp.get("success"))
    out: Dict[str, Any] = {"success": ok, "tool": tool, "request": request, "data": resp.get("data")}
    if not ok:
        err = resp.get("error") or {}
        out["msg"] = "%s: %s" % (err.get("code", "?"), err.get("detail") or "(无 detail)")
        out["data"] = None
    emit(out)
    sys.exit(0 if ok else 1)
