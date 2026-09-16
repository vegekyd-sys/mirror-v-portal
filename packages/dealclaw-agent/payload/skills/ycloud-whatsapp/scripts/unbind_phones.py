#!/usr/bin/env python3
"""Unbind WhatsApp phone numbers that belong to the current tenant.

语义（2026-09-15 决策）：**只停路由** —— 删掉我方归属行，不调用 YCloud/Meta 释放号码
（那是不可逆的 Meta 侧操作）。归属隔离由桥接强制执行：只能解绑自己的号，
别人的号一律被 reject 且不会产生任何改动。

Usage:
    python3 unbind_phones.py --phones +8615895553765
    python3 unbind_phones.py --phones +8615895553765,+8615895553766
"""

# PEP 604 注解（int | None）在 3.10 以下会在 def 求值时抛 TypeError，
# 让整个脚本连结构化失败都来不及输出。延迟注解求值，保持向下兼容。
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

BRIDGE = "https://dealclaw.datathink.com/whatsapp"


def fail(code: str, status: int | None = None, extra: dict | None = None) -> int:
    result: dict[str, object] = {"ok": False, "code": code}
    if status is not None:
        result["httpStatus"] = status
    if extra:
        result.update(extra)
    print(json.dumps(result, ensure_ascii=False))
    return 1


def normalize_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    return f"+{digits}" if digits else ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Unbind own WhatsApp phone numbers (routing only)")
    parser.add_argument(
        "--phones",
        required=True,
        help="comma-separated E.164 phone numbers, e.g. +8615895553765（必填）",
    )
    args = parser.parse_args()

    supplier_id = os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()
    # 与桥接的租户 ID 校验保持一致（^[A-Za-z0-9][A-Za-z0-9._:-]*$，<=128）——
    # 这里收得更窄会把带 . 或 : 的合法租户在客户端就挡掉。
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", supplier_id):
        return fail("TENANT_MACHINE_SUPPLIER_MISSING")

    phones: list[str] = []
    for raw in args.phones.split(","):
        phone = normalize_phone(raw)
        if not re.fullmatch(r"\+[1-9]\d{6,14}", phone):
            return fail("INVALID_PHONE")
        if phone not in phones:
            phones.append(phone)
    if not phones:
        return fail("PHONES_REQUIRED")

    body = json.dumps({
        "partnerCustomerId": supplier_id,
        "phoneNumbers": phones,
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{BRIDGE}/api/admin/whatsapp/unbind-phones",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status = response.status
            raw = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        raw = error.read()
    except Exception:
        return fail("WHATSAPP_BRIDGE_UNAVAILABLE")

    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        return fail("WHATSAPP_BRIDGE_INVALID_RESPONSE", status)
    if not isinstance(parsed, dict):
        return fail("WHATSAPP_BRIDGE_INVALID_RESPONSE", status)

    if 200 <= status < 300:
        unbound = parsed.get("unbound") if isinstance(parsed.get("unbound"), list) else []
        rejected = parsed.get("rejected") if isinstance(parsed.get("rejected"), list) else []
        safe = {
            "ok": parsed.get("ok") is True and not rejected,
            "partnerCustomerId": parsed.get("partnerCustomerId"),
            "unbound": unbound,
            "rejected": rejected,
            "disconnected": parsed.get("disconnected", 0),
        }
        print(json.dumps(safe, ensure_ascii=False))
        # 有被拒的号 → 非零退出（调用方必须如实报告，不得谎报成功）
        return 0 if not rejected else 1
    code = parsed.get("code") if isinstance(parsed.get("code"), str) else "WHATSAPP_SKILL_UNBIND_FAILED"
    return fail(code, status)


if __name__ == "__main__":
    raise SystemExit(main())
