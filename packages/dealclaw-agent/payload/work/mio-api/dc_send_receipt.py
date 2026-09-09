#!/usr/bin/env python3
"""DC-SendReceipt — 发送回执统一推送。

把「发送结果」推回发起会话（群 oc_ 或用户 ou_），是所有发送动作（即时/定时）
唯一回执出口。不硬编码 webhook，复用 dc_notify 的 FeishuSender（lark-cli）。

用法：
  python3 dc_send_receipt.py --target oc_xxx --text "..."
  python3 dc_send_receipt.py --target ou_xxx --text "..."
"""
from __future__ import annotations

import argparse
import json
import sys

from _tenant_env import load_tenant_env

load_tenant_env()

from dc_notify import FeishuSender  # noqa: E402


def push_receipt(target: str, text: str) -> dict:
    """推一条回执到 target（oc_ 群 / ou_ 用户）。返回结构化结果，不抛异常。"""
    target = (target or "").strip()
    text = (text or "").strip()
    if not target:
        return {"ok": False, "error": "empty target"}
    if not text:
        return {"ok": False, "error": "empty text"}
    if not (target.startswith("oc_") or target.startswith("ou_")):
        return {"ok": False, "error": f"invalid target: {target[:16]}"}
    sender = FeishuSender()
    res = sender.send(target, text)
    return {"ok": bool(res.sent), "message_id": res.message_id or "",
            "error": res.error or "", "backend": res.backend or ""}


def _cli() -> int:
    ap = argparse.ArgumentParser(description="发送回执统一推送")
    ap.add_argument("--target", required=True, help="oc_ 群 chat_id 或 ou_ 用户 open_id")
    ap.add_argument("--text", required=True, help="回执正文")
    args = ap.parse_args()
    print(json.dumps(push_receipt(args.target, args.text), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
