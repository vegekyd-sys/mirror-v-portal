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
    """读 tenant-env.json 优先，.env（Secret）兜底。"""
    try:
        import json as _json
        _root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "")
        if not _root:
            _root = str(Path(__file__).resolve().parents[3])
        _tf = Path(_root) / "data" / "memory" / "tenant-env.json"
        if _tf.exists():
            _data = _json.loads(_tf.read_text(encoding="utf-8"))
            if isinstance(_data, dict) and name in _data and _data[name]:
                return str(_data[name]).strip()
    except Exception:
        pass
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


def _human_size(n: object) -> str:
    try:
        n = int(n or 0)
    except (TypeError, ValueError):
        return ""
    if n <= 0:
        return ""
    for unit in ("B", "KB", "MB"):
        if n < 1024 or unit == "MB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024.0
    return ""


def _attachment_line(rows: object) -> str:
    """把附件索引行渲染成卡片里的一行清单。

    只列「有什么」，**不下发文件**（口径：提醒卡片只报有附件；要文件时由 agent 用
    `dc_resend_attachments --find` / `--pull` 取，再按需发给用户）。没落盘成功的也照列
    并标原因，「静默丢附件」正是这次要修的病。
    """
    if not isinstance(rows, list) or not rows:
        return ""
    parts = []
    for row in rows[:10]:
        if not isinstance(row, dict):
            continue
        name = str(row.get("filename") or "attachment")
        size = _human_size(row.get("size"))
        item = f"{name}（{size}）" if size else name
        if not row.get("stored"):
            reason = row.get("skipped") or row.get("error") or "未保存"
            item += f" ⚠️{str(reason)[:30]}"
        parts.append(item)
    if not parts:
        return ""
    more = f" 等 {len(rows)} 个" if len(rows) > 10 else ""
    return "📎 **附件**\n" + "、".join(parts) + more


def _build_notify_text(events: list[dict], chat_id: str = "") -> str:
    """构造应用机器人投递用的纯文本。

    与卡片等价的信息量；私聊（ou_）不 @（私聊里提及无意义），群内（oc_）保留
    「请及时跟进」的 @ 提示，避免丢掉原来群里的提醒效果。
    """
    lines = [f"[出海精灵小元] 新邮件提醒 · {len(events)} 封", ""]
    mention_ids: set[str] = set()
    for index, event in enumerate(events, start=1):
        preview = _excerpt(event.get("preview")) or "（无可显示的纯文本正文）"
        lines.append(f"{index}. 发件人：{event.get('from') or '未知'}")
        lines.append(f"   收件邮箱：{event.get('email_address') or '未知'}")
        lines.append(f"   主题：{event.get('subject') or '（无主题）'}")
        lines.append(f"   内容：{preview}")
        att_line = _attachment_line(event.get("attachments"))
        if att_line:
            lines.append(f"   {att_line}")
        mention_id = _resolve_mention(event.get("owner_open_id", ""), chat_id)
        if mention_id:
            mention_ids.add(mention_id)
        lines.append("")
    if mention_ids and str(chat_id or "").startswith("oc_"):
        at_tags = " ".join(f"<at id={mid}></at>" for mid in sorted(mention_ids))
        lines.append(f"请及时跟进：{at_tags}")
    return "\n".join(lines).strip()


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
        att_line = _attachment_line(event.get("attachments"))
        if att_line:
            elements.append({"tag": "div", "text": {"content": att_line, "tag": "lark_md"}})
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
    synced_any = False
    webhook_failed = False
    syncer = ImapSynchronizer(store)
    for account_id in account_ids:
        try:
            result = syncer.sync_account(account_id).as_dict()
            synced_any = True
        except Exception as exc:
            errors.append(f"{account_id}:{type(exc).__name__}")
            continue
        events = result.get("events", [])
        if not events:
            continue
        # 按 account 的 binding 路由：优先应用机器人（可私聊/群），失败回退到群 webhook。
        # 旧行为可用 DC_NOTIFY_DELIVERY=webhook_only 一键恢复。
        from email_gateway.notify_delivery import deliver as _deliver  # noqa: PLC0415

        bindings = [
            b for b in store.list_bindings()
            if b.get("account_id") == account_id and b.get("notify_enabled")
        ]
        chat_id = bindings[0].get("chat_id", "") if bindings else ""
        card = _build_webhook_card(events, chat_id)
        targets: list[tuple[dict, str]] = []
        if bindings:
            for b in bindings:
                url = b.get("webhook_url") or args.webhook
                if url or str(b.get("chat_id") or "").startswith(("oc_", "ou_")):
                    targets.append((b, url))
        elif args.webhook:
            targets.append(({"chat_id": "", "webhook_url": args.webhook,
                             "webhook_secret": args.webhook_secret}, args.webhook))
        for binding, url in targets:
            text = _build_notify_text(events, binding.get("chat_id", ""))
            result = _deliver(
                {**binding, "webhook_url": url or binding.get("webhook_url", "")},
                text=text,
                card=card,
                fallback_webhook=args.webhook,
                webhook_secret=args.webhook_secret,
            )
            if not result.get("ok"):
                errors.append(f"{account_id}:{'/'.join(a['channel'] for a in result.get('attempts') or []) or 'notify'}"
                              f":{result.get('error', 'delivery failed')}")
                webhook_failed = True
    if (not synced_any) or webhook_failed:
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
