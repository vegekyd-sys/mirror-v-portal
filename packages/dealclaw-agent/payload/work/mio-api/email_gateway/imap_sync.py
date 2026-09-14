from __future__ import annotations

import email
import imaplib
import re
import ssl
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import getaddresses, parsedate_to_datetime
from typing import Any, Callable

from .imap_compat import prepare_imap_session
from .providers import get_provider
from .secrets import resolve_secret
from .store import EmailStore, utc_now

# 退信（NDR）识别/解析/分类：dc_bounce_detect.py 位于 work/mio-api/ 根目录
# （与 enterprise_ids 同模式）。cwd 不在根目录时（cron/服务）把根目录挂上 sys.path 再试，
# 仍失败则降级为「永不判退信」，绝不因缺模块中断收信。
try:
    from dc_bounce_detect import (
        is_bounce, classify_bounce, extract_bounced_recipient, body_text,
    )
except Exception:  # noqa: BLE001
    try:
        import sys as _sys
        from pathlib import Path as _Path

        _root = str(_Path(__file__).resolve().parents[1])
        if _root not in _sys.path:
            _sys.path.insert(0, _root)
        from dc_bounce_detect import (
            is_bounce, classify_bounce, extract_bounced_recipient, body_text,
        )
    except Exception:  # noqa: BLE001
        is_bounce = lambda msg, sender="", subject="": False  # noqa: E731
        classify_bounce = lambda text="": "unknown"  # noqa: E731
        extract_bounced_recipient = lambda msg: ""  # noqa: E731
        body_text = lambda msg, limit=4000: ""  # noqa: E731


