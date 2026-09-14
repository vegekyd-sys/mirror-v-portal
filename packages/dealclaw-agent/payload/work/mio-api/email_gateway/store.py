from __future__ import annotations

import fcntl
import hashlib
import json
import os
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

# ── 无 SQLite。所有持久化走 Markdown 文件，根目录 <data_dir>/email-facts/ ──

MAILBOX_KINDS = {"personal", "enterprise_user", "enterprise_shared", "dealclaw_proxy"}
MEMBER_ROLES = {"owner", "sender", "viewer"}

SNAPSHOT_HEADER = "# DealClaw Email Record"
INDEX_HEADER = "# DealClaw Email Index"

# provider_status 终态：迟到的 delivered 不得覆盖
_TERMINAL = {"bounced", "complained", "failed"}

# webhook 处理超时（秒）：processing 超过此时长才允许重新 claim
_WEBHOOK_CLAIM_TIMEOUT = int(os.environ.get("DC_WEBHOOK_CLAIM_TIMEOUT", "300"))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ym(dt: str | None) -> str:
    if not dt:
        dt = utc_now()
    return dt[:7] if len(dt) >= 7 else datetime.now(timezone.utc).strftime("%Y-%m")


def _day(dt: str | None) -> str:
    if not dt:
        dt = utc_now()
    return dt[:10] if len(dt) >= 10 else datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _hash_key(s: str) -> str:
    """SHA-256，不直接使用 Message-ID / 邮箱地址作为文件名。"""
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()


# ── 通用 Markdown 文件读写 ──────────────────────────────────

