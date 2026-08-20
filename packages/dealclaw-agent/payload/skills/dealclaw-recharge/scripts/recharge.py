#!/usr/bin/env python3
# -*- coding: UTF-8 -*-
"""
DealClaw 支付宝充值处理脚本：创建支付宝充值订单 + 生成支付宝二维码（二维码待支付对接）。

用法：
  python3 recharge.py --api-key <KEY> --amount-yuan 100 [--channel alipay] [--base-url http://localhost:8443]

输出 JSON（单行）：
  { "ok": true, "order_id": "...", "amount_yuan": 100, "credits_amount": 10000,
    "qr_code": null, "recharge_url": "https://.../recharge", "status": "created" }
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "http://localhost:8443"
# 固定充值档位（元），不接受任意金额
ALLOWED_AMOUNTS = {100, 500, 1000}


def create_order(base_url: str, api_key: str, amount_yuan: float, channel: str) -> dict:
    """调 sq-api /v1/recharge/order 创建充值订单（需 recharge:create scope）。"""
    url = f"{base_url.rstrip('/')}/v1/recharge/order"
    body = json.dumps({"amount_yuan": amount_yuan, "channel": channel}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"error": {"code": "HTTP_ERROR", "message": f"HTTP {e.code}"}}
    except urllib.error.URLError as e:
        return {"error": {"code": "NETWORK_ERROR", "message": str(e.reason)}}


def generate_qr(order_id: str, amount_yuan: float, recharge_url: str) -> dict:
    """生成支付宝收款二维码。

    TODO: 待支付宝支付对接（接口 A：SQ → 支付宝下单，返回 qr_code / pay_url）。
    当前回退：返回 recharge_url 链接，qr_code 置空。
    """
    return {
        "qr_code": None,
        "recharge_url": recharge_url,
        "note": "支付宝二维码生成待支付对接，当前返回支付宝链接",
    }


def main() -> None:
    p = argparse.ArgumentParser(description="DealClaw 支付宝充值：创建订单 + 支付宝二维码")
    p.add_argument("--api-key", required=True, help="客户 API Key（agent 从账户配置读取，不落日志）")
    p.add_argument("--amount-yuan", type=float, required=True, help="充值金额（仅固定档位 100/500/1000）")
    p.add_argument("--channel", default="alipay", help="支付渠道，固定 alipay（支付宝）")
    p.add_argument("--base-url", default=os.environ.get("SQ_BASE_URL", DEFAULT_BASE_URL))
    args = p.parse_args()

    # 档位校验：只接受固定档位，拒绝任意金额
    if args.amount_yuan not in ALLOWED_AMOUNTS:
        print(json.dumps(
            {"ok": False, "error": {"code": "INVALID_AMOUNT", "message": f"充值金额只支持固定档位 {sorted(ALLOWED_AMOUNTS)} 元"}},
            ensure_ascii=False,
        ))
        sys.exit(1)

    order = create_order(args.base_url, args.api_key, args.amount_yuan, args.channel)
    if "error" in order:
        print(json.dumps({"ok": False, "error": order["error"]}, ensure_ascii=False))
        sys.exit(1)

    order_id = order.get("order_id", "")
    recharge_url = (order.get("recharge") or {}).get("recharge_url", "")
    qr = generate_qr(order_id, args.amount_yuan, recharge_url)

    result = {
        "ok": True,
        "order_id": order_id,
        "amount_yuan": order.get("amount_yuan"),
        "credits_amount": order.get("credits_amount"),
        "status": order.get("status"),
        "qr_code": qr.get("qr_code"),
        "recharge_url": qr.get("recharge_url"),
        "note": qr.get("note"),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
