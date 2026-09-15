from __future__ import annotations

import hashlib
import json
import os
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path
from typing import Any, Callable

from .providers import get_provider
from .resend_send import send as resend_send
from .secrets import resolve_secret
from .store import EmailStore, utc_now


def _parse_sleep_seconds() -> int:
    try:
        v = int(os.environ.get("DC_SMTP_MSGID_SLEEP_SECONDS", "5"))
    except (TypeError, ValueError):
        v = 5
    return max(0, min(v, 30))  # 下限 0，上限 30s

# 发件后回查真实 Message-ID 前的等待秒数（可 env 覆盖，上限 30s）
SMTP_MSGID_SLEEP_SECONDS = _parse_sleep_seconds()


class ConfirmationRequired(PermissionError):
    pass


# ── 稳定发送幂等键 ─────────────────────────────────────────
# company_id + campaign_id + lead_id + recipient + touch_number + content_version
def build_idempotency_key(
    *,
    company_id: str = "",
    campaign_id: str = "",
    lead_id: str = "",
    recipient: str = "",
    touch_number: int = 0,
    content_version: str = "",
    subject: str = "",
    text: str = "",
) -> str:
    raw = f"{company_id}|{campaign_id}|{lead_id}|{recipient}|{touch_number}|{content_version}|{subject}|{text}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


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
        html: str | None = None,
    ) -> str:
        """Send via Resend API. Returns the real Resend email id (provider id)."""
        return resend_send(
            from_address=from_address,
            to=to,
            subject=subject,
            text=text,
            cc=cc,
            reply_to=reply_to,
            html=html,
            secret_resolver=self.secret_resolver,
        )

    def _query_smtp_message_id(self, account: dict, resend_id: str, local_message_id: str) -> str:
        """回查真实 Message-ID（发送服务/SMTP 上游分配的 RFC Message-ID，用于匹配 In-Reply-To/References）。

        - Resend：message_id 由 delivered webhook / poller 异步回填，发送路径不阻塞。
        - SMTP：sleep 后走 IMAP Sent 文件夹回查；回查失败返回空（不冒充本地 make_msgid）。
        """
        if account.get("provider") == "resend":
            return ""
        time.sleep(SMTP_MSGID_SLEEP_SECONDS)
        return self._query_smtp_message_id_via_imap(account, local_message_id)

    def _query_smtp_message_id_via_imap(self, account: dict, local_message_id: str) -> str:
        """IMAP Sent 文件夹回查真实 Message-ID（best-effort）。失败/无 imap_host 返回空。"""
        try:
            provider = get_provider(account.get("provider", ""))
            if not getattr(provider, "imap_host", None):
                return ""
            import imaplib as _imaplib
            import ssl as _ssl
            import email as _email
            secret = self.secret_resolver(account.get("secret_ref", ""))
            client = _imaplib.IMAP4_SSL(
                provider.imap_host, provider.imap_port,
                ssl_context=_ssl.create_default_context(), timeout=30,
            )
            try:
                client.login(account["email_address"], secret)
                for folder in ("Sent", "Sent Items", "已发送", "INBOX.Sent"):
                    status, _ = client.select(folder, readonly=True)
                    if status == "OK":
                        break
                else:
                    return ""
                status, data = client.search(None, "HEADER", "Message-ID", local_message_id)
                if status != "OK" or not data or not data[0]:
                    return ""
                uids = data[0].split()
                if not uids:
                    return ""
                status, parts = client.fetch(uids[-1], "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
                if status != "OK":
                    return ""
                raw = b"".join(p[1] for p in parts if isinstance(p, tuple) and isinstance(p[1], bytes))
                if not raw:
                    return ""
                return (_email.message_from_bytes(raw).get("Message-ID") or "").strip()
            finally:
                try:
                    client.logout()
                except Exception:
                    pass
        except Exception:
            return ""

    def _write_recovery_evidence(self, record: dict[str, Any]) -> None:
        """Resend accepted but local persistence failed → 由 store 落恢复证据，不重发。"""
        try:
            self.store.write_recovery_evidence(record)
        except Exception:
            # 恢复证据写失败不掩盖原始持久化错误
            pass

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
        html: str | None = None,
        dry_run: bool = False,
        company_id: str = "",
        campaign_id: str = "",
        lead_id: str = "",
        contact_id: str = "",
        touch_number: int = 0,
        content_version: str = "",
        thread_id: str = "",
    ) -> dict[str, Any]:
        if not to or any("@" not in address for address in [*to, *(cc or []), *(bcc or [])]):
            raise ValueError("valid recipients are required")

        recipient_key = ",".join(sorted(to))
        try:
            from enterprise_ids import canonical_company_id
            company_id = canonical_company_id(company_id)
        except Exception:
            pass
        idempotency_key = build_idempotency_key(
            company_id=company_id, campaign_id=campaign_id, lead_id=lead_id,
            recipient=recipient_key, touch_number=touch_number, content_version=content_version,
            subject=subject, text=(text or "") + (html or ""),
        )

        # Try registered account first; fall back to Resend for backward compat.
        from_addr: str
        try:
            account = self.store.get_account(account_id)
        except KeyError:
            if "@" in account_id:
                from_addr = account_id
                resend_id = ""
                if not dry_run:
                    resend_id = self._send_via_resend(
                        from_address=from_addr, to=to, subject=subject,
                        text=text, cc=cc, reply_to=reply_to, html=html,
                    )
                return self._build_send_result(
                    from_addr=from_addr, to=to, cc=cc, bcc=bcc,
                    subject=subject, message_id=make_msgid(domain=account_id.split("@", 1)[1]),
                    dry_run=dry_run, account_id=account_id,
                    resend_id=resend_id, idempotency_key=idempotency_key,
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

        # Idempotency: same key must not send twice.
        if idempotency_key and not dry_run and self.store.has_idempotency_key(idempotency_key):
            return {
                **self._build_send_result(
                    from_addr=from_addr, to=to, cc=cc, bcc=bcc,
                    subject=subject, message_id=make_msgid(domain=account["email_address"].split("@", 1)[1]),
                    dry_run=dry_run, account_id=account_id,
                    resend_id="", idempotency_key=idempotency_key,
                ),
                "ok": False,
                "duplicate": True,
                "error": "duplicate idempotency key — already sent",
            }

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
        if html:
            msg.add_alternative(html, subtype="html")

        envelope = [*to, *(cc or []), *(bcc or [])]
        resend_id = ""
        smtp_message_id = ""
        provider_accepted = False
        if not dry_run:
            if account["provider"] == "resend":
                resend_id = self._send_via_resend(
                    from_address=formataddr((account["display_name"], account["email_address"])),
                    to=to, subject=subject, text=text, cc=cc, reply_to=reply_to, html=html,
                ) or ""
                # Only mark provider-accepted when a real Resend id was returned.
                provider_accepted = bool(resend_id)
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
                # SMTP 没有投递回执：走到这里（含 refused 检查）就是服务器已接收。
                # 2026-09-15 修复：此前只有 resend 分支置位，SMTP 恒 False → provider_status 恒 ''，
                # 下游 dc_followup / dc_email_signals / growth_dashboard / email_provider 全部跳过。
                provider_accepted = True

            # 回查真实 Message-ID（Resend 走 API，SMTP 退回本地 make_msgid）
            smtp_message_id = self._query_smtp_message_id(account, resend_id, message_id)

            resolved_name = ""
            # 联系人/线索兜底解析：调用方没传就从收件人邮箱反查（回信才能正确定位买家）
            if not lead_id or not contact_id:
                try:
                    from dc_contact_link import link_by_email
                    _link = link_by_email(company_id, envelope)
                    lead_id = lead_id or _link.get("lead_id", "")
                    contact_id = contact_id or _link.get("contact_id", "")
                    resolved_name = _link.get("contact_name", "") or ""
                except Exception:
                    resolved_name = ""

            # Persist enriched outbound facts. Mark legacy when campaign_id is absent.
            outbound = {
                "account_id": account_id,
                "direction": "outbound",
                "message_id": message_id,
                "sender": account["email_address"],
                "recipients": envelope,
                "subject": subject,
                "text_preview": text,
                # 正文原文：邮件回信/案卷要显示原文，不能只有 preview（2026-09-13 修）
                "text": text or "",
                "html": html or "",
                "related": True,
                "status": "sent",
                "created_at": utc_now(),
                "resend_id": resend_id,
                "smtp_message_id": smtp_message_id,
                "thread_id": thread_id,
                "company_id": company_id,
                "campaign_id": campaign_id,
                "lead_id": lead_id,
                "contact_id": contact_id,
                "contact_name": resolved_name,
                "idempotency_key": idempotency_key,
                # 个人邮箱 SMTP 无投递回执：发信成功即乐观默认 delivered，
                # 后续 IMAP 扫到退信 NDR 时由 mark_bounced_by_contact 改回 bounced。
                # 方向不能反：失败必须留空，不能写成 delivered。
                "provider_status": "delivered" if provider_accepted else "",
                "touch_number": touch_number,
                "content_version": content_version,
                "legacy": not bool(campaign_id),
                "updated_at": utc_now(),
            }
            try:
                self.store.insert_message(outbound)
            except Exception:
                # Resend already accepted → do NOT re-send. Save recovery evidence for a
                # status-only retry; then re-raise so callers don't report a false success.
                if provider_accepted:
                    # SMTP 也要写：本地持久化失败时避免重发
                    # （原来只认 resend_id → SMTP 恒不写，重发风险）
                    self._write_recovery_evidence(outbound)
                raise

        return self._build_send_result(
            from_addr=from_addr, to=to, cc=cc, bcc=bcc,
            subject=subject, message_id=message_id,
            dry_run=dry_run, account_id=account_id,
            resend_id=resend_id, idempotency_key=idempotency_key,
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
        resend_id: str = "",
        idempotency_key: str = "",
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
            "resend_id": resend_id,
            "idempotency_key": idempotency_key,
        }
