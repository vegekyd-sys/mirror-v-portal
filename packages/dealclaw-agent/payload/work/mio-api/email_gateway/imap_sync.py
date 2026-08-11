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
                related = self.store.has_outbound_reference(account_id, reference_candidates)
                sender = ", ".join(address for _, address in getaddresses(msg.get_all("From", [])))
                recipients = [address for _, address in getaddresses(msg.get_all("To", []))]
                sent_at = None
                if msg.get("Date"):
                    try:
                        sent_at = parsedate_to_datetime(msg.get("Date")).astimezone(timezone.utc).isoformat()
                    except Exception:
                        sent_at = None
                stored_preview = _body_preview(msg) if related else ""
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
                        "subject": _decode(msg.get("Subject")),
                        "sent_at": sent_at,
                        # Header-only notifications for unrelated personal mail.
                        # Bodies are retained only for messages tied to a known
                        # DealClaw outbound reference.
                        "text_preview": stored_preview,
                        "related": related,
                        "status": "received" if (related or emit_all) else "filtered",
                        "created_at": utc_now(),
                    }
                )
                if stored:
                    result.fetched += 1
                    if related:
                        result.related += 1
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