def _decode(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def _message_ids(value: str | None) -> list[str]:
    if not value:
        return []
    found = re.findall(r"<[^>]+>", value)
    return found or [part.strip() for part in value.split() if part.strip()]


def _body_preview(msg: Message, limit: int = 1000) -> str:
    candidates: list[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            if "attachment" in (part.get("Content-Disposition", "").lower()):
                continue
            if part.get_content_type() == "text/plain":
                try:
                    payload = part.get_payload(decode=True) or b""
                    candidates.append(payload.decode(part.get_content_charset() or "utf-8", "replace"))
                except Exception:
                    continue
    elif msg.get_content_type() == "text/plain":
        payload = msg.get_payload(decode=True) or b""
        candidates.append(payload.decode(msg.get_content_charset() or "utf-8", "replace"))
    text = "\n".join(candidates)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def _extract_attachments(msg: Message) -> list[tuple[str, str, bytes]]:
    """从 MIME 里取出附件 (filename, content_type, bytes)。

    判定口径：Content-Disposition 为 attachment，或任何带 filename 的 part（很多客户端
    把图片发成 inline + filename，买家的 logo/产品图常走这条）。正文 part（无 filename
    的 text/plain、text/html）不算附件。
    """
    out: list[tuple[str, str, bytes]] = []
    if not msg.is_multipart():
        return out
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        disp = (part.get("Content-Disposition") or "").lower()
        filename = part.get_filename()
        if "attachment" not in disp and not filename:
            continue
        try:
            payload = part.get_payload(decode=True) or b""
        except Exception:  # noqa: BLE001 - 单个坏 part 不该中断整封信
            continue
        if not payload:
            continue
        try:
            filename = str(make_header(decode_header(filename))) if filename else ""
        except Exception:  # noqa: BLE001
            filename = filename or ""
        out.append((filename or "attachment", part.get_content_type() or "", payload))
    return out


def _store_attachments(msg: Message, *, message_id: str, company_id: str,
                       received_at: str = "") -> list[dict]:
    """落盘到统一附件库（与 Resend 入站同一套目录/索引约定）。失败不中断收信。"""
    items = _extract_attachments(msg)
    if not items:
        return []
    try:
        from dc_resend_attachments import store_bytes, append_index, _month
    except Exception:  # noqa: BLE001 - 根目录不在 sys.path 时降级为不存附件
        return []
    ym = _month(received_at)
    rows = []
    for filename, content_type, blob in items:
        try:
            rows.append(store_bytes(company_id=company_id, message_id=message_id or "no-message-id",
                                    filename=filename, content_type=content_type,
                                    data=blob, ym=ym))
        except Exception as e:  # noqa: BLE001
            rows.append({"message_id": message_id, "filename": filename,
                         "stored": False, "error": str(e)[:120]})
    try:
        append_index(rows, company_id=company_id, ym=ym)
    except Exception:  # noqa: BLE001
        pass
    return rows


def _parse_uidvalidity(client: imaplib.IMAP4_SSL, select_data: list[bytes] | None) -> int:
    response = client.response("UIDVALIDITY")
    values: list[Any] = []
    if response and response[1]:
        values.extend(response[1])
    if select_data:
        values.extend(select_data)
    for value in values:
        text = value.decode() if isinstance(value, bytes) else str(value)
        match = re.search(r"UIDVALIDITY\s+(\d+)", text, re.I)
        if match:
            return int(match.group(1))
        if text.isdigit() and response and response[0] == "UIDVALIDITY":
            return int(text)
    status, data = client.status("INBOX", "(UIDVALIDITY)")
    if status == "OK" and data:
        match = re.search(r"UIDVALIDITY\s+(\d+)", data[0].decode(), re.I)
        if match:
            return int(match.group(1))
    raise RuntimeError("IMAP server did not return UIDVALIDITY")


def _uids(data: list[bytes] | None) -> list[int]:
    if not data or not data[0]:
        return []
    return sorted({int(part) for part in data[0].split() if part.isdigit()})


@dataclass
class SyncResult:
    account_id: str
    email_address: str
    fetched: int = 0
    related: int = 0
    filtered: int = 0
    initialized: bool = False
    uidvalidity_reset: bool = False
    last_uid: int = 0
    events: list[dict[str, Any]] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "account_id": self.account_id,
            "email_address": self.email_address,
            "fetched": self.fetched,
            "related": self.related,
            "filtered": self.filtered,
            "initialized": self.initialized,
            "uidvalidity_reset": self.uidvalidity_reset,
            "last_uid": self.last_uid,
            "events": self.events or [],
        }


class ImapSynchronizer:
    def __init__(
        self,
        store: EmailStore,
        *,
        client_factory: Callable[..., imaplib.IMAP4_SSL] | None = None,
        secret_resolver: Callable[[str], str] = resolve_secret,
    ):
        self.store = store
        self.client_factory = client_factory or imaplib.IMAP4_SSL
        self.secret_resolver = secret_resolver

    def _record_reply_fact(self, account, bound, buyer_email, reply_text, inbound_message_id):
        """把已绑定的入站回复写入七信号（统一信号入口）。"""
        try:
            from dc_email_controller.dc_email_signals import analyze_reply, process_reply
            from dc_email_controller.dc_signal_push import evaluate_for_push
            from enterprise_ids import canonical_company_id
            _company = canonical_company_id(bound.get("company_id", "") or account.get("enterprise_id", ""))
            _buyer = (buyer_email.split("@")[-1].lower() if "@" in buyer_email else buyer_email)
            _a = analyze_reply(reply_text or "", buyer_domain=_buyer, enterprise=_company)
            _res = process_reply(
                reply_text=reply_text or "", message_id=inbound_message_id,
                thread_id=bound.get("thread_id") or bound.get("local_message_id", ""),
                company_id=_company, campaign_id=bound.get("campaign_id", ""),
                lead_id=bound.get("lead_id", ""), contact_id=bound.get("contact_id", ""),
                iq_intent=_a["intent"], requested_materials=_a["requested_materials"],
                missing_fields=_a["missing_fields"], confidence=_a["confidence"])
            evaluate_for_push([s["signal_id"] for s in _res.get("signals", [])])
        except Exception as e:
            print(f"[imap_sync] signal failed: {e}")

    def sync_account(
        self,
        account_id: str,
        *,
        folder: str = "INBOX",
        bootstrap_days: int = 0,
    ) -> SyncResult:
        account = self.store.get_account(account_id)
        if not account["enabled"]:
            raise ValueError("email account is disabled")
        provider = get_provider(account["provider"])
        if not provider.imap_host:
            return SyncResult(account_id=account_id, email_address=account["email_address"], events=[])
        secret = self.secret_resolver(account["secret_ref"])
        client: imaplib.IMAP4_SSL | None = None
        result = SyncResult(account_id=account_id, email_address=account["email_address"], events=[])
        try:
            client = self.client_factory(
                provider.imap_host,
                provider.imap_port,
                ssl_context=ssl.create_default_context(),
                timeout=30,
            )
            client.login(account["email_address"], secret)
            prepare_imap_session(client, provider)
            status, select_data = client.select(folder, readonly=True)
            if status != "OK":
                raise RuntimeError(f"unable to open IMAP folder {folder}")
            uidvalidity = _parse_uidvalidity(client, select_data)
            state = self.store.get_sync_state(account_id, folder)

            if state is None:
                if bootstrap_days <= 0:
                    status, data = client.uid("search", None, "ALL")
                    if status != "OK":
                        raise RuntimeError("initial IMAP UID search failed")
                    all_uids = _uids(data)
                    latest = max(all_uids, default=0)
                    self.store.update_sync_state(
                        account_id=account_id,
                        folder=folder,
                        uidvalidity=uidvalidity,
                        last_uid=latest,
                    )
                    result.initialized = True
                    result.last_uid = latest
                    return result
                start_uid = 1
            elif int(state["uidvalidity"]) != uidvalidity:
                result.uidvalidity_reset = True
                bootstrap_days = max(bootstrap_days, 7)
                start_uid = 1
            else:
                start_uid = int(state["last_uid"]) + 1

            bootstrap_highwater: int | None = None
            if bootstrap_days > 0 and start_uid == 1:
                all_status, all_data = client.uid("search", None, "ALL")
                if all_status != "OK":
                    raise RuntimeError("IMAP bootstrap high-water search failed")
                bootstrap_highwater = max(_uids(all_data), default=0)
                since = (datetime.now(timezone.utc) - timedelta(days=bootstrap_days)).strftime("%d-%b-%Y")
                status, data = client.uid("search", None, "SINCE", since)
            else:
                status, data = client.uid("search", None, f"UID {start_uid}:*")
            if status != "OK":
                raise RuntimeError("incremental IMAP UID search failed")
            pending = [
                uid for uid in _uids(data)
                if uid >= start_uid and (bootstrap_highwater is None or uid <= bootstrap_highwater)
            ]
            last_uid = start_uid - 1

            bindings = [
                row for row in self.store.list_bindings()
                if row["account_id"] == account_id and row["notify_enabled"]
            ]
            emit_all = any(row["inbound_filter"] == "all" for row in bindings)

            for uid in pending:
                status, parts = client.uid("fetch", str(uid), "(UID BODY.PEEK[])")
                if status != "OK":
                    raise RuntimeError(f"IMAP fetch failed at UID {uid}")
                raw = b""
                for part in parts or []:
                    if isinstance(part, tuple) and isinstance(part[1], bytes):
                        raw += part[1]
                if not raw:
                    raise RuntimeError(f"IMAP returned an empty message at UID {uid}")
                msg = email.message_from_bytes(raw)
                message_id = (msg.get("Message-ID") or "").strip()
                in_reply_to = (msg.get("In-Reply-To") or "").strip()
                references = _message_ids(msg.get("References"))
                reference_candidates = [*_message_ids(in_reply_to), *references]
                sender = ", ".join(address for _, address in getaddresses(msg.get_all("From", [])))
                from_addresses = [address for _, address in getaddresses(msg.get_all("From", []))]
                first_from = from_addresses[0] if from_addresses else sender
                subject = _decode(msg.get("Subject"))
                recipients = [address for _, address in getaddresses(msg.get_all("To", []))]
                sent_at = None
                if msg.get("Date"):
                    try:
                        sent_at = parsedate_to_datetime(msg.get("Date")).astimezone(timezone.utc).isoformat()
                    except Exception:
                        sent_at = None

                # 退信分流：NDR 不当买家回复，而是把原 outbound 标成 bounced
                if is_bounce(msg, first_from, subject):
                    bounced_email = extract_bounced_recipient(msg) or ""
                    category = classify_bounce(body_text(msg))
                    if bounced_email:
                        self.store.mark_bounced_by_contact(account_id, bounced_email, category)
                    self.store.insert_message({
                        "account_id": account_id, "direction": "inbound",
                        "folder": folder, "uidvalidity": uidvalidity, "uid": uid,
                        "message_id": message_id, "in_reply_to": in_reply_to,
                        "references": references, "sender": sender,
                        "recipients": recipients, "subject": subject,
                        "sent_at": sent_at, "text_preview": _body_preview(msg, limit=500),
                        "related": False, "status": "received", "created_at": utc_now(),
                    })
                    result.fetched += 1
                    last_uid = uid
                    self.store.update_sync_state(
                        account_id=account_id, folder=folder,
                        uidvalidity=uidvalidity, last_uid=last_uid,
                    )
                    continue

                related = self.store.has_outbound_reference(account_id, reference_candidates)
                outbound_row = None
                if not related:
                    # 腾讯企业邮等回信不带 In-Reply-To/References → 按发件人邮箱回退匹配
                    outbound_row = self.store.find_outbound_by_contact(account_id, first_from)
                    related = outbound_row is not None
                stored_preview = _body_preview(msg) if related else ""

                # 附件只对「关联到已知 outbound」的邮件落盘：与正文保留口径一致，
                # 不囤积用户私人邮件的附件（REDLINES 七·数据主权）。
                attachments = []
                if related:
                    if outbound_row is None:
                        outbound_row = self.store.find_outbound_by_reference(
                            account_id, reference_candidates) or {}
                    attachments = _store_attachments(
                        msg, message_id=message_id,
                        company_id=outbound_row.get("company_id", "") if outbound_row else "",
                        received_at=sent_at or "",
                    )
                notification_preview = (
                    stored_preview[:200]
                    if related
                    else (_body_preview(msg, limit=200) if emit_all else "")
                )
                stored = self.store.insert_message(
                    {
                        "account_id": account_id,
                        "direction": "inbound",
                        "folder": folder,
                        "uidvalidity": uidvalidity,
                        "uid": uid,
                        "message_id": message_id,
                        "in_reply_to": in_reply_to,
                        "references": references,
                        "sender": sender,
                        "recipients": recipients,
                        "subject": subject,
                        "sent_at": sent_at,
                        # Header-only notifications for unrelated personal mail.
                        # Bodies are retained only for messages tied to a known
                        # DealClaw outbound reference.
                        "text_preview": stored_preview,
                        "attachments": attachments,
                        "related": related,
                        "status": "received" if (related or emit_all) else "filtered",
                        "created_at": utc_now(),
                    }
                )
                if stored:
                    result.fetched += 1
                    if related:
                        result.related += 1
                        # 绑定原 outbound（In-Reply-To / References），复制 company/campaign/lead/contact 身份，写 log_reply
                        bound = self.store.bind_reply_to_outbound(
                            account_id=account_id,
                            inbound_message_id=message_id,
                            reference_ids=reference_candidates,
                        )
                        if bound is not None:
                            self._record_reply_fact(account, bound, first_from, stored_preview, message_id)
                    if not related and not emit_all:
                        result.filtered += 1
                    if related or emit_all:
                        result.events.append(
                            {
                                "type": "mail.received",
                                "account_id": account_id,
                                "enterprise_id": account["enterprise_id"],
                                "owner_open_id": account["owner_open_id"],
                                "email_address": account["email_address"],
                                "chat_ids": [row["chat_id"] for row in bindings],
                                "uid": uid,
                                "message_id": message_id,
                                "from": sender,
                                "subject": _decode(msg.get("Subject")),
                                "preview": notification_preview,
                                "attachments": attachments,
                                "related": related,
                            }
                        )
                last_uid = uid
                self.store.update_sync_state(
                    account_id=account_id,
                    folder=folder,
                    uidvalidity=uidvalidity,
                    last_uid=last_uid,
                )

            if bootstrap_highwater is not None:
                last_uid = bootstrap_highwater
                self.store.update_sync_state(
                    account_id=account_id,
                    folder=folder,
                    uidvalidity=uidvalidity,
                    last_uid=last_uid,
                )
            elif not pending:
                last_uid = int(state["last_uid"]) if state else 0
                self.store.update_sync_state(
                    account_id=account_id,
                    folder=folder,
                    uidvalidity=uidvalidity,
                    last_uid=last_uid,
                )
            result.last_uid = last_uid
            return result
        except Exception as exc:
            self.store.record_sync_failure(account_id, folder, type(exc).__name__)
            raise
        finally:
            if client is not None:
                try:
                    client.logout()
                except Exception:
                    pass

    def sync_all(self, *, bootstrap_days: int = 0) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for account in self.store.list_accounts(enabled_only=True):
            try:
                results.append(
                    {"ok": True, **self.sync_account(account["account_id"], bootstrap_days=bootstrap_days).as_dict()}
                )
            except Exception as exc:
                results.append(
                    {
                        "ok": False,
                        "account_id": account["account_id"],
                        "email_address": account["email_address"],
                        "error": type(exc).__name__,
                    }
                )
        return results