@contextmanager
def _file_lock(lock_path: Path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    f = open(lock_path, "a")
    try:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def _write_snapshot(path: Path, obj: dict) -> None:
    """原子写：临时文件 → flush → fsync → os.replace；权限 0600。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    content = SNAPSHOT_HEADER + "\n\n" + json.dumps(obj, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_snapshot(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    except OSError:
        return None
    return None


def _append_log(path: Path, obj: dict, lock_dir: Path) -> None:
    """append 前 fcntl.flock；每行一个完整 JSON，不允许多行 JSON。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / f".{path.stem}.lock"
    with _file_lock(lock_path):
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def _list_snapshots(glob_path: Path, *, exclude: str = "") -> Iterator[dict]:
    if not glob_path.exists():
        return
    for p in sorted(glob_path.rglob("*.md")):
        if exclude and exclude in str(p):
            continue
        rec = _read_snapshot(p)
        if rec:
            yield rec


class MarkdownEmailStore:
    """Markdown 邮件事实存储。根目录 <data_dir>/email-facts/。"""

    def __init__(self, data_dir: str | Path | None = None):
        if data_dir:
            self.data_dir = Path(data_dir)
        else:
            default = Path(__file__).resolve().parent.parent / "data"
            self.data_dir = Path(os.environ.get("DC_DATA_DIR", str(default)))
        self.root = self.data_dir / "email-facts"
        self._outbound = self.root / "outbound"
        self._inbound = self.root / "inbound"
        self._webhook = self.root / "webhook-events"
        self._delivery = self.root / "delivery-events"
        self._reply = self.root / "reply-events"
        self._indexes = self.root / "indexes"
        self._recovery = self.root / "recovery"
        self._locks = self.root / "locks"
        self._accounts = self.root / "accounts"
        self._bindings = self.root / "bindings"
        self._members = self.root / "members"
        self._sync_state = self.root / "sync-state"
        for d in (self._outbound, self._inbound, self._webhook, self._delivery,
                  self._reply, self._indexes, self._recovery, self._locks,
                  self._accounts, self._bindings, self._members, self._sync_state):
            d.mkdir(parents=True, exist_ok=True)

    # ── 路径助手 ──────────────────────────────────────────
    def _company_dir(self, kind: str, company_id: str) -> Path:
        base = self._outbound if kind == "outbound" else self._inbound
        return base / (company_id or "_unmatched")

    def _index_path(self, kind: str, key: str) -> Path:
        return self._indexes / kind / f"{_hash_key(key)}.md"

    # ── 索引 ──────────────────────────────────────────────
    def _write_index(self, kind: str, key: str, record_path: str) -> None:
        path = self._index_path(kind, key)
        if path.exists():
            return  # 已存在，不覆盖（幂等）
        obj = {"key_type": kind, "key_hash": _hash_key(key),
               "record_path": record_path, "created_at": utc_now()}
        content = INDEX_HEADER + "\n\n" + json.dumps(obj, ensure_ascii=False) + "\n"
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
        except FileExistsError:
            pass

    def _read_index(self, kind: str, key: str) -> dict | None:
        return _read_snapshot(self._index_path(kind, key))

    def _record_path(self, kind: str, company_id: str, ym: str, record_key: str) -> str:
        # 相对于 email-facts/ 的路径
        return f"{kind}/{company_id or '_unmatched'}/{ym}/{record_key}.md"

    @contextmanager
    def _record_lock(self, key: str):
        """记录级锁：key 的 SHA-256 作锁文件名（不用邮箱/原始 Message-ID）。"""
        lock_path = self._locks / f"{_hash_key(key)}.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        f = open(lock_path, "a")
        try:
            fcntl.flock(f, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
            f.close()

    # ── Accounts（元数据快照）──────────────────────────────
    def add_account(self, *, enterprise_id, owner_open_id, email_address, provider,
                    secret_ref, mailbox_kind="personal", auth_type="app_password",
                    display_name="", is_default=False, daily_send_limit=30) -> dict:
        if not enterprise_id or not owner_open_id or "@" not in email_address:
            raise ValueError("enterprise_id, owner_open_id and a valid email_address are required")
        if daily_send_limit < 1:
            raise ValueError("daily_send_limit must be positive")
        if mailbox_kind not in MAILBOX_KINDS:
            raise ValueError(f"mailbox_kind must be one of: {', '.join(sorted(MAILBOX_KINDS))}")
        email = email_address.strip().lower()
        for a in self.list_accounts(enterprise_id=enterprise_id):
            if a.get("email_address") == email:
                raise ValueError("duplicate email address for this enterprise")
        now = utc_now()
        account_id = f"ema_{uuid.uuid4().hex[:16]}"
        if is_default:
            for a in self.list_accounts(enterprise_id=enterprise_id, owner_open_id=owner_open_id):
                if a.get("is_default"):
                    self._update_account(a["account_id"], is_default=0)
        rec = {
            "schema_version": 1, "record_type": "account",
            "account_id": account_id, "enterprise_id": enterprise_id,
            "owner_open_id": owner_open_id, "email_address": email_address.strip().lower(),
            "provider": provider, "mailbox_kind": mailbox_kind, "auth_type": auth_type,
            "secret_ref": secret_ref, "display_name": display_name, "enabled": 1,
            "is_default": int(is_default), "daily_send_limit": daily_send_limit,
            "created_at": now, "updated_at": now,
        }
        _write_snapshot(self._accounts / f"{account_id}.md", rec)
        self.grant_member(account_id=account_id, user_open_id=owner_open_id, role="owner")
        return self.get_account(account_id)

    def _update_account(self, account_id: str, **fields) -> None:
        rec = self.get_account(account_id)
        rec.update(fields)
        rec["updated_at"] = utc_now()
        _write_snapshot(self._accounts / f"{account_id}.md", rec)

    def grant_member(self, *, account_id: str, user_open_id: str, role: str) -> dict:
        account = self.get_account(account_id)
        if account["mailbox_kind"] != "enterprise_shared" and role != "owner":
            raise PermissionError("only enterprise_shared mailboxes can grant access to another user")
        if role not in MEMBER_ROLES:
            raise ValueError(f"role must be one of: {', '.join(sorted(MEMBER_ROLES))}")
        now = utc_now()
        rec = {"schema_version": 1, "record_type": "member", "account_id": account_id,
               "user_open_id": user_open_id, "role": role, "created_at": now, "updated_at": now}
        mdir = self._members / account_id
        mdir.mkdir(parents=True, exist_ok=True)
        _write_snapshot(mdir / f"{_hash_key(user_open_id)}.md", rec)
        return rec

    def get_member(self, *, account_id: str, user_open_id: str) -> dict:
        p = self._members / account_id / f"{_hash_key(user_open_id)}.md"
        rec = _read_snapshot(p)
        if not rec:
            raise KeyError("email account member not found")
        return rec

    def list_members(self, *, account_id: str) -> list[dict]:
        mdir = self._members / account_id
        if not mdir.exists():
            return []
        out = []
        for p in sorted(mdir.glob("*.md")):
            rec = _read_snapshot(p)
            if rec:
                out.append(rec)
        return sorted(out, key=lambda r: (r.get("role", ""), r.get("user_open_id", "")))

    def can_send(self, *, account_id: str, user_open_id: str) -> bool:
        try:
            m = self.get_member(account_id=account_id, user_open_id=user_open_id)
        except KeyError:
            return False
        return m["role"] in {"owner", "sender"}

    def get_account(self, account_id: str) -> dict:
        rec = _read_snapshot(self._accounts / f"{account_id}.md")
        if not rec:
            raise KeyError(f"email account not found: {account_id}")
        return rec

    def list_accounts(self, *, enterprise_id=None, owner_open_id=None, enabled_only=False) -> list[dict]:
        out = []
        for rec in _list_snapshots(self._accounts):
            if enterprise_id and rec.get("enterprise_id") != enterprise_id:
                continue
            if owner_open_id and rec.get("owner_open_id") != owner_open_id:
                continue
            if enabled_only and not rec.get("enabled"):
                continue
            out.append(rec)
        out.sort(key=lambda r: (r.get("enterprise_id", ""), r.get("owner_open_id", ""),
                                -(r.get("is_default", 0)), r.get("email_address", "")))
        return out

    def disable_account(self, account_id: str) -> None:
        self._update_account(account_id, enabled=0)

    def bind_group(self, *, account_id, chat_id, inbound_filter="dealclaw_replies", notify_enabled=True,
                   webhook_url="", webhook_secret="") -> dict:
        if inbound_filter not in {"dealclaw_replies", "all"}:
            raise ValueError("inbound_filter must be dealclaw_replies or all")
        now = utc_now()
        # 查找已有绑定（同 account_id + chat_id）
        existing = None
        for b in self.list_bindings():
            if b.get("account_id") == account_id and b.get("chat_id") == chat_id:
                existing = b
                break
        binding_id = existing["binding_id"] if existing else f"emb_{uuid.uuid4().hex[:16]}"
        rec = {"schema_version": 1, "record_type": "binding", "binding_id": binding_id,
               "account_id": account_id, "chat_id": chat_id,
               "notify_enabled": int(bool(notify_enabled)), "inbound_filter": inbound_filter,
               "webhook_url": webhook_url, "webhook_secret": webhook_secret,
               "created_at": existing["created_at"] if existing else now, "updated_at": now}
        _write_snapshot(self._bindings / f"{binding_id}.md", rec)
        return rec

    def get_binding(self, *, account_id: str, chat_id: str) -> dict:
        for b in self.list_bindings():
            if b.get("account_id") == account_id and b.get("chat_id") == chat_id:
                return b
        raise KeyError("email group binding not found")

    def list_bindings(self, *, chat_id=None) -> list[dict]:
        out = []
        for b in _list_snapshots(self._bindings):
            if chat_id and b.get("chat_id") != chat_id:
                continue
            try:
                a = self.get_account(b["account_id"])
            except KeyError:
                continue
            merged = dict(b)
            merged.update({
                "enterprise_id": a.get("enterprise_id", ""),
                "owner_open_id": a.get("owner_open_id", ""),
                "email_address": a.get("email_address", ""),
                "provider": a.get("provider", ""),
            })
            out.append(merged)
        out.sort(key=lambda r: (r.get("chat_id", ""), r.get("owner_open_id", ""), r.get("email_address", "")))
        return out

    # ── IMAP sync state ──────────────────────────────────
    def get_sync_state(self, account_id: str, folder: str = "INBOX") -> dict | None:
        return _read_snapshot(self._sync_state / account_id / f"{_hash_key(folder)}.md")

    def update_sync_state(self, *, account_id, folder, uidvalidity, last_uid,
                          health_status="healthy", last_error="", consecutive_failures=0) -> None:
        now = utc_now()
        prev = self.get_sync_state(account_id, folder) or {}
        rec = {"schema_version": 1, "record_type": "sync_state", "account_id": account_id,
               "folder": folder, "uidvalidity": int(uidvalidity), "last_uid": int(last_uid),
               "last_sync_at": now, "health_status": health_status,
               "consecutive_failures": consecutive_failures, "last_error": last_error[:500],
               "created_at": prev.get("created_at", now), "updated_at": now}
        d = self._sync_state / account_id
        d.mkdir(parents=True, exist_ok=True)
        _write_snapshot(d / f"{_hash_key(folder)}.md", rec)

    def record_sync_failure(self, account_id: str, folder: str, error: str) -> None:
        state = self.get_sync_state(account_id, folder) or {}
        self.update_sync_state(
            account_id=account_id, folder=folder,
            uidvalidity=int(state.get("uidvalidity", 0)), last_uid=int(state.get("last_uid", 0)),
            health_status="error", last_error=error,
            consecutive_failures=int(state.get("consecutive_failures", 0)) + 1,
        )

    def select_sender_account(self, *, enterprise_id, owner_open_id, account_id=None) -> dict:
        if account_id:
            account = self.get_account(account_id)
            if (account["enterprise_id"] != enterprise_id or not account["enabled"]
                    or not self.can_send(account_id=account_id, user_open_id=owner_open_id)):
                raise PermissionError("email account does not belong to this user and enterprise")
            return account
        accounts = []
        for a in self.list_accounts(enterprise_id=enterprise_id, enabled_only=True):
            if self.can_send(account_id=a["account_id"], user_open_id=owner_open_id):
                accounts.append(a)
        defaults = [a for a in accounts if a.get("is_default")]
        if len(defaults) == 1:
            return defaults[0]
        if len(accounts) == 1:
            return accounts[0]
        if not accounts:
            raise KeyError("no enabled email account for this user")
        raise ValueError("multiple email accounts available; account_id is required")

    # ── 邮件事实：outbound / inbound 快照 ──────────────────
    def _record_key(self, direction: str, message: dict) -> str:
        if direction == "outbound":
            local_id = message.get("local_message_id") or message.get("message_id") or ""
            return _hash_key(f"out|{message.get('account_id','')}|{local_id}|{message.get('created_at','')}")
        mid = message.get("message_id") or message.get("resend_received_id") or ""
        if mid:
            # 稳定 key：同 message_id 只落一个文件（可被 bind_reply_to_outbound 确定性定位）
            return _hash_key(f"in|{message.get('account_id','')}|{mid}")
        return _hash_key(f"in|{message.get('account_id','')}|{message.get('received_at') or message.get('created_at','')}")

    @staticmethod
    def _normalize(message: dict) -> dict:
        recipients = message.get("recipients")
        if isinstance(recipients, str):
            recipients = json.loads(recipients or "[]")
        if recipients is None:
            recipients = json.loads(message.get("recipients_json") or "[]")
        references = message.get("references")
        if isinstance(references, str):
            references = json.loads(references or "[]")
        if references is None:
            references = json.loads(message.get("references_json") or "[]")
        direction = message.get("direction", "outbound")
        base = {
            "schema_version": 1,
            "record_type": direction,
            "account_id": message.get("account_id", ""),
            "sender": message.get("sender", ""),
            "recipients": recipients,
            "subject": message.get("subject", ""),
            "text": message.get("text") or message.get("text_preview", "") or "",
            "html": message.get("html", "") or "",
            "company_id": message.get("company_id", ""),
            "campaign_id": message.get("campaign_id", ""),
            "lead_id": message.get("lead_id", ""),
            "contact_id": message.get("contact_id", ""),
            "created_at": message.get("created_at", utc_now()),
            "updated_at": message.get("updated_at", utc_now()),
        }
        if direction == "outbound":
            base.update({
                "local_message_id": message.get("local_message_id") or message.get("message_id", "") or "",
                "resend_id": message.get("resend_id", "") or "",
                # smtp_message_id：发送服务或 SMTP 上游分配的真实 RFC Message-ID，用于匹配 In-Reply-To/References。
                # 不是本地 make_msgid 生成的占位 ID；多供应商时再抽象为 provider_message_id（本轮不改字段名）。
                "smtp_message_id": message.get("smtp_message_id", "") or "",
                "thread_id": message.get("thread_id", "") or "",
                "sent_at": message.get("sent_at") or message.get("created_at", utc_now()),
                "status": message.get("status", "sent"),
                "provider_status": message.get("provider_status", "") or "",
                "failure_reason": message.get("failure_reason", "") or "",
                "idempotency_key": message.get("idempotency_key", "") or "",
                "touch_number": int(message.get("touch_number", 0)),
                "content_version": message.get("content_version", "") or "",
                "legacy": int(bool(message.get("legacy", False))),
            })
        else:
            base.update({
                "resend_received_id": message.get("resend_received_id") or message.get("resend_id", "") or "",
                "message_id": message.get("message_id", "") or "",
                "in_reply_to": message.get("in_reply_to", "") or "",
                "references": references,
                "thread_id": message.get("thread_id", "") or "",
                "binding_status": message.get("binding_status") or ("bound" if message.get("related") else "unmatched"),
                "failure_reason": message.get("failure_reason", "") or "",
                "received_at": message.get("received_at") or message.get("sent_at") or message.get("created_at", utc_now()),
            })
        return base

    def insert_message(self, message: dict, conn=None) -> bool:
        """写入 outbound/inbound 快照 + 索引。返回是否新写入（幂等）。"""
        direction = message.get("direction", "outbound")
        rec = self._normalize(message)
        # 公司号统一走 canonical：历史 slug 与当前 supplier_id 必须归一到同一个池，
        # 否则同一家企业会分裂成两套事实（客户看 A 表、系统写 B 表）。
        try:
            from enterprise_ids import canonical_company_id
            rec["company_id"] = canonical_company_id(rec.get("company_id", ""))
        except ImportError:
            pass
        company_id = rec.get("company_id", "") or ""
        ym = _ym(rec.get("sent_at") if direction == "outbound" else rec.get("received_at"))
        record_key = self._record_key(direction, message)
        path = self._company_dir(direction, company_id) / ym / f"{record_key}.md"

        # 幂等：已存在则不重复写
        if path.exists():
            return False

        rel = self._record_path(direction, company_id, ym, record_key)
        _write_snapshot(path, rec)

        # 建索引
        if direction == "outbound":
            rid = rec.get("resend_id", "")
            local_id = rec.get("local_message_id", "")
            smtp_mid = rec.get("smtp_message_id", "")
            idem = rec.get("idempotency_key", "")
            if rid:
                self._write_index("resend-id", rid, rel)
            if local_id:
                self._write_index("message-id", local_id, rel)
            if smtp_mid and smtp_mid != local_id:
                self._write_index("message-id", smtp_mid, rel)
            if idem:
                self._write_index("idempotency-key", idem, rel)
        return True

    def count_sent_today(self, account_id: str, tz: str | None = None) -> int:
        """今日已发送数（**按企业业务时区取日**，默认 Asia/Shanghai）。

        历史实现用 `utc_now()[:10]` 当本地日期，在 00:00–08:00 CST 会错位一天
        （v1 文档 §0「今日用 UTC 日」）。时区转换统一走 `email_metrics.facts.to_local_date`，
        不在本模块重写一套。
        """
        from email_metrics.config import resolve_report_timezone
        from email_metrics.facts import to_local_date
        zone = tz or resolve_report_timezone()
        day = to_local_date(utc_now(), zone)
        n = 0
        for rec in _list_snapshots(self._outbound):
            if rec.get("account_id") != account_id or rec.get("status") != "sent":
                continue
            if to_local_date(rec.get("created_at") or rec.get("sent_at"), zone) == day:
                n += 1
        return n

    # ── 查找 ──────────────────────────────────────────────
    def _find_outbound(self, account_id: str, match: Any) -> dict | None:
        for rec in _list_snapshots(self._outbound):
            if account_id and rec.get("account_id") != account_id:
                continue
            if match(rec):
                return rec
        return None

    def find_outbound_by_resend_id(self, resend_id: str) -> dict | None:
        if not resend_id:
            return None
        idx = self._read_index("resend-id", resend_id)
        if idx:
            p = self.root / idx["record_path"]
            rec = _read_snapshot(p)
            if rec:
                return rec
        # 兜底扫描
        return self._find_outbound("", lambda r: r.get("resend_id") == resend_id)

    def find_outbound_by_reference(self, account_id: str, reference_ids: list[str]) -> dict | None:
        for rid in reference_ids or []:
            idx = self._read_index("message-id", rid)
            if idx:
                p = self.root / idx["record_path"]
                rec = _read_snapshot(p)
                if rec and (not account_id or rec.get("account_id") == account_id):
                    return rec
        # 兜底扫描（message_id == reference）
        for rid in reference_ids or []:
            rec = self._find_outbound(account_id, lambda r, rid=rid: r.get("local_message_id") == rid)
            if rec:
                return rec
        # 兜底扫描（smtp_message_id == reference，买家 In-Reply-To 引用的是真实 SES/SMTP Message-ID）
        for rid in reference_ids or []:
            rec = self._find_outbound(account_id, lambda r, rid=rid: r.get("smtp_message_id") == rid)
            if rec:
                return rec
        return None

    def find_outbound_by_contact(self, account_id: str, buyer_email: str) -> dict | None:
        if not account_id or not buyer_email or "@" not in buyer_email:
            return None
        needle = buyer_email.strip().lower()
        for rec in _list_snapshots(self._outbound):
            if rec.get("account_id") != account_id:
                continue
            if any((r or "").strip().lower() == needle for r in rec.get("recipients", [])):
                return rec
        return None

    def find_outbounds_by_contact(self, account_id: str, buyer_email: str) -> list[dict]:
        """返回所有匹配该买家邮箱的 outbound（用于 P0-E4 联系人匹配歧义保护）。"""
        if not account_id or not buyer_email or "@" not in buyer_email:
            return []
        needle = buyer_email.strip().lower()
        out = []
        for rec in _list_snapshots(self._outbound):
            if rec.get("account_id") != account_id:
                continue
            if any((r or "").strip().lower() == needle for r in rec.get("recipients", [])):
                out.append(rec)
        return out

    def mark_bounced_by_contact(self, account_id: str, buyer_email: str,
                                category: str = "unknown") -> bool:
        """个人邮箱退信回写：按「账号+收件人」定位最近一封 outbound，标 bounced。"""
        matches = self.find_outbounds_by_contact(account_id, buyer_email)
        if not matches:
            return False
        target = max(matches, key=lambda r: (r.get("sent_at") or r.get("created_at") or ""))
        if target.get("provider_status") in _TERMINAL:
            return False
        rec = dict(target)
        rec["provider_status"] = "bounced"
        reason = (f"[{category}] bounced (IMAP NDR)" if category and category != "unknown"
                  else "bounced (IMAP NDR)")
        rec["failure_reason"] = reason[:500]
        rec["updated_at"] = utc_now()
        rel = self._locate_outbound_path(target)
        path = self.root / rel
        if not path.exists():
            key = self._record_key("outbound", {
                "account_id": target.get("account_id", ""),
                "local_message_id": target.get("local_message_id", ""),
                "created_at": target.get("created_at", ""),
            })
            ym = _ym(target.get("sent_at") or target.get("created_at"))
            rel = self._record_path("outbound", target.get("company_id", ""), ym, key)
            path = self.root / rel
        if not path.exists():
            return False
        with self._record_lock(f"bounce:{account_id}:{buyer_email.strip().lower()}"):
            _write_snapshot(path, rec)
            self._append_delivery_event(target.get("resend_id") or buyer_email,
                                        "bounced", rec["failure_reason"])
        return True

    def list_outbound_records(self, company_id: str = None) -> list[dict]:
        canonical = company_id
        try:
            from enterprise_ids import canonical_company_id
            canonical = canonical_company_id(company_id) if company_id else None
        except ImportError:
            canonical_company_id = lambda value: value  # noqa: E731
        out = []
        for rec in _list_snapshots(self._outbound):
            record_company = canonical_company_id(rec.get("company_id", ""))
            if canonical and record_company != canonical:
                continue
            out.append(rec)
        return out

    def list_inbound_records(self, company_id: str = None) -> list[dict]:
        canonical = company_id
        try:
            from enterprise_ids import canonical_company_id
            canonical = canonical_company_id(company_id) if company_id else None
        except ImportError:
            canonical_company_id = lambda value: value  # noqa: E731
        out = []
        for rec in _list_snapshots(self._inbound):
            record_company = canonical_company_id(rec.get("company_id", ""))
            if canonical and record_company != canonical:
                continue
            out.append(rec)
        return out

    def has_outbound_reference(self, account_id: str, message_ids: list[str]) -> bool:
        return self.find_outbound_by_reference(account_id, message_ids) is not None

    def has_idempotency_key(self, idempotency_key: str) -> bool:
        if not idempotency_key:
            return False
        idx = self._read_index("idempotency-key", idempotency_key)
        if idx:
            return True
        return self._find_outbound("", lambda r: r.get("idempotency_key") == idempotency_key) is not None

    # ── 状态更新 + delivery 事件 ──────────────────────────
    def update_provider_status(self, resend_id: str, status: str, failure_reason: str = "") -> bool:
        if not resend_id:
            return False
        with self._record_lock(f"provider:{resend_id}"):
            outbound = self.find_outbound_by_resend_id(resend_id)
            if outbound is None:
                return False
            current = outbound.get("provider_status", "")
            if status == current:
                return False
            if status == "delivered" and current in _TERMINAL:
                return False  # 迟到 delivered 不覆盖终态

            rec = dict(outbound)
            rec["provider_status"] = status
            rec["failure_reason"] = (failure_reason or "")[:500]
            rec["updated_at"] = utc_now()
            rel = self._locate_outbound_path(rec)
            path = self.root / rel
            _write_snapshot(path, rec)
            self._append_delivery_event(resend_id, status, (failure_reason or "")[:500])
            return True

    def backfill_smtp_message_id(self, resend_id: str, smtp_message_id: str) -> bool:
        """回填真实 SMTP/SES Message-ID。

        买家回复的 In-Reply-To 引用的是邮件服务商（SES/SMTP 服务器）真实分配的
        Message-ID，不是本地 make_msgid 生成的占位 ID；把它回填并重建 message-id 索引，
        供 find_outbound_by_reference 命中。幂等：值不变返回 False。
        """
        if not resend_id or not smtp_message_id:
            return False
        with self._record_lock(f"smtpmid:{resend_id}"):
            outbound = self.find_outbound_by_resend_id(resend_id)
            if outbound is None:
                return False
            if outbound.get("smtp_message_id") == smtp_message_id:
                return False
            rec = dict(outbound)
            rec["smtp_message_id"] = smtp_message_id
            rec["updated_at"] = utc_now()
            rel = self._locate_outbound_path(rec)
            path = self.root / rel
            _write_snapshot(path, rec)
            self._write_index("message-id", smtp_message_id, rel)
            return True

    def remove_outbound(self, resend_id: str) -> dict:
        """删除单条 outbound 快照 + 对应索引（仅清理验证伪记录，不删真实 delivery/reply 事件）。

        只删除该 outbound 的 resend-id / message-id（local + smtp）/ idempotency-key 索引；
        不动其他 outbound 与任何 delivery/reply/inbound 事件。
        """
        if not resend_id:
            return {"removed": False, "reason": "missing resend_id"}
        with self._record_lock(f"remove-outbound:{resend_id}"):
            outbound = self.find_outbound_by_resend_id(resend_id)
            if outbound is None:
                return {"removed": False, "reason": "not found"}
            rel = self._locate_outbound_path(outbound)
            snapshot_path = self.root / rel
            removed_indexes = []
            for kind, key in (
                ("resend-id", outbound.get("resend_id", "")),
                ("message-id", outbound.get("local_message_id", "")),
                ("message-id", outbound.get("smtp_message_id", "")),
                ("idempotency-key", outbound.get("idempotency_key", "")),
            ):
                if not key:
                    continue
                idx_path = self._index_path(kind, key)
                if idx_path.exists():
                    idx_path.unlink()
                    removed_indexes.append(f"{kind}:{key}")
            if snapshot_path.exists():
                snapshot_path.unlink()
            return {"removed": True, "snapshot": rel, "indexes_removed": removed_indexes}

    def _locate_outbound_path(self, rec: dict) -> str:
        company_id = rec.get("company_id", "") or "_unmatched"
        ym = _ym(rec.get("sent_at") or rec.get("created_at"))
        # 通过索引定位；失败则扫描
        for kind, key in (("resend-id", rec.get("resend_id", "")), ("message-id", rec.get("local_message_id", ""))):
            if key:
                idx = self._read_index(kind, key)
                if idx:
                    return idx["record_path"]
        return f"outbound/{company_id}/{ym}/unknown.md"

    def _append_delivery_event(self, resend_id: str, status: str, detail: str) -> None:
        day = _day(None)
        obj = {"event_id": uuid.uuid4().hex, "event_type": status, "resend_id": resend_id,
               "detail": detail, "created_at": utc_now()}
        _append_log(self._delivery / f"{day}.md", obj, self._locks)

    def bind_reply_to_outbound(self, *, account_id: str, inbound_message_id: str,
                               reference_ids: list[str]) -> dict | None:
        """找到原 outbound 并把身份写回 inbound 快照（记录级锁保护 read-modify-write）。"""
        outbound = self.find_outbound_by_reference(account_id, reference_ids)
        if outbound is None:
            return None
        if inbound_message_id:
            with self._record_lock(f"inbound:{account_id}:{inbound_message_id}"):
                path = self._find_inbound_path(account_id, inbound_message_id)
                if path:
                    rec = _read_snapshot(path)
                    if rec:
                        rec.update({
                            "thread_id": outbound.get("thread_id") or outbound.get("local_message_id", ""),
                            "company_id": outbound.get("company_id", ""),
                            "campaign_id": outbound.get("campaign_id", ""),
                            "lead_id": outbound.get("lead_id", ""),
                            "contact_id": outbound.get("contact_id", ""),
                            "binding_status": "bound",
                            "updated_at": utc_now(),
                        })
                        _write_snapshot(path, rec)
        return outbound

    def _find_inbound_path(self, account_id: str, message_id: str) -> Path | None:
        for p in self._inbound.rglob("*.md"):
            rec = _read_snapshot(p)
            if rec and rec.get("account_id") == account_id and rec.get("message_id") == message_id:
                return p
        return None

    # ── webhook 事件（svix-id 幂等 + claim）────────────────
    def _webhook_path(self, svix_id: str) -> Path:
        # by-id 是唯一事实源，svix-id 全局唯一，不含日期（跨日 replay 仍命中同一文件）
        return self._webhook / "by-id" / f"{_hash_key(svix_id)}.md"

    def _webhook_history_path(self) -> Path:
        return self._webhook / "history" / f"{_day(None)}.md"

    def _append_webhook_history(self, svix_id, event_type, email_id, status):
        _append_log(self._webhook_history_path(),
                    {"svix_id": svix_id, "event_type": event_type, "email_id": email_id,
                     "status": status, "received_at": utc_now()}, self._locks)

    def record_webhook_event(self, svix_id, event_type="", email_id="", event_created_at="",
                             webhook_received_at=None) -> bool:
        """幂等 claim：首次 O_CREAT|O_EXCL 成功返回 True；已存在返回 False。"""
        if not svix_id:
            return False
        path = self._webhook_path(svix_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        obj = {"schema_version": 1, "record_type": "webhook_event",
               "svix_id": svix_id, "event_type": event_type or "", "email_id": email_id or "",
               "event_created_at": event_created_at or "",
               "webhook_received_at": webhook_received_at or utc_now(),
               "processed_at": "", "status": "processing", "failure_reason": ""}
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            self._append_webhook_history(svix_id, event_type, email_id, "duplicate")
            return False
        content = SNAPSHOT_HEADER + "\n\n" + json.dumps(obj, ensure_ascii=False) + "\n"
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        self._append_webhook_history(svix_id, event_type, email_id, "received")
        return True

    def get_webhook_event(self, svix_id) -> dict | None:
        if not svix_id:
            return None
        return _read_snapshot(self._webhook_path(svix_id))

    def mark_webhook_event_processed(self, svix_id, status="processed", failure_reason="") -> None:
        if not svix_id:
            return
        with self._record_lock(f"webhook:{svix_id}"):
            path = self._webhook_path(svix_id)
            rec = _read_snapshot(path)
            if not rec:
                return
            rec["status"] = status
            rec["failure_reason"] = (failure_reason or "")[:500]
            rec["processed_at"] = utc_now()
            _write_snapshot(path, rec)
        self._append_webhook_history(svix_id, rec.get("event_type", ""), rec.get("email_id", ""), status)

    def claim_webhook_event(self, svix_id, event_type="", email_id="", event_created_at="",
                            timeout: int | None = None) -> str:
        """返回 claimed / reclaimed / retry / already_processed / busy。

        每次调用都会记 receipt（history）；已存在时 record_webhook_event 会标 duplicate。
        """
        if not svix_id:
            return "claimed"
        claimed = self.record_webhook_event(svix_id, event_type, email_id, event_created_at)
        if claimed:
            return "claimed"
        existing = _read_snapshot(self._webhook_path(svix_id))
        status = (existing or {}).get("status", "")
        if status == "processed":
            return "already_processed"
        if status == "failed":
            self._set_webhook_status(self._webhook_path(svix_id), "processing")
            return "retry"
        timeout = timeout if timeout is not None else _WEBHOOK_CLAIM_TIMEOUT
        received = (existing or {}).get("webhook_received_at", "")
        try:
            ts = datetime.fromisoformat(received).timestamp()
            if time.time() - ts > timeout:
                self._set_webhook_status(self._webhook_path(svix_id), "processing")
                return "reclaimed"
        except (ValueError, OSError):
            pass
        return "busy"

    def _set_webhook_status(self, path: Path, status: str) -> None:
        with self._record_lock(f"webhook:{path.stem}"):
            rec = _read_snapshot(path)
            if rec:
                rec["status"] = status
                rec["updated_at"] = utc_now()
                _write_snapshot(path, rec)

    # ── recovery ──────────────────────────────────────────
    def write_recovery_evidence(self, record: dict) -> None:
        """Resend 已收但本地持久化失败 → 追加恢复证据。"""
        _append_log(self._recovery / "outbound-recovery.md", record, self._locks)


# 保持对外类名稳定：上层业务继续 `from email_gateway.store import EmailStore`
EmailStore = MarkdownEmailStore
