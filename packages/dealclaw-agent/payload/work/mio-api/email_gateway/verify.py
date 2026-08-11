from __future__ import annotations

import imaplib
import smtplib
import ssl
from typing import Any, Callable

from .imap_compat import prepare_imap_session
from .providers import get_provider
from .secrets import resolve_secret
from .store import EmailStore


class AccountVerifier:
    def __init__(
        self,
        store: EmailStore,
        *,
        imap_factory: Callable[..., imaplib.IMAP4_SSL] | None = None,
        smtp_ssl_factory: Callable[..., smtplib.SMTP_SSL] | None = None,
        smtp_factory: Callable[..., smtplib.SMTP] | None = None,
        secret_resolver: Callable[[str], str] = resolve_secret,
    ):
        self.store = store
        self.imap_factory = imap_factory or imaplib.IMAP4_SSL
        self.smtp_ssl_factory = smtp_ssl_factory or smtplib.SMTP_SSL
        self.smtp_factory = smtp_factory or smtplib.SMTP
        self.secret_resolver = secret_resolver

    def verify(self, account_id: str) -> dict[str, Any]:
        account = self.store.get_account(account_id)
        provider = get_provider(account["provider"])
        secret = self.secret_resolver(account["secret_ref"])
        result: dict[str, Any] = {
            "ok": False,
            "account_id": account_id,
            "email_address": account["email_address"],
            "provider": account["provider"],
            "imap": {"ok": False},
            "smtp": {"ok": False},
        }

        imap = None
        try:
            imap = self.imap_factory(
                provider.imap_host,
                provider.imap_port,
                ssl_context=ssl.create_default_context(),
                timeout=30,
            )
            imap.login(account["email_address"], secret)
            prepare_imap_session(imap, provider)
            status, _ = imap.select("INBOX", readonly=True)
            if status != "OK":
                raise RuntimeError("INBOX unavailable")
            result["imap"] = {"ok": True, "host": provider.imap_host, "port": provider.imap_port}
        except Exception as exc:
            result["imap"] = {"ok": False, "error": type(exc).__name__}
        finally:
            if imap is not None:
                try:
                    imap.logout()
                except Exception:
                    pass

        smtp = None
        try:
            if provider.smtp_mode == "ssl":
                smtp = self.smtp_ssl_factory(
                    provider.smtp_host,
                    provider.smtp_port,
                    context=ssl.create_default_context(),
                    timeout=30,
                )
            else:
                smtp = self.smtp_factory(provider.smtp_host, provider.smtp_port, timeout=30)
                smtp.starttls(context=ssl.create_default_context())
            smtp.login(account["email_address"], secret)
            smtp.noop()
            result["smtp"] = {"ok": True, "host": provider.smtp_host, "port": provider.smtp_port}
        except Exception as exc:
            result["smtp"] = {"ok": False, "error": type(exc).__name__}
        finally:
            if smtp is not None:
                try:
                    smtp.quit()
                except Exception:
                    pass

        result["ok"] = bool(result["imap"]["ok"] and result["smtp"]["ok"])
        return result
