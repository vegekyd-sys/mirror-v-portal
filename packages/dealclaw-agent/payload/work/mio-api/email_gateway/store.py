from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


MAILBOX_KINDS = {"personal", "enterprise_user", "enterprise_shared", "dealclaw_proxy"}
MEMBER_ROLES = {"owner", "sender", "viewer"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class EmailStore:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _migrate(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS email_accounts (
                    account_id TEXT PRIMARY KEY,
                    enterprise_id TEXT NOT NULL,
                    owner_open_id TEXT NOT NULL,
                    email_address TEXT NOT NULL COLLATE NOCASE,
                    provider TEXT NOT NULL,
                    mailbox_kind TEXT NOT NULL DEFAULT 'personal',
                    auth_type TEXT NOT NULL DEFAULT 'app_password',
                    secret_ref TEXT NOT NULL,
                    display_name TEXT NOT NULL DEFAULT '',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    is_default INTEGER NOT NULL DEFAULT 0,
                    daily_send_limit INTEGER NOT NULL DEFAULT 15,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE (enterprise_id, email_address)
                );

                CREATE TABLE IF NOT EXISTS email_group_bindings (
                    binding_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL REFERENCES email_accounts(account_id) ON DELETE CASCADE,
                    chat_id TEXT NOT NULL,
                    notify_enabled INTEGER NOT NULL DEFAULT 1,
                    inbound_filter TEXT NOT NULL DEFAULT 'dealclaw_replies',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE (account_id, chat_id)
                );

                CREATE TABLE IF NOT EXISTS email_account_members (
                    account_id TEXT NOT NULL REFERENCES email_accounts(account_id) ON DELETE CASCADE,
                    user_open_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (account_id, user_open_id)
                );

                CREATE TABLE IF NOT EXISTS email_sync_state (
                    account_id TEXT NOT NULL REFERENCES email_accounts(account_id) ON DELETE CASCADE,
                    folder TEXT NOT NULL,
                    uidvalidity INTEGER NOT NULL DEFAULT 0,
                    last_uid INTEGER NOT NULL DEFAULT 0,
                    last_sync_at TEXT,
                    health_status TEXT NOT NULL DEFAULT 'new',
                    consecutive_failures INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (account_id, folder)
                );

                CREATE TABLE IF NOT EXISTS email_messages (
                    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id TEXT NOT NULL REFERENCES email_accounts(account_id) ON DELETE CASCADE,
                    direction TEXT NOT NULL,
                    folder TEXT NOT NULL DEFAULT '',
                    uidvalidity INTEGER NOT NULL DEFAULT 0,
                    uid INTEGER NOT NULL DEFAULT 0,
                    message_id TEXT NOT NULL DEFAULT '',
                    in_reply_to TEXT NOT NULL DEFAULT '',
                    references_json TEXT NOT NULL DEFAULT '[]',
                    sender TEXT NOT NULL DEFAULT '',
                    recipients_json TEXT NOT NULL DEFAULT '[]',
                    subject TEXT NOT NULL DEFAULT '',
                    sent_at TEXT,
                    text_preview TEXT NOT NULL DEFAULT '',
                    related INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'received',
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_email_accounts_owner
                  ON email_accounts(enterprise_id, owner_open_id, enabled);
                CREATE INDEX IF NOT EXISTS idx_email_account_members_user
                  ON email_account_members(user_open_id, role);
                CREATE INDEX IF NOT EXISTS idx_email_messages_message_id
                  ON email_messages(account_id, message_id);
                CREATE INDEX IF NOT EXISTS idx_email_messages_created
                  ON email_messages(account_id, created_at);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_inbound_uid
                  ON email_messages(account_id, folder, uidvalidity, uid)
                  WHERE direction='inbound';
                """
            )
            columns = {row[1] for row in conn.execute("PRAGMA table_info(email_accounts)")}
            if "mailbox_kind" not in columns:
                conn.execute(
                    "ALTER TABLE email_accounts ADD COLUMN mailbox_kind TEXT NOT NULL DEFAULT 'personal'"
                )
            conn.execute(
                """
                INSERT OR IGNORE INTO email_account_members(
                    account_id, user_open_id, role, created_at, updated_at
                )
                SELECT account_id, owner_open_id, 'owner', created_at, updated_at
                FROM email_accounts
                """
            )

    def add_account(
        self,
        *,
        enterprise_id: str,
        owner_open_id: str,
        email_address: str,
        provider: str,
        secret_ref: str,
        mailbox_kind: str = "personal",
        auth_type: str = "app_password",
        display_name: str = "",
        is_default: bool = False,
        daily_send_limit: int = 15,
    ) -> dict[str, Any]:
        if not enterprise_id or not owner_open_id or "@" not in email_address:
            raise ValueError("enterprise_id, owner_open_id and a valid email_address are required")
        if daily_send_limit < 1:
            raise ValueError("daily_send_limit must be positive")
        if mailbox_kind not in MAILBOX_KINDS:
            raise ValueError(f"mailbox_kind must be one of: {', '.join(sorted(MAILBOX_KINDS))}")
        now = utc_now()
        account_id = f"ema_{uuid.uuid4().hex[:16]}"
        with self.transaction() as conn:
            if is_default:
                conn.execute(
                    "UPDATE email_accounts SET is_default=0, updated_at=? "
                    "WHERE enterprise_id=? AND owner_open_id=?",
                    (now, enterprise_id, owner_open_id),
                )
            conn.execute(
                """
                INSERT INTO email_accounts(
                    account_id, enterprise_id, owner_open_id, email_address,
                    provider, mailbox_kind, auth_type, secret_ref, display_name, enabled,
                    is_default, daily_send_limit, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
                """,
                (
                    account_id,
                    enterprise_id,
                    owner_open_id,
                    email_address.strip().lower(),
                    provider,
                    mailbox_kind,
                    auth_type,
                    secret_ref,
                    display_name,
                    int(is_default),
                    daily_send_limit,
                    now,
                    now,
                ),
            )
            conn.execute(
                """
                INSERT INTO email_account_members(
                    account_id, user_open_id, role, created_at, updated_at
                ) VALUES (?, ?, 'owner', ?, ?)
                """,
                (account_id, owner_open_id, now, now),
            )
        return self.get_account(account_id)

    def grant_member(self, *, account_id: str, user_open_id: str, role: str) -> dict[str, Any]:
        account = self.get_account(account_id)
        if account["mailbox_kind"] != "enterprise_shared":
            raise PermissionError("only enterprise_shared mailboxes can grant access to another user")
        if role not in MEMBER_ROLES:
            raise ValueError(f"role must be one of: {', '.join(sorted(MEMBER_ROLES))}")
        now = utc_now()
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO email_account_members(account_id, user_open_id, role, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(account_id, user_open_id) DO UPDATE SET
                    role=excluded.role, updated_at=excluded.updated_at
                """,
                (account_id, user_open_id, role, now, now),
            )
        return self.get_member(account_id=account_id, user_open_id=user_open_id)

    def get_member(self, *, account_id: str, user_open_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM email_account_members WHERE account_id=? AND user_open_id=?",
                (account_id, user_open_id),
            ).fetchone()
        if not row:
            raise KeyError("email account member not found")
        return dict(row)

    def list_members(self, *, account_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM email_account_members WHERE account_id=? ORDER BY role, user_open_id",
                    (account_id,),
                ).fetchall()
            ]

    def can_send(self, *, account_id: str, user_open_id: str) -> bool:
        try:
            member = self.get_member(account_id=account_id, user_open_id=user_open_id)
        except KeyError:
            return False
        return member["role"] in {"owner", "sender"}

    def get_account(self, account_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM email_accounts WHERE account_id=?", (account_id,)
            ).fetchone()
        if not row:
            raise KeyError(f"email account not found: {account_id}")
        return dict(row)

    def list_accounts(
        self,
        *,
        enterprise_id: str | None = None,
        owner_open_id: str | None = None,
        enabled_only: bool = False,
    ) -> list[dict[str, Any]]:
        where: list[str] = []
        values: list[Any] = []
        if enterprise_id:
            where.append("enterprise_id=?")
            values.append(enterprise_id)
        if owner_open_id:
            where.append("owner_open_id=?")
            values.append(owner_open_id)
        if enabled_only:
            where.append("enabled=1")
        sql = "SELECT * FROM email_accounts"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY enterprise_id, owner_open_id, is_default DESC, email_address"
        with self.connect() as conn:
            return [dict(row) for row in conn.execute(sql, values).fetchall()]

    def disable_account(self, account_id: str) -> None:
        with self.transaction() as conn:
            cur = conn.execute(
                "UPDATE email_accounts SET enabled=0, updated_at=? WHERE account_id=?",
                (utc_now(), account_id),
            )
            if cur.rowcount != 1:
                raise KeyError(f"email account not found: {account_id}")

    def bind_group(
        self,
        *,
        account_id: str,
        chat_id: str,
        inbound_filter: str = "dealclaw_replies",
        notify_enabled: bool = True,
    ) -> dict[str, Any]:
        if inbound_filter not in {"dealclaw_replies", "all"}:
            raise ValueError("inbound_filter must be dealclaw_replies or all")
        now = utc_now()
        binding_id = f"emb_{uuid.uuid4().hex[:16]}"
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO email_group_bindings(
                    binding_id, account_id, chat_id, notify_enabled,
                    inbound_filter, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_id, chat_id) DO UPDATE SET
                    notify_enabled=excluded.notify_enabled,
                    inbound_filter=excluded.inbound_filter,
                    updated_at=excluded.updated_at
                """,
                (
                    binding_id,
                    account_id,
                    chat_id,
                    int(notify_enabled),
                    inbound_filter,
                    now,
                    now,
                ),
            )
        return self.get_binding(account_id=account_id, chat_id=chat_id)

    def get_binding(self, *, account_id: str, chat_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM email_group_bindings WHERE account_id=? AND chat_id=?",
                (account_id, chat_id),
            ).fetchone()
        if not row:
            raise KeyError("email group binding not found")
        return dict(row)

    def list_bindings(self, *, chat_id: str | None = None) -> list[dict[str, Any]]:
        sql = """
            SELECT b.*, a.enterprise_id, a.owner_open_id, a.email_address, a.provider
            FROM email_group_bindings b
            JOIN email_accounts a ON a.account_id=b.account_id
        """
        values: list[Any] = []
        if chat_id:
            sql += " WHERE b.chat_id=?"
            values.append(chat_id)
        sql += " ORDER BY b.chat_id, a.owner_open_id, a.email_address"
        with self.connect() as conn:
            return [dict(row) for row in conn.execute(sql, values).fetchall()]

    def get_sync_state(self, account_id: str, folder: str = "INBOX") -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM email_sync_state WHERE account_id=? AND folder=?",
                (account_id, folder),
            ).fetchone()
        return dict(row) if row else None

    def update_sync_state(
        self,
        *,
        account_id: str,
        folder: str,
        uidvalidity: int,
        last_uid: int,
        health_status: str = "healthy",
        last_error: str = "",
        consecutive_failures: int = 0,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        target = conn or self.connect()
        try:
            target.execute(
                """
                INSERT INTO email_sync_state(
                    account_id, folder, uidvalidity, last_uid, last_sync_at,
                    health_status, consecutive_failures, last_error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_id, folder) DO UPDATE SET
                    uidvalidity=excluded.uidvalidity,
                    last_uid=excluded.last_uid,
                    last_sync_at=excluded.last_sync_at,
                    health_status=excluded.health_status,
                    consecutive_failures=excluded.consecutive_failures,
                    last_error=excluded.last_error
                """,
                (
                    account_id,
                    folder,
                    uidvalidity,
                    last_uid,
                    utc_now(),
                    health_status,
                    consecutive_failures,
                    last_error[:500],
                ),
            )
            if conn is None:
                target.commit()
        finally:
            if conn is None:
                target.close()

    def record_sync_failure(self, account_id: str, folder: str, error: str) -> None:
        state = self.get_sync_state(account_id, folder) or {}
        self.update_sync_state(
            account_id=account_id,
            folder=folder,
            uidvalidity=int(state.get("uidvalidity", 0)),
            last_uid=int(state.get("last_uid", 0)),
            health_status="error",
            last_error=error,
            consecutive_failures=int(state.get("consecutive_failures", 0)) + 1,
        )

    def has_outbound_reference(self, account_id: str, message_ids: list[str]) -> bool:
        ids = [value.strip() for value in message_ids if value and value.strip()]
        if not ids:
            return False
        placeholders = ",".join("?" for _ in ids)
        with self.connect() as conn:
            row = conn.execute(
                f"""
                SELECT 1 FROM email_messages
                WHERE account_id=? AND direction='outbound'
                  AND message_id IN ({placeholders})
                LIMIT 1
                """,
                [account_id, *ids],
            ).fetchone()
        return bool(row)

    def insert_message(self, message: dict[str, Any], conn: sqlite3.Connection | None = None) -> bool:
        target = conn or self.connect()
        try:
            cur = target.execute(
                """
                INSERT OR IGNORE INTO email_messages(
                    account_id, direction, folder, uidvalidity, uid, message_id,
                    in_reply_to, references_json, sender, recipients_json,
                    subject, sent_at, text_preview, related, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message["account_id"],
                    message["direction"],
                    message.get("folder", ""),
                    int(message.get("uidvalidity", 0)),
                    int(message.get("uid", 0)),
                    message.get("message_id", ""),
                    message.get("in_reply_to", ""),
                    json.dumps(message.get("references", []), ensure_ascii=False),
                    message.get("sender", ""),
                    json.dumps(message.get("recipients", []), ensure_ascii=False),
                    message.get("subject", ""),
                    message.get("sent_at"),
                    message.get("text_preview", "")[:1000],
                    int(bool(message.get("related", False))),
                    message.get("status", "received"),
                    message.get("created_at", utc_now()),
                ),
            )
            if conn is None:
                target.commit()
            return cur.rowcount == 1
        finally:
            if conn is None:
                target.close()

    def count_sent_today(self, account_id: str) -> int:
        day = datetime.now(timezone.utc).date().isoformat()
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count FROM email_messages
                WHERE account_id=? AND direction='outbound'
                  AND status='sent' AND substr(created_at, 1, 10)=?
                """,
                (account_id, day),
            ).fetchone()
        return int(row["count"])

    def select_sender_account(
        self, *, enterprise_id: str, owner_open_id: str, account_id: str | None = None
    ) -> dict[str, Any]:
        if account_id:
            account = self.get_account(account_id)
            if (
                account["enterprise_id"] != enterprise_id
                or account["owner_open_id"] != owner_open_id
                or not account["enabled"]
            ):
                raise PermissionError("email account does not belong to this user and enterprise")
            return account
        with self.connect() as conn:
            accounts = [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT DISTINCT a.* FROM email_accounts a
                    JOIN email_account_members m ON m.account_id=a.account_id
                    WHERE a.enterprise_id=? AND a.enabled=1 AND m.user_open_id=?
                      AND m.role IN ('owner', 'sender')
                    ORDER BY a.is_default DESC, a.email_address
                    """,
                    (enterprise_id, owner_open_id),
                ).fetchall()
            ]
        defaults = [row for row in accounts if row["is_default"]]
        if len(defaults) == 1:
            return defaults[0]
        if len(accounts) == 1:
            return accounts[0]
        if not accounts:
            raise KeyError("no enabled email account for this user")
        raise ValueError("multiple email accounts available; account_id is required")
