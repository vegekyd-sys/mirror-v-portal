#!/usr/bin/env python3
"""Submit an explicit existing-WABA bind with a short-lived machine assertion."""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request

BRIDGE = "https://dealclaw.datathink.com/whatsapp"
VERSION = "v1"
ACTION = "bind-existing-waba"
AUDIENCE = "whatsapp-bridge"


def fail(code: str, status: int | None = None) -> int:
    result: dict[str, object] = {"ok": False, "code": code}
    if status is not None:
        result["httpStatus"] = status
    print(json.dumps(result, ensure_ascii=False))
    return 1


def main() -> int:
    supplier_id = os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()
    machine_token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
    waba_id = sys.stdin.read().strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", supplier_id):
        return fail("TENANT_MACHINE_SUPPLIER_MISSING")
    if len(machine_token) < 32:
        return fail("TENANT_MACHINE_SECRET_MISSING")
    if not re.fullmatch(r"[1-9]\d{4,31}", waba_id):
        return fail("INVALID_WABA_ID")

    issued_at = int(time.time())
    nonce = secrets.token_urlsafe(24)
    signing_input = "\n".join([
        "dealclaw-tenant-machine-assertion",
        VERSION,
        ACTION,
        AUDIENCE,
        supplier_id,
        waba_id,
        str(issued_at),
        nonce,
    ])
    signature = base64.urlsafe_b64encode(
        hmac.new(
            machine_token.encode("utf-8"),
            signing_input.encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode("ascii").rstrip("=")
    body = json.dumps({
        "supplierId": supplier_id,
        "wabaId": waba_id,
        "assertion": {
            "version": VERSION,
            "issuedAt": issued_at,
            "nonce": nonce,
            "signature": signature,
        },
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{BRIDGE}/api/whatsapp/bind-existing-waba",
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
