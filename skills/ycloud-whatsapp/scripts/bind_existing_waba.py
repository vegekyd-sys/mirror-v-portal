#!/usr/bin/env python3
"""Submit an explicit existing-WABA import **with phone numbers**.

No client authentication is required: the bridge validates the WABA against the
server-side YCloud account and enforces **phone-level ownership** — one phone
number belongs to exactly one tenant, and a WABA may be shared by several tenants.

Usage:
    printf '%s' "$WABA_ID" | python3 bind_existing_waba.py --phones +8615895553765
    printf '%s' "$WABA_ID" | python3 bind_existing_waba.py --phones +8615895553765,+8615895553766
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


def fail(code: str, status: int | None = None) -> int:
    result: dict[str, object] = {"ok": False, "code": code}
    if status is not None:
        result["httpStatus"] = status
    print(json.dumps(result, ensure_ascii=False))
    return 1


def normalize_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    return f"+{digits}" if digits else ""


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Bind an existing WABA with explicit phone numbers (phone = ownership unit)"
    )
    parser.add_argument(
        "--phones",
        required=True,
        help="comma-separated E.164 phone numbers, e.g. +8615895553765（必填）",
    )
    args = parser.parse_args()

    supplier_id = os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()
    waba_id = sys.stdin.read().strip()
    # 与桥接的租户 ID 校验保持一致（^[A-Za-z0-9][A-Za-z0-9._:-]*$，<=128）——
    # 这里收得更窄会把带 . 或 : 的合法租户在客户端就挡掉。
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", supplier_id):
        return fail("TENANT_MACHINE_SUPPLIER_MISSING")
    if not re.fullmatch(r"[1-9]\d{4,31}", waba_id):
        return fail("INVALID_WABA_ID")

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
        "wabaId": waba_id,
        "phoneNumbers": phones,
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{BRIDGE}/api/admin/whatsapp/import-existing-waba",
        data=body,
        headers={
            "Content-Type": "application/json",
        },
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

    if 200 <= status < 300 and parsed.get("ok") is True:
        safe = {
            "ok": True,
            "partnerCustomerId": parsed.get("partnerCustomerId"),
            "status": parsed.get("status"),
            "phones": parsed.get("phones") if isinstance(parsed.get("phones"), list) else [],
        }
        print(json.dumps(safe, ensure_ascii=False))
        return 0
    code = parsed.get("code") if isinstance(parsed.get("code"), str) else "WHATSAPP_SKILL_BIND_FAILED"
    return fail(code, status)


if __name__ == "__main__":
    raise SystemExit(main())
