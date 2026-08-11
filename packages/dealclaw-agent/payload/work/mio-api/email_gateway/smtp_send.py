from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any, Callable

from .providers import get_provider
from .resend_send import send as resend_send
from .secrets import resolve_secret
from .store import EmailStore, utc_now


class ConfirmationRequired(PermissionError):
    pass


class SmtpSender:
    def __init__(
        self,
        store: EmailStore,
        *,
        smtp_ssl_factory: Callable[..., smtplib.SMTP_SSL] | None = None,
        smtp_factory: Callable[..., smtplib.SMTP] | None = None,
        secret_resolver: Callable[[str], str] = resolve_secret,
    ):
        self.store = store
        self.smtp_ssl_factory = smtp_ssl_factory or smtplib.SMTP_SSL
        self.smtp_factory = smtp_factory or smtplib.SMTP
        self.secret_resolver = secret_resolver

    def _send_via_resend(
        self,
        *,
        from_address: str,
        to: list[str],
        subject: str,
        text: str,
        cc: list[str] | None,
        reply_to: str | None,
    ) -> None:
        resend_send(
            from_address=from_address,
            to=to,
            subject=subject,
            text=text,
            cc=cc,
            reply_to=reply_to,
            secret_resolver=self.secret_resolver,
        )

    def send(
        self,
        *,
        account_id: str,
        confirmed_by: str,
        to: list[str],
        subject: str,
        text: str,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        reply_to: str | None = None,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        if not to or any("@" not in address for address in [*to, *(cc or []), *(bcc or [])]):
            raise ValueError("valid recipients are required")

        # Try registered account first; fall back to Resend for backward compat.
        from_addr: str
        try:
            account = self.store.get_account(account_id)
        except KeyError:
            if "@" in account_id:
                from_addr = account_id
                if not dry_run:
                    self._send_via_resend(
                        from_address=from_addr, to=to, subject=subject,
                        text=text, cc=cc, reply_to=reply_to,
                    )
                return self._build_send_result(
                    from_addr=from_addr, to=to, cc=cc, bcc=bcc,
                    subject=subject, message_id=make_msgid(domain=account_id.split("@", 1)[1]),
                    dry_run=dry_run, account_id=account_id,
                )
            raise ValueError(f"email account not found: {account_id}")

        from_addr = account["email_address"]
        if not account["enabled"]:
            raise ValueError("email account is disabled")
        if not self.store.can_send(account_id=account_id, user_open_id=confirmed_by):
            raise ConfirmationRequired("external email requires confirmation from an authorized sender")
        sent_today = self.store.count_sent_today(account_id)
        if sent_today >= int(account["daily_send_limit"]):
            raise RuntimeError("daily send limit reached for this email account")

        message_id = make_msgid(domain=account["email_address"].split("@", 1)[1])
        msg = EmailMessage()
        msg["From"] = formataddr((account["display_name"], account["email_address"]))
        msg["To"] = ", ".join(to)
        if cc:
            msg["Cc"] = ", ".join(cc)
        if reply_to:
            msg["Reply-To"] = reply_to
        msg["Subject"] = subject
        msg["Message-ID"] = message_id
        msg.set_content(text)

        envelope = [*to, *(cc or []), *(bcc or [])]
        if not dry_run:
            if account["provider"] == "resend":
                self._send_via_resend(
                    from_address=formataddr((account["display_name"], account["email_address"])),
                    to=to, subject=subject, text=text, cc=cc, reply_to=reply_to,
                )
            else:
                provider = get_provider(account["provider"])
                secret = self.secret_resolver(account["secret_ref"])
                if provider.smtp_mode == "ssl":
                    client = self.smtp_ssl_factory(
                        provider.smtp_host, provider.smtp_port,
                        context=ssl.create_default_context(), timeout=30,
                    )
                else:
                    client = self.smtp_factory(provider.smtp_host, provider.smtp_port, timeout=30)
                    client.starttls(context=ssl.create_default_context())
                try:
                    client.login(account["email_address"], secret)
                    refused = client.send_message(msg, to_addrs=envelope)
                finally:
                    try:
                        client.quit()
                    except Exception:
                        pass
                if refused:
                    raise RuntimeError("SMTP server refused one or more recipients")

            self.store.insert_message(
                {
                    "account_id": account_id,
                    "direction": "outbound",
                    "message_id": message_id,
                    "sender": account["email_address"],
                    "recipients": envelope,
                    "subject": subject,
                    "text_preview": text,
                    "related": True,
                    "status": "sent",
                    "created_at": utc_now(),
                }
            )

        return self._build_send_result(
            from_addr=from_addr, to=to, cc=cc, bcc=bcc,
            subject=subject, message_id=message_id,
            dry_run=dry_run, account_id=account_id,
        )

    @staticmethod
    def _build_send_result(
        *,
        from_addr: str,
        to: list[str],
        cc: list[str] | None,
        bcc: list[str] | None,
        subject: str,
        message_id: str,
        dry_run: bool,
        account_id: str = "",
    ) -> dict[str, Any]:
        return {
            "ok": True,
            "dry_run": dry_run,
            "account_id": account_id,
            "from": from_addr,
            "to": to,
            "cc": cc or [],
            "bcc_count": len(bcc or []),
            "subject": subject,
            "message_id": message_id,
        }
