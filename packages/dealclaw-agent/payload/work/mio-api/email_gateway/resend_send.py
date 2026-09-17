from __future__ import annotations

import json
from typing import Callable

import urllib3
# Use urllib3 (bundled with requests) to avoid urllib's default headers that
# trigger a 403 from the Resend API.
from .secrets import resolve_secret


_API_URL = "https://api.resend.com/emails"


def _resolve_api_key(resolver: Callable[[str], str]) -> str:
    key = resolver("env:RESEND_API_KEY")
    return key.strip()


def send(
    *,
    from_address: str,
    to: list[str],
    subject: str,
    text: str,
    cc: list[str] | None = None,
    reply_to: str | None = None,
    html: str | None = None,
    attachments: list[dict] | None = None,
    secret_resolver: Callable[[str], str] = resolve_secret,
) -> str:
    """Send via Resend API. Returns the Resend message ID.

    ``attachments`` 是 ``email_gateway.attachments.load_attachments`` 的返回值
    （带原始 ``data`` bytes），本函数负责转成 Resend 要的 base64 形态。
    """
    payload: dict = {
        "from": from_address,
        "to": to,
        "subject": subject,
        "text": text,
    }
    if html:
        payload["html"] = html
    if cc:
        payload["cc"] = cc
    if reply_to:
        payload["reply_to"] = reply_to
    if attachments:
        from .attachments import to_resend_payload

        payload["attachments"] = to_resend_payload(attachments)
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    api_key = _resolve_api_key(secret_resolver)
    http = urllib3.PoolManager(timeout=urllib3.Timeout(connect=10, read=20))
    resp = http.request(
        "POST",
        _API_URL,
        body=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "DealClaw/1.0",
        },
    )
    if resp.status != 200:
        raise RuntimeError(f"Resend API error {resp.status}: {resp.data.decode()[:500]}")
    result = json.loads(resp.data.decode("utf-8"))
    resend_id = result.get("id", "")
    if not resend_id:
        raise RuntimeError(f"Resend API error: {result}")
    return resend_id
