from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import sys
import time
import urllib.request
from collections import defaultdict

from .cli import DEFAULT_DB
from .imap_sync import ImapSynchronizer
from .store import EmailStore


def _excerpt(value: object, limit: int = 200) -> str:
    import re
    text = str(value or "").strip()
    # Gmail-style reply headers begin with "On <weekday>, ... wrote:".
    # Strip everything from that point to keep only the new reply content.
    m = re.search(r"\n?On (Mon|Tue|Wed|Thu|Fri|Sat|Sun), .+ wrote:", text)
    if m:
        text = text[:m.start()].strip()
    # Also remove any remaining quoted lines.
    text = "\n".join(line for line in text.split("\n") if not line.strip().startswith(">"))
    return text.strip() if len(text) <= limit else f"{text[:limit]}…"


def _sign(secret: str, timestamp: str) -> str:
    """Feishu custom bot signing: HMAC-SHA256 over empty string, key = timestamp\nsecret."""
    key = f"{timestamp}\n{secret}".encode("utf-8")
    return base64.b64encode(hmac.new(key, b"", hashlib.sha256).digest()).decode("utf-8")


V_OPEN_ID = "ou_15273b08310b914c5f97b27af680c149"

# Map email account owner → the DealClaw agent (数字人) that should be @mentioned.
OWNER_AGENT_MAP: dict[str, str] = {
    "ou_a57ce7904df34cc0e16c770309ce9196": V_OPEN_ID,  # 王强 → V
}


def _resolve_mention(owner_open_id: str) -> str:
    return OWNER_AGENT_MAP.get(owner_open_id, "")


def _build_webhook_card(events: list[dict]) -> dict:
    elements: list[dict] = []
    mention_ids: set[str] = set()
    for index, event in enumerate(events):
        if index:
            elements.append({"tag": "hr"})
        preview = _excerpt(event.get("preview")) or "（无可显示的纯文本正文）"
        elements.append(
            {
                "tag": "div",
                "fields": [
                    {"is_short": True, "text": {"content": f"**发件人**\n{event.get('from') or '未知'}", "tag": "lark_md"}},
                    {"is_short": True, "text": {"content": f"**收件邮箱**\n{event.get('email_address') or '未知'}", "tag": "lark_md"}},
                    {"is_short": False, "text": {"content": f"**主题**\n{event.get('subject') or '（无主题）'}", "tag": "lark_md"}},
                ],
            }
        )
        elements.append(
            {"tag": "div", "text": {"content": f"邮件内容\n{preview}", "tag": "lark_md"}}
        )
        mention_id = _resolve_mention(event.get("owner_open_id", ""))
        if mention_id:
            mention_ids.add(mention_id)
    if mention_ids:
        at_tags = " ".join(f"<at id={mid}></at>" for mid in sorted(mention_ids))
        elements.append(
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": f"请及时跟进：{at_tags}",
                },
            }
        )
    return {
        "msg_type": "interactive",
        "card": {
            "header": {
                "template": "purple",
                "title": {"content": f"[DealClaw] 新邮件提醒 · {len(events)} 封", "tag": "plain_text"},
            },
            "elements": elements,
        },
    }


def _send_webhook(url: str, secret: str, payload: dict) -> None:
    if secret:
        ts = str(int(time.time()))
        payload["timestamp"] = ts
        payload["sign"] = _sign(secret, ts)
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        if result.get("code") != 0 and result.get("StatusCode") != 0:
            raise RuntimeError(f"webhook failed: {result}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync mailboxes and send Feishu webhook cards")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    account_scope = parser.add_mutually_exclusive_group(required=True)
    account_scope.add_argument("--account-id")
    account_scope.add_argument("--all", action="store_true")
    parser.add_argument("--webhook", required=True, help="Feishu bot webhook URL")
    parser.add_argument("--webhook-secret", default="", help="Feishu bot signing secret")
    args = parser.parse_args(argv)

    store = EmailStore(args.db)
    account_ids = (
        [row["account_id"] for row in store.list_accounts(enabled_only=True)]
        if args.all
        else [args.account_id]
    )
    all_events: list[dict] = []
    errors: list[str] = []
    syncer = ImapSynchronizer(store)
    for account_id in account_ids:
        try:
            result = syncer.sync_account(account_id).as_dict()
            all_events.extend(result.get("events", []))
        except Exception as exc:
            errors.append(f"{account_id}:{type(exc).__name__}")
    if all_events:
        _send_webhook(args.webhook, args.webhook_secret, _build_webhook_card(all_events))
    if errors and not all_events:
        raise RuntimeError("; ".join(errors))
    if errors:
        print(f"警告：{len(errors)} 个邮箱同步失败", file=sys.stderr)
    print("NO_REPLY")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"DealClaw 邮箱监听失败：{type(exc).__name__}")
        raise SystemExit(1)
