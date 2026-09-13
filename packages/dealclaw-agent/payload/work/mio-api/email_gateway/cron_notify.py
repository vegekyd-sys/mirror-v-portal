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


# ── A. 通知出口收敛：webhook（默认）↔ dc_notify ───────────────
#
# 默认（未配置 / webhook）= 现有行为：飞书自定义机器人 webhook 卡片。
# 配置 DC_NOTIFY_OUTBOUND=dc_notify = 入站邮件通知改走 dc_notify 统一底座
#   （NotifyEngine.publish + dispatch），出口 sender 由 DC_NOTIFY_SENDER_MODE 决定
#   （feishu / weixin），不再写死飞书 webhook。
# 切换开关：DC_NOTIFY_OUTBOUND（tenant-env.json → .env → 环境变量）。
DC_NOTIFY_OUTBOUND_ENV = "DC_NOTIFY_OUTBOUND"


def _outbound_mode() -> str:
    """通知出口模式："webhook"（默认，飞书机器人卡片）或 "dc_notify"（统一底座）。"""
    mode = _env_value(DC_NOTIFY_OUTBOUND_ENV, "webhook").strip().lower()
    return mode or "webhook"


def _dc_notify_engine():
    """dc_notify 引擎工厂（测试可替换，注入 MockSender）。"""
    from dc_notify import NotifyEngine
    return NotifyEngine()


def _dc_notify_company_id(enterprise_id: str = "") -> str:
    """通知归属 company_id：账号 enterprise → MIO_CDP_SUPPLIER_ID → default。"""
    for value in (enterprise_id, _env_value("MIO_CDP_SUPPLIER_ID", ""), "default"):
        if value and str(value).strip():
            return str(value).strip()
    return "default"


def _event_dedupe_key(account_id: str, event: dict) -> str:
    """同一封入站邮件恒相同（防重复推送）：账号 + message_id（退化到 uid）。"""
    ident = str(event.get("message_id") or "").strip() or f"uid:{event.get('uid')}"
    return f"{account_id or event.get('account_id', '')}:{ident}"


def _format_plain_event(event: dict) -> str:
    """入站邮件通知正文（纯文本，适配任意 sender：feishu / weixin）。"""
    lines = [
        "📬 DealClaw 新邮件提醒",
        f"收件邮箱：{event.get('email_address') or '未知'}",
        f"发件人：{event.get('from') or '未知'}",
        f"主题：{event.get('subject') or '（无主题）'}",
    ]
    preview = _excerpt(event.get("preview"))
    if preview:
        lines.append(f"邮件内容\n{preview}")
    return "\n".join(lines)


def notify_events_via_dc_notify(events: list[dict], *, account_id: str = "",
                                enterprise_id: str = "", engine=None) -> dict:
    """把入站邮件通知交给 dc_notify（publish → dispatch）。返回结构化结果。

    - 只有本函数 publish 出来的 notification_id 会被 dispatch（only_ids），
      不会顺手把别人 pending 的通知发出去。
    - 逐条结果在 results 里（sent / dry_run / failed），失败带底层真实 error。
    - 路由缺失（route_error）→ 消息保留 pending，由调用方报错，不静默丢。
    """
    if engine is None:
        engine = _dc_notify_engine()
    company_id = _dc_notify_company_id(enterprise_id)
    notification_ids: list[str] = []
    for event in events:
        res = engine.publish(
            company_id,
            "signal_item",
            payload={
                "message": _format_plain_event(event),
                "kind": "inbound_email",
                "account_id": account_id or event.get("account_id", ""),
                "email_address": event.get("email_address", ""),
                "from": event.get("from", ""),
                "subject": event.get("subject", ""),
            },
            dedupe_key=f"inbound-mail:{_event_dedupe_key(account_id, event)}",
            slot="realtime",
        )
        nid = res.get("notification_id")
        if nid:
            notification_ids.append(nid)
    if not notification_ids:
        return {"status": "quiet", "company_id": company_id, "published": 0, "results": []}
    dr = engine.dispatch(company_id, slot="realtime", only_ids=notification_ids)
    return {
        "status": dr.get("status"),
        "company_id": company_id,
        "published": len(notification_ids),
        "results": dr.get("results", []),
        "error": dr.get("error", ""),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync mailboxes and send Feishu webhook cards")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    account_scope = parser.add_mutually_exclusive_group(required=True)
    account_scope.add_argument("--account-id")
    account_scope.add_argument("--all", action="store_true")
    parser.add_argument("--webhook", default="", help="Feishu bot webhook URL（fallback，未绑定群时用）")
    parser.add_argument("--webhook-secret", default="", help="Feishu bot signing secret（fallback）")
    parser.add_argument("--outbound", default="", choices=["", "webhook", "dc_notify"],
                        help="通知出口（默认取 DC_NOTIFY_OUTBOUND）：webhook=飞书机器人卡片；dc_notify=统一底座")
    args = parser.parse_args(argv)

    # 通知出口：CLI 覆盖 DC_NOTIFY_OUTBOUND；默认 webhook = 现有行为不变
    outbound_mode = args.outbound or _outbound_mode()

    store = EmailStore(args.data_dir)
    account_ids = (
        [row["account_id"] for row in store.list_accounts(enabled_only=True)]
        if args.all
        else [args.account_id]
    )
    errors: list[str] = []
    synced_any = False
    outbound_failed = False
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
        if outbound_mode == "dc_notify":
            # 通知出口收敛：走 dc_notify 统一底座（sender 由 DC_NOTIFY_SENDER_MODE 决定）
            try:
                account = store.get_account(account_id)
            except Exception:  # noqa: BLE001
                account = {}
            try:
                nr = notify_events_via_dc_notify(
                    events,
                    account_id=account_id,
                    enterprise_id=str(account.get("enterprise_id", "")),
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{account_id}:notify:{type(exc).__name__}")
                outbound_failed = True
                continue
            if nr.get("status") == "route_error":
                errors.append(f"{account_id}:notify:route_error:{str(nr.get('error') or '')[:120]}")
                outbound_failed = True
            for rr in nr.get("results", []):
                if rr.get("status") == "failed":
                    reason = str(rr.get("error") or "").strip()[:120] or "failed"
                    errors.append(f"{account_id}:notify:{reason}")
                    outbound_failed = True
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
            except Exception as exc:
                errors.append(f"{account_id}:webhook:{type(exc).__name__}")
                outbound_failed = True
    if (not synced_any) or outbound_failed:
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
