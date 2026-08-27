from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

from .cli import DEFAULT_DATA_DIR
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


def _env_value(name: str, default: str = "") -> str:
    """读 .env 文件（cron 环境 .env 不自动加载，与 dc_resend_source 一致）。"""
    for f in [Path(__file__).resolve().parent / ".env",
              Path(__file__).resolve().parent.parent / ".env"]:
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.getenv(name, default)


V_OPEN_ID = _env_value("MIO_V_OPEN_ID", "")

# 特定 owner 可覆盖默认 @ 目标（数字人 open_id）；空则走默认 V_OPEN_ID / 群内数字人。
OWNER_AGENT_MAP: dict[str, str] = {}


def _fetch_group_digital_agent(chat_id: str) -> str:
    """从群里获取应用数字人 bot 的 open_id（member_id）。

    用 lark-cli 查群成员，优先返回带 app_id 的 bot（应用机器人 = 数字人），
    纯 webhook 通知机器人没有 app_id，会被跳过。
    """
    if not chat_id:
        return ""
    try:
        proc = subprocess.run(
            ["lark-cli", "im", "+chat-members-list", "--chat-id", chat_id, "--as", "bot"],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return ""
    if proc.returncode != 0:
        return ""
    stdout = proc.stdout or ""
    try:
        idx = stdout.find("{")
        data = json.loads(stdout[idx:] if idx >= 0 else stdout)
    except Exception:
        return ""
    bots = data.get("data", {}).get("bots", [])
    for b in bots:
        if b.get("app_id") and b.get("member_id"):
            return b["member_id"]
    for b in bots:
        if b.get("member_id"):
            return b["member_id"]
    return ""


def _resolve_mention(owner_open_id: str, chat_id: str = "") -> str:
    """回复卡片的 @ 目标：owner 映射 → 默认 MIO_V_OPEN_ID → 群内应用数字人。"""
    mapped = OWNER_AGENT_MAP.get(owner_open_id)
    if mapped:
        return mapped
    if V_OPEN_ID:
        return V_OPEN_ID
    return _fetch_group_digital_agent(chat_id)


def _build_webhook_card(events: list[dict], chat_id: str = "") -> dict:
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
        mention_id = _resolve_mention(event.get("owner_open_id", ""), chat_id)
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
                "title": {"content": f"[出海精灵小元] 新邮件提醒 · {len(events)} 封", "tag": "plain_text"},
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
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    account_scope = parser.add_mutually_exclusive_group(required=True)
    account_scope.add_argument("--account-id")
    account_scope.add_argument("--all", action="store_true")
    parser.add_argument("--webhook", default="", help="Feishu bot webhook URL（fallback，未绑定群时用）")
    parser.add_argument("--webhook-secret", default="", help="Feishu bot signing secret（fallback）")
    args = parser.parse_args(argv)

    store = EmailStore(args.data_dir)
    account_ids = (
        [row["account_id"] for row in store.list_accounts(enabled_only=True)]
        if args.all
        else [args.account_id]
    )
    errors: list[str] = []
    sent_any = False
    syncer = ImapSynchronizer(store)
    for account_id in account_ids:
        try:
            result = syncer.sync_account(account_id).as_dict()
        except Exception as exc:
            errors.append(f"{account_id}:{type(exc).__name__}")
            continue
        events = result.get("events", [])
        if not events:
            continue
        # 按 account 的 binding 路由：有启用绑定则发到各绑定的 webhook，否则 fallback 全局 --webhook
        bindings = [
            b for b in store.list_bindings()
            if b.get("account_id") == account_id and b.get("notify_enabled")
        ]
        chat_id = bindings[0].get("chat_id", "") if bindings else ""
        card = _build_webhook_card(events, chat_id)
        targets: list[tuple[str, str]] = []
        if bindings:
            for b in bindings:
                url = b.get("webhook_url") or args.webhook
                if url:
                    targets.append((url, b.get("webhook_secret") or args.webhook_secret))
        elif args.webhook:
            targets.append((args.webhook, args.webhook_secret))
        for url, secret in targets:
            try:
                _send_webhook(url, secret, card)
                sent_any = True
            except Exception as exc:
                errors.append(f"{account_id}:webhook:{type(exc).__name__}")
    if errors and not sent_any:
        raise RuntimeError("; ".join(errors))
    if errors:
        print(f"警告：{len(errors)} 个邮箱同步/发送失败", file=sys.stderr)
    print("NO_REPLY")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"DealClaw 邮箱监听失败：{type(exc).__name__}")
        raise SystemExit(1)
