#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""查客户 Credit 余额与账户状态：POST /agent/customer-file/getCreditBalance.json

biz-id 头 = 租户ID（per-tenant pod 环境变量 DEALCLAW_TENANT_ID）。
按账户状态分类：
  no_account / abnormal / insufficient / low / active
只有「有账户且余额耗尽(insufficient)」或「余额低于阈值(low)」才给充值链接；
无账户/异常不引导充值。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://micro.tradechina.com/blade-agent-adapter"
DEFAULT_LOW_THRESHOLD = 1000  # 余额低于此值（>0 且 ≤ 阈值）提示不足、建议充值

CONSOLE_URL = "https://xyconsole.tradechina.com/"
RECHARGE_URL_TMPL = "https://xyconsole.tradechina.com/recharge?bizId={biz_id}"


def env(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    return default if v is None or str(v).strip() == "" else str(v).strip()


def classify_account(has_account: bool, status, balance: int, threshold: int) -> str:
    """账户状态分类：no_account / abnormal / insufficient / low / active"""
    if not has_account:
        return "no_account"
    # status 语义：1 = 正常（当前唯一已知正常值），其余保守视为异常，不引导充值
    if status is not None and str(status) != "1":
        return "abnormal"
    if balance <= 0:
        return "insufficient"
    if balance <= threshold:
        return "low"
    return "active"


def main() -> None:
    p = argparse.ArgumentParser(description="小元-查客户 Credit 余额与账户状态")
    p.add_argument("--biz-id", default=env("DEALCLAW_TENANT_ID"),
                   help="租户ID（缺省读环境变量 DEALCLAW_TENANT_ID）")
    p.add_argument("--threshold", type=int, default=DEFAULT_LOW_THRESHOLD,
                   help="余额预警阈值（>0 且 ≤ 阈值判为 low，默认 1000）")
    p.add_argument("--base-url", default=env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL))
    p.add_argument("--timeout", type=int, default=15)
    args = p.parse_args()

    biz_id = args.biz_id.strip()
    if not biz_id:
        print(json.dumps({"ok": False, "error": "missing biz-id (DEALCLAW_TENANT_ID)"},
                         ensure_ascii=False))
        sys.exit(2)

    url = args.base_url.rstrip("/") + "/agent/customer-file/getCreditBalance.json"
    req = urllib.request.Request(
        url, method="POST", data=b"",
        headers={
            "biz-id": biz_id,
            "Request-Origion": "SwaggerBootstrapUi",
            "accept": "*/*",
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as e:
        print(json.dumps({"ok": False, "error": f"网络错误: {e.reason}"}, ensure_ascii=False))
        sys.exit(1)

    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        data = {"raw": raw}

    if not data.get("success"):
        print(json.dumps({"ok": False, "error": data.get("msg") or "查询失败", "resp": data},
                         ensure_ascii=False))
        sys.exit(1)

    d = data.get("data") or {}
    has_account = d.get("hasAccount", False)
    balance = d.get("balance", 0)
    total_granted = d.get("totalGranted", 0)
    total_consumed = d.get("totalConsumed", 0)
    status = d.get("status")

    account_state = classify_account(has_account, status, balance, args.threshold)

    # 余额耗尽 或 低于阈值 → 给充值链接；无账户/异常/充足 → 不给
    recharge_url = (
        RECHARGE_URL_TMPL.format(biz_id=biz_id)
        if account_state in ("insufficient", "low")
        else None
    )

    result = {
        "ok": True,
        "hasAccount": has_account,
        "account_state": account_state,
        "balance": balance,
        "totalGranted": total_granted,
        "totalConsumed": total_consumed,
        "status": status,
        "low_balance_threshold": args.threshold,
        "console_url": CONSOLE_URL,
        "recharge_url": recharge_url,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
