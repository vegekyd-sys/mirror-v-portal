from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .imap_sync import ImapSynchronizer
from .providers import PROVIDERS, get_provider
from .smtp_send import SmtpSender
from .store import EmailStore
from .verify import AccountVerifier

from _tenant_env import load_tenant_env

load_tenant_env()


DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def emit(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def public_accounts(value):
    if isinstance(value, list):
        return [public_accounts(item) for item in value]
    if isinstance(value, dict):
        clean = dict(value)
        if "secret_ref" in clean:
            clean["secret_ref"] = "<configured>"
        return clean
    return value


def format_notifications(results: list[dict]) -> str:
    events = [event for result in results for event in result.get("events", [])]
    lines = [f"📬 DealClaw 邮件提醒（{len(events)} 封）"]
    for event in events:
        lines.extend(
            [
                "",
                f"收件邮箱：{event.get('email_address', '')}",
                f"发件人：{event.get('from', '')}",
                f"主题：{event.get('subject') or '（无主题）'}",
            ]
        )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DealClaw multi-account email gateway")
    parser.add_argument("--data-dir", default=os.getenv("DC_DATA_DIR", str(DEFAULT_DATA_DIR)))
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("providers")
    sub.add_parser("init")

    add = sub.add_parser("account-add")
    add.add_argument("--enterprise", default=None)
    add.add_argument("--owner-open-id", required=True)
    add.add_argument("--email", required=True)
    add.add_argument("--provider", choices=sorted(PROVIDERS), required=True)
    add.add_argument(
        "--mailbox-kind",
        choices=["personal", "enterprise_user", "enterprise_shared", "dealclaw_proxy"],
        default="personal",
    )
    add.add_argument("--secret-ref", required=True, help="env:NAME or file:/absolute/path")
    add.add_argument("--auth-type", default="app_password")
    add.add_argument("--display-name", default="")
    add.add_argument("--default", action="store_true")
    add.add_argument("--daily-send-limit", type=int, default=30)

    listing = sub.add_parser("account-list")
    listing.add_argument("--enterprise")
    listing.add_argument("--owner-open-id")
    listing.add_argument("--enabled-only", action="store_true")

    disable = sub.add_parser("account-disable")
    disable.add_argument("--account-id", required=True)

    grant = sub.add_parser("grant-member")
    grant.add_argument("--account-id", required=True)
    grant.add_argument("--user-open-id", required=True)
    grant.add_argument("--role", choices=["owner", "sender", "viewer"], required=True)

    members = sub.add_parser("member-list")
    members.add_argument("--account-id", required=True)

    check = sub.add_parser("account-check")
    check.add_argument("--account-id", required=True)

    bind = sub.add_parser("bind-group")
    bind.add_argument("--account-id", required=True)
    bind.add_argument("--chat-id", required=True)
    bind.add_argument("--filter", choices=["dealclaw_replies", "all"], default="dealclaw_replies")
    bind.add_argument("--webhook", default="", help="飞书自定义机器人 webhook URL")
    bind.add_argument("--webhook-secret", default="", help="飞书自定义机器人签名密钥（secret）")

    bindings = sub.add_parser("binding-list")
    bindings.add_argument("--chat-id")

    sync = sub.add_parser("sync")
    group = sync.add_mutually_exclusive_group(required=True)
    group.add_argument("--all", action="store_true")
    group.add_argument("--account-id")
    sync.add_argument("--bootstrap-days", type=int, default=0)
    sync.add_argument("--notify-text", action="store_true")

    send = sub.add_parser("send")
    send.add_argument("--account-id", required=True)
    send.add_argument("--confirmed-by", required=True)
    send.add_argument("--to", required=True, help="comma-separated recipients")
    send.add_argument("--cc", default="")
    send.add_argument("--bcc", default="")
    send.add_argument("--subject", required=True)
    content = send.add_mutually_exclusive_group()
    content.add_argument("--text")
    content.add_argument("--text-file")
    html_group = send.add_mutually_exclusive_group()
    html_group.add_argument("--html")
    html_group.add_argument("--html-file")
    send.add_argument("--reply-to")
    send.add_argument("--dry-run", action="store_true")
    return parser


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    store = EmailStore(args.data_dir)

    if args.command == "providers":
        emit({key: get_provider(key).__dict__ for key in sorted(PROVIDERS)})
    elif args.command == "init":
        emit({"ok": True, "data_dir": str(Path(args.data_dir).resolve())})
    elif args.command == "account-add":
        get_provider(args.provider)
        if not args.secret_ref.strip():
            raise ValueError("--secret-ref must not be empty")
        enterprise_id = args.enterprise or os.environ.get("MIO_CDP_SUPPLIER_ID", "")
        if not enterprise_id:
            raise ValueError("--enterprise 未提供且 MIO_CDP_SUPPLIER_ID 未配置")
        result = store.add_account(
            enterprise_id=enterprise_id,
            owner_open_id=args.owner_open_id,
            email_address=args.email,
            provider=args.provider,
            mailbox_kind=args.mailbox_kind,
            secret_ref=args.secret_ref,
            auth_type=args.auth_type,
            display_name=args.display_name,
            is_default=args.default,
            daily_send_limit=args.daily_send_limit,
        )
        emit(public_accounts(result))
    elif args.command == "account-list":
        emit(public_accounts(
            store.list_accounts(
                enterprise_id=args.enterprise,
                owner_open_id=args.owner_open_id,
                enabled_only=args.enabled_only,
            )
        ))
    elif args.command == "account-disable":
        store.disable_account(args.account_id)
        emit({"ok": True, "account_id": args.account_id, "enabled": False})
    elif args.command == "grant-member":
        emit(
            store.grant_member(
                account_id=args.account_id,
                user_open_id=args.user_open_id,
                role=args.role,
            )
        )
    elif args.command == "member-list":
        emit(store.list_members(account_id=args.account_id))
    elif args.command == "account-check":
        result = AccountVerifier(store).verify(args.account_id)
        emit(result)
        if not result["ok"]:
            return 1
    elif args.command == "bind-group":
        emit(
            store.bind_group(
                account_id=args.account_id,
                chat_id=args.chat_id,
                inbound_filter=args.filter,
                webhook_url=args.webhook,
                webhook_secret=args.webhook_secret,
            )
        )
    elif args.command == "binding-list":
        emit(store.list_bindings(chat_id=args.chat_id))
    elif args.command == "sync":
        syncer = ImapSynchronizer(store)
        if args.all:
            results = syncer.sync_all(bootstrap_days=args.bootstrap_days)
        else:
            results = [syncer.sync_account(args.account_id, bootstrap_days=args.bootstrap_days).as_dict()]
        has_events = any(result.get("events") for result in results)
        has_errors = any(result.get("ok") is False for result in results)
        if not has_events and not has_errors:
            print("NO_REPLY")
        elif has_events and not has_errors and args.notify_text:
            print(format_notifications(results))
        else:
            emit(results)
    elif args.command == "send":
        text = ""
        if args.text_file:
            text = Path(args.text_file).read_text(encoding="utf-8")
        elif args.text:
            text = args.text
        html = ""
        if args.html_file:
            html = Path(args.html_file).read_text(encoding="utf-8")
        elif args.html:
            html = args.html
        if not text and not html:
            raise ValueError("provide at least one of --text/--text-file or --html/--html-file")
        emit(
            SmtpSender(store).send(
                account_id=args.account_id,
                confirmed_by=args.confirmed_by,
                to=_csv(args.to),
                cc=_csv(args.cc),
                bcc=_csv(args.bcc),
                subject=args.subject,
                text=text,
                html=html or None,
                reply_to=args.reply_to,
                dry_run=args.dry_run,
            )
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
