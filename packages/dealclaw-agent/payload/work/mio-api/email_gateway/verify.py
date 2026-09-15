from __future__ import annotations

import imaplib
import smtplib
import ssl
from typing import Any, Callable

from .imap_compat import prepare_imap_session
from .providers import get_provider
from .secrets import resolve_secret
from .store import EmailStore

# API 类 provider（如 Resend 代理邮箱）没有 IMAP/SMTP，收发都走 HTTP API。
# 探活用只读的 GET /domains：200 = 正常；403 = key 有效但权限受限（仍是有效凭证）；
# 401 = 凭证无效。任何网络异常都归为 status=0，不抛异常。
API_PROBE_URL = "https://api.resend.com/domains"
API_USER_AGENT = "DealClaw/1.0"
API_OK_STATUSES = (200, 403)


def _default_api_probe(secret: str) -> tuple[int, str]:
    """HTTP API key 探活。返回 ``(status, detail)``；异常返回 ``(0, 异常类名)``。"""
    try:
        import urllib3  # 与 resend_send 一致：urllib 默认头会被 Resend 判 403

        http = urllib3.PoolManager(timeout=urllib3.Timeout(connect=10, read=20))
        resp = http.request(
            "GET",
            API_PROBE_URL,
            headers={"Authorization": f"Bearer {secret}", "User-Agent": API_USER_AGENT},
        )
        detail = ""
        if int(resp.status) >= 400:
            try:
                detail = resp.data.decode("utf-8")[:200]
            except Exception:  # noqa: BLE001
                detail = ""
        return int(resp.status), detail
    except Exception as exc:  # noqa: BLE001
        return 0, type(exc).__name__


class AccountVerifier:
    def __init__(
        self,
        store: EmailStore,
        *,
        imap_factory: Callable[..., imaplib.IMAP4_SSL] | None = None,
        smtp_ssl_factory: Callable[..., smtplib.SMTP_SSL] | None = None,
        smtp_factory: Callable[..., smtplib.SMTP] | None = None,
        secret_resolver: Callable[[str], str] = resolve_secret,
        api_prober: Callable[[str], tuple[int, str]] | None = None,
    ):
        self.store = store
        self.imap_factory = imap_factory or imaplib.IMAP4_SSL
        self.smtp_ssl_factory = smtp_ssl_factory or smtplib.SMTP_SSL
        self.smtp_factory = smtp_factory or smtplib.SMTP
        self.secret_resolver = secret_resolver
        self.api_prober = api_prober or _default_api_probe

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

        # API 类 provider：没有 IMAP/SMTP，用 API key 探活，避免“按 IMAP/SMTP 验”的假红。
        if not provider.imap_host or provider.recommended_auth == "api_key":
            status, detail = self.api_prober(secret)
            ok = status in API_OK_STATUSES
            result["mode"] = "api"
            result["api"] = {"ok": ok, "host": provider.smtp_host, "status": status, "detail": detail}
            result["imap"] = {"ok": False, "skipped": True, "reason": "provider has no IMAP"}
            result["smtp"] = {
                "ok": False,
                "skipped": True,
                "reason": "provider sends through the HTTP API, not SMTP",
            }
            if not ok:
                result["error"] = (
                    "invalid API key" if status == 401 else f"api probe failed (status={status})"
                )
            result["ok"] = ok
            return result

        result["mode"] = "imap_smtp"
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
