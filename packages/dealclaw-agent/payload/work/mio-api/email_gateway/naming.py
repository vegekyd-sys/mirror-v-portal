"""DealClaw 默认邮箱命名服务（任务 T1）。
职责边界（只做命名与占位，不做 provisioning）：
- slug 规范化与校验（小写字母/数字/连字符，3–32，首尾字母或数字，无连续连字符）
- 取词优先级：英文品牌名 → 英文公司简称 → 拼音简称 → 拼音降级 → 通用兜底
- 保留词拒用（裸用被拒，走稳定短码兜底）"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

__all__ = [
    "MAIL_DOMAIN",
    "MIN_SLUG_LEN",
    "MAX_SLUG_LEN",
    "MIN_RETENTION_DAYS",
    "DEFAULT_RETENTION_DAYS",
    "RESERVED_WORDS",
    "EXTENDED_RESERVED_WORDS",
    "STATES",
    "ALLOWED_TRANSITIONS",
    "STATE_RESERVED",
    "STATE_ACTIVE",
    "STATE_RECEIVE_ONLY",
    "STATE_SUSPENDED",
    "SOURCE_BRAND",
    "SOURCE_SHORT",
    "SOURCE_PINYIN_GIVEN",
    "NamingError",
    "InvalidSlugError",
    "InvalidTransitionError",
    "AddressUnavailableError",
    "AddressRetiredError",
    "normalize_slug",
    "is_valid_slug",
    "is_reserved",
    "stable_short_code",
    "pinyin_abbr",
    "can_transition",
    "MailboxNamingStore",
]

MAIL_DOMAIN = "mail.dealclaw.io"

MIN_SLUG_LEN = 3
MAX_SLUG_LEN = 32

MIN_RETENTION_DAYS = 180
DEFAULT_RETENTION_DAYS = 180

# ── 状态机 ──────────────────────────────────────────────────

STATE_RESERVED = "reserved"
STATE_ACTIVE = "active"
STATE_RECEIVE_ONLY = "receive_only"
STATE_SUSPENDED = "suspended"

STATES = frozenset({STATE_RESERVED, STATE_ACTIVE, STATE_RECEIVE_ONLY, STATE_SUSPENDED})

#: 合法状态迁移。同状态迁移视为非法（调用方应视为 no-op 并跳过）。
#: ``receive_only → active`` 仅对「临时停发」成立；被替换退休（tombstone）的地址
#: 永远是 receive_only/suspended，见 ``MailboxNamingStore.transition``。
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    STATE_RESERVED: frozenset({STATE_ACTIVE, STATE_SUSPENDED}),
    STATE_ACTIVE: frozenset({STATE_RECEIVE_ONLY, STATE_SUSPENDED}),
    STATE_RECEIVE_ONLY: frozenset({STATE_ACTIVE, STATE_SUSPENDED}),
    STATE_SUSPENDED: frozenset({STATE_ACTIVE, STATE_RECEIVE_ONLY}),
}

# ── 取词来源标签 ────────────────────────────────────────────

SOURCE_BRAND = "brand_name_en"
SOURCE_SHORT = "short_name_en"
#: 拼音取词（含公司名派生与通用兜底，2026-09-15 收敛：不再细分来源标签）
SOURCE_PINYIN_GIVEN = "pinyin_abbr"

# ── 保留词 ──────────────────────────────────────────────────
#: 需求明确要求的必需保留词。
RESERVED_WORDS = frozenset({
    "admin", "support", "billing", "abuse", "postmaster", "noreply",
    "sales", "security", "root",
})

#: 扩展保留词：基础设施/角色地址，不应作为任何租户的默认邮箱裸用。
#: 这份集合刻意与必需集分开，产品侧要收窄时只改这里。
EXTENDED_RESERVED_WORDS = frozenset({
    "no-reply", "mail", "mailer", "hostmaster", "webmaster", "daemon",
    "info", "help", "contact", "jobs", "legal", "privacy", "dmarc",
    "bounce", "bounces", "feedback", "tracking", "verify", "account",
    "accounts", "www", "api", "ftp", "dns", "test", "office", "team",
})

_RESERVED_ALL = RESERVED_WORDS | EXTENDED_RESERVED_WORDS


class NamingError(Exception):
    """命名服务基类异常。"""


class InvalidSlugError(NamingError):
    """slug 不符合规则。"""


class InvalidTransitionError(NamingError):
    """非法状态迁移（含已退休地址恢复发信）。"""


class AddressUnavailableError(NamingError):
    """所有候选地址（含兜底短码）都已占用或不可分配。"""


class AddressRetiredError(NamingError):
    """地址已被 tombstone，永久禁止重新分配给任何租户。"""


# ── slug 规则 ───────────────────────────────────────────────

_SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
_NON_SLUG_RUN = re.compile(r"[^a-z0-9]+")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_dt(value: datetime | str | None) -> datetime:
    """把 ``at`` 参数统一成 aware UTC datetime。"""
    if value is None:
        return _utcnow()
    if isinstance(value, datetime):
        dt = value
    else:
        dt = datetime.fromisoformat(str(value))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iso(value: datetime | str | None) -> str:
    return _as_dt(value).isoformat()


def is_valid_slug(slug: Any) -> bool:
    """严格校验（不做任何自动修补）。"""
    if not isinstance(slug, str):
        return False
    if len(slug) < MIN_SLUG_LEN or len(slug) > MAX_SLUG_LEN:
        return False
    if "--" in slug:
        return False
    return bool(_SLUG_RE.match(slug))


def _loose_slug(raw: Any) -> str:
    """宽容规范化：折叠非 [a-z0-9] 为连字符、去首尾连字符、截断到 32。"""
    if raw is None:
        return ""
    text = str(raw).strip().lower()
    text = _NON_SLUG_RUN.sub("-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    if len(text) > MAX_SLUG_LEN:
        text = text[:MAX_SLUG_LEN].strip("-")
    return text


def normalize_slug(raw: Any) -> str:
    """规范化；无法得到合法 slug 时返回空字符串（例如纯中文、长度不足）。"""
    slug = _loose_slug(raw)
    return slug if is_valid_slug(slug) else ""


def is_reserved(slug: Any) -> bool:
    """是否为保留词（大小写不敏感，按裸词判定）。"""
    return str(slug or "").strip().lower() in _RESERVED_ALL


def can_transition(current: str, target: str) -> bool:
    """状态机查询（不含「已退休」这一额外守卫，见 ``transition``）。"""
    if current not in STATES or target not in STATES or current == target:
        return False
    return target in ALLOWED_TRANSITIONS[current]


# ── 稳定短码 ────────────────────────────────────────────────

#: 排除易混淆字符（i l o 0 1），与需求示例 ``suntech-7k3`` 一致。
_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_CODE_LEN = 3


def stable_short_code(seed: str, attempt: int = 0) -> str:
    """稳定短码：同一 ``(seed, attempt)`` 永远得到同一结果（可复现）。"""
    for extra in range(64):
        digest = hashlib.sha256(f"{seed}|{attempt}|{extra}".encode("utf-8")).digest()
        code = "".join(_CODE_ALPHABET[b % len(_CODE_ALPHABET)] for b in digest[:_CODE_LEN])
        if any(ch.isdigit() for ch in code):
            return code
    raise NamingError("unable to derive a short code containing a digit")  # pragma: no cover


# ── 拼音降级 ────────────────────────────────────────────────

#: 公司法务后缀，取缩写前剔除（避免 ``yyxgs`` 这类无信息量结果）。
_LEGAL_SUFFIX_RE = re.compile(
    r"(股份有限公司|有限责任公司|集团有限公司|有限公司|集团|公司|厂)$"
)

#: 内置常用字首字母表（降级用，非权威，覆盖企业名高频字）。
#: 安装 ``pypinyin`` 后自动优先使用其完整覆盖。
_BUILTIN_INITIALS: dict[str, str] = {
    "深": "s", "圳": "z", "市": "s", "辉": "h", "洋": "y", "科": "k", "技": "j",
    "有": "y", "限": "x", "公": "g", "司": "s", "贸": "m", "易": "y", "进": "j",
    "出": "c", "口": "k", "集": "j", "团": "t", "股": "g", "份": "f", "实": "s",
    "业": "y", "发": "f", "展": "z", "投": "t", "资": "z", "咨": "z", "询": "x",
    "服": "f", "务": "w", "生": "s", "物": "w", "新": "x", "材": "c", "料": "l",
    "能": "n", "电": "d", "子": "z", "机": "j", "械": "x", "设": "s", "备": "b",
    "工": "g", "程": "c", "建": "j", "筑": "z", "家": "j", "具": "j", "纺": "f",
    "织": "z", "装": "z", "食": "s", "品": "p", "农": "n", "化": "h", "医": "y",
    "药": "y", "汽": "q", "车": "c", "五": "w", "金": "j", "塑": "s", "胶": "j",
    "包": "b", "印": "y", "刷": "s", "纸": "z", "木": "m", "石": "s", "玻": "b",
    "璃": "l", "陶": "t", "瓷": "c", "钢": "g", "铁": "t", "铝": "l", "铜": "t",
    "制": "z", "造": "z", "龙": "l", "腾": "t", "飞": "f", "鸿": "h", "鹏": "p",
    "邦": "b", "达": "d", "通": "t", "泰": "t", "鑫": "x", "盛": "s", "隆": "l",
    "兴": "x", "源": "y", "恒": "h", "昌": "c", "润": "r", "泽": "z", "富": "f",
    "远": "y", "光": "g", "云": "y", "软": "r", "件": "j", "硬": "y", "网": "w",
    "络": "l", "信": "x", "息": "x", "数": "s", "据": "j", "智": "z", "慧": "h",
    "中": "z", "国": "g", "华": "h", "东": "d", "南": "n", "西": "x", "北": "b",
    "京": "j", "上": "s", "海": "h", "广": "g", "州": "z", "杭": "h", "苏": "s",
    "浙": "z", "江": "j", "安": "a", "徽": "h", "福": "f", "湖": "h", "河": "h",
    "天": "t", "津": "j", "重": "c", "庆": "q", "山": "s", "陕": "s", "甘": "g",
    "青": "q", "宁": "n", "疆": "j", "台": "t", "香": "x", "港": "g", "澳": "a",
    "门": "m", "亚": "y", "欧": "o", "米": "m", "奥": "a", "兰": "l", "特": "t",
    "际": "j", "展": "z", "贸": "m", "易": "y",
}


def _strip_legal_suffix(text: str) -> str:
    out = text.strip()
    for _ in range(4):  # 最多剥 4 层，``有限公司`` 之类
        stripped = _LEGAL_SUFFIX_RE.sub("", out).strip()
        if stripped == out or not stripped:
            break
        out = stripped
    return out


def _try_pypinyin():
    """已安装 ``pypinyin`` 时返回模块，否则 None（本环境默认未安装）。"""
    try:  # pragma: no cover - 取决于环境
        import pypinyin  # type: ignore
    except Exception:
        return None
    return pypinyin


def _trim_letters(text: str) -> str:
    return text[:MAX_SLUG_LEN]


def pinyin_abbr(text: Any, *, module: Any = None) -> str:
    """中文/混合文本 → 拼音首字母缩写（小写字母数字）。"""
    if not text:
        return ""
    body = _strip_legal_suffix(str(text))
    if not body:
        return ""

    pyp = _try_pypinyin() if module is None else module
    if pyp is not None:  # pragma: no cover - 环境未安装 pypinyin
        try:
            parts: list[str] = []
            for ch in body:
                if ch.isascii() and ch.isalnum():
                    parts.append(ch.lower())
                elif ch.isascii():
                    continue
                else:
                    parts.append("".join(pyp.lazy_pinyin(
                        ch, style=pyp.Style.FIRST_LETTER, errors="ignore")))
            result = _trim_letters("".join(parts))
            if result:
                return result
        except Exception:
            pass  # 任何 API 差异都静默降级到内置表

    out: list[str] = []
    for ch in body:
        if ch.isascii() and ch.isalnum():
            out.append(ch.lower())
        elif ch.isascii():
            continue
        initial = _BUILTIN_INITIALS.get(ch)
        if initial:
            out.append(initial)
    return _trim_letters("".join(out))


# ── 候选生成 ────────────────────────────────────────────────

def _candidate_bases(*, enterprise_id: str, brand_name_en: str = "",
                     short_name_en: str = "", pinyin_abbr_hint: str = "",
                     company_name: str = "") -> list[tuple[str, str]]:
    """按优先级返回 ``[(原始取词文本, 来源标签), ...]``（去重保序）。"""
    out: list[tuple[str, str]] = []

    def push(raw: Any, source: str) -> None:
        text = str(raw or "").strip()
        if not text:
            return
        if any(text == existing for existing, _ in out):
            return
        out.append((text, source))

    push(brand_name_en, SOURCE_BRAND)
    push(short_name_en, SOURCE_SHORT)
    push(pinyin_abbr_hint, SOURCE_PINYIN_GIVEN)
    if company_name:
        push(pinyin_abbr(company_name), SOURCE_PINYIN_GIVEN)
    push(f"co{stable_short_code(enterprise_id)}", SOURCE_PINYIN_GIVEN)
    return out


def _join_short_code(base: str, code: str) -> str:
    """``base`` + ``-`` + ``code``；超长时截断 base（不产生尾连字符）。"""
    if not base:
        return ""
    full = f"{base}-{code}"
    if len(full) > MAX_SLUG_LEN:
        room = MAX_SLUG_LEN - len(code) - 1
        base = base[:room].rstrip("-") if room > 0 else ""
        if not base:
            return ""
        full = f"{base}-{code}"
    return full if is_valid_slug(full) else ""


def _default_data_dir() -> Path:
    default = Path(__file__).resolve().parent.parent / "data"
    return Path(os.environ.get("DC_DATA_DIR", str(default)))


# ── 存储 ────────────────────────────────────────────────────

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS mailbox_address (
        address            TEXT PRIMARY KEY,
        full_address       TEXT NOT NULL,
        enterprise_id      TEXT NOT NULL,
        owner_open_id      TEXT,
        status             TEXT NOT NULL,
        is_current         INTEGER NOT NULL DEFAULT 1,
        base_slug          TEXT NOT NULL DEFAULT '',
        source             TEXT NOT NULL DEFAULT '',
        suffixed           INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        activated_at       TEXT,
        retired_at         TEXT,
        receive_only_until TEXT,
        status_reason      TEXT NOT NULL DEFAULT '',
        replace_count      INTEGER NOT NULL DEFAULT 0
    )
    """,
    # 需求指定的 DB 级唯一索引：唯一占位不靠应用层先查后写。
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_mailbox_address_address ON mailbox_address(address)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_mailbox_address_full ON mailbox_address(full_address)",
    # 一个企业同时只能有一个当前默认地址（并发下的第二道保险）。
    ("CREATE UNIQUE INDEX IF NOT EXISTS ux_mailbox_current_per_enterprise "
     "ON mailbox_address(enterprise_id) WHERE is_current = 1"),
    """
    CREATE TABLE IF NOT EXISTS address_tombstone (
        address            TEXT PRIMARY KEY,
        full_address       TEXT NOT NULL,
        enterprise_id      TEXT NOT NULL,
        retired_at         TEXT NOT NULL,
        receive_only_until TEXT NOT NULL,
        reason             TEXT NOT NULL DEFAULT ''
    )
    """,
)

_TX_RETRIES = 8
_BUSY_TIMEOUT_MS = 15000

_COLUMNS = (
    "address", "full_address", "enterprise_id", "owner_open_id", "status",
    "is_current", "base_slug", "source", "suffixed", "created_at", "updated_at",
    "activated_at", "retired_at", "receive_only_until", "status_reason",
    "replace_count",
)


def _record_view(row: sqlite3.Row | dict, *, idempotent: bool = False,
                 tombstoned: bool = False) -> dict:
    """对外统一返回结构（T2 provisioning 直接消费）。"""
    return {
        "address": row["address"],
        "email": row["full_address"],
        "domain": MAIL_DOMAIN,
        "enterprise_id": row["enterprise_id"],
        "owner_open_id": row["owner_open_id"],
        "status": row["status"],
        "is_current": bool(row["is_current"]),
        "is_tombstoned": bool(tombstoned),
        "base_slug": row["base_slug"],
        "source": row["source"],
        "suffixed": bool(row["suffixed"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "activated_at": row["activated_at"],
        "retired_at": row["retired_at"],
        "receive_only_until": row["receive_only_until"],
        "status_reason": row["status_reason"],
        "replace_count": row["replace_count"],
        "idempotent": bool(idempotent),
        "can_send": row["status"] == STATE_ACTIVE and row["retired_at"] is None,
        "can_receive": _receives(row["status"], row["receive_only_until"], _utcnow()),
    }


def _receives(status: str, until: str | None, now: datetime) -> bool:
    if status == STATE_ACTIVE:
        return True
    if status == STATE_RECEIVE_ONLY:
        if not until:
            return True
        return _as_dt(until) >= now
    return False


class MailboxNamingStore:
    """默认邮箱命名与占位。"""

    def __init__(self, data_dir: str | Path | None = None, *,
                 db_path: str | Path | None = None,
                 default_retention_days: int = DEFAULT_RETENTION_DAYS):
        if db_path is not None:
            self.db_path = Path(db_path)
            self.data_dir = self.db_path.parent
        else:
            self.data_dir = Path(data_dir) if data_dir else _default_data_dir()
            self.db_path = self.data_dir / "email-facts" / "naming" / "addresses.sqlite3"
        if default_retention_days < MIN_RETENTION_DAYS:
            raise ValueError(f"retention must be >= {MIN_RETENTION_DAYS} days")
        self.default_retention_days = default_retention_days
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.ensure_schema()

    # ── 连接 / 事务 ─────────────────────────────────────────
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=_BUSY_TIMEOUT_MS / 1000.0,
                               isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
        return conn

    def ensure_schema(self) -> None:
        """幂等建表/建索引。"""
        conn = self._connect()
        try:
            for attempt in range(_TX_RETRIES):
                try:
                    conn.execute("PRAGMA journal_mode = WAL")
                    for stmt in _SCHEMA:
                        conn.execute(stmt)
                    return
                except sqlite3.OperationalError as exc:
                    if "locked" not in str(exc).lower() or attempt == _TX_RETRIES - 1:
                        raise
                    time.sleep(0.05 * (attempt + 1))
        finally:
            conn.close()

    @contextmanager
    def _write_tx(self) -> Iterator[sqlite3.Connection]:
        """写事务：``BEGIN IMMEDIATE`` 串行化「读-判断-写」，避免先查后写的竞态。"""
        conn = self._connect()
        started = False
        try:
            for attempt in range(_TX_RETRIES):
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    started = True
                    break
                except sqlite3.OperationalError as exc:
                    if "locked" not in str(exc).lower() or attempt == _TX_RETRIES - 1:
                        raise
                    time.sleep(0.05 * (attempt + 1))
            yield conn
            if started:
                conn.execute("COMMIT")
        except Exception:
            if started:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
            raise
        finally:
            conn.close()

    def _query(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        conn = self._connect()
        try:
            return list(conn.execute(sql, args).fetchall())
        finally:
            conn.close()

    # ── 基础查询 ────────────────────────────────────────────
    def _row(self, conn: sqlite3.Connection, address: str) -> sqlite3.Row | None:
        return conn.execute(
            "SELECT * FROM mailbox_address WHERE address = ?", (address,)).fetchone()

    def _current_row(self, conn: sqlite3.Connection, enterprise_id: str) -> sqlite3.Row | None:
        return conn.execute(
            "SELECT * FROM mailbox_address WHERE enterprise_id = ? AND is_current = 1 "
            "ORDER BY created_at DESC LIMIT 1", (enterprise_id,)).fetchone()

    def _is_tombstoned(self, conn: sqlite3.Connection, address: str) -> bool:
        row = conn.execute(
            "SELECT 1 FROM address_tombstone WHERE address = ?", (address,)).fetchone()
        return row is not None

    def get_address(self, address: str) -> dict | None:
        """按本地部分查询单条记录（含 tombstone 标记）。"""
        rows = self._query("SELECT * FROM mailbox_address WHERE address = ?", (address,))
        if not rows:
            return None
        tomb = self._query("SELECT 1 FROM address_tombstone WHERE address = ?", (address,))
        return _record_view(rows[0], tombstoned=bool(tomb))

    def get_current_address(self, enterprise_id: str) -> dict | None:
        """幂等查询入口：企业当前默认邮箱（无则 None）。"""
        if not enterprise_id:
            return None
        rows = self._query(
            "SELECT * FROM mailbox_address WHERE enterprise_id = ? AND is_current = 1 "
            "ORDER BY created_at DESC LIMIT 1", (enterprise_id,))
        return _record_view(rows[0]) if rows else None

    def list_addresses(self, *, enterprise_id: str | None = None,
                       status: str | None = None) -> list[dict]:
        sql = "SELECT * FROM mailbox_address WHERE 1 = 1"
        args: list[Any] = []
        if enterprise_id:
            sql += " AND enterprise_id = ?"
            args.append(enterprise_id)
        if status:
            sql += " AND status = ?"
            args.append(status)
        sql += " ORDER BY created_at ASC"
        return [_record_view(r) for r in self._query(sql, tuple(args))]

    def list_tombstones(self) -> list[dict]:
        return [dict(r) for r in self._query(
            "SELECT * FROM address_tombstone ORDER BY retired_at ASC")]

    def is_tombstoned(self, address: str) -> bool:
        return bool(self._query(
            "SELECT 1 FROM address_tombstone WHERE address = ?", (address,)))

    def is_allocatable(self, address: str) -> bool:
        """是否有资格被分配：未被 tombstone 且未占用过。"""
        if self.is_tombstoned(address):
            return False
        return not self._query(
            "SELECT 1 FROM mailbox_address WHERE address = ?", (address,))

    # ── 占位 ────────────────────────────────────────────────
    def _insert(self, conn: sqlite3.Connection, *, address: str, base: str,
                source: str, suffixed: bool, enterprise_id: str,
                owner_open_id: str | None, now: str,
                status: str = STATE_RESERVED) -> sqlite3.Row | None:
        """插入占位；唯一索引冲突返回 None（并发下让调用方换下一个候选）。"""
        try:
            conn.execute(
                "INSERT INTO mailbox_address (address, full_address, enterprise_id,"
                " owner_open_id, status, is_current, base_slug, source, suffixed,"
                " created_at, updated_at, status_reason)"
                " VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, '')",
                (address, f"{address}@{MAIL_DOMAIN}", enterprise_id, owner_open_id,
                 status, base, source, 1 if suffixed else 0, now, now))
        except sqlite3.IntegrityError:
            return None
        return self._row(conn, address)

    def _allocate_in_conn(self, conn: sqlite3.Connection, *, enterprise_id: str,
                          owner_open_id: str | None, bases: list[tuple[str, str]],
                          now: str, max_attempts: int,
                          intended_status: str = STATE_RESERVED) -> dict:
        """在同一事务内挑一个可用地址占位。失败抛 AddressUnavailableError。"""
        tried: list[str] = []

        for raw, source in bases:
            base = _loose_slug(raw)
            if not base:
                continue

            # ① 裸用：合法 slug 且非保留词
            if not is_reserved(base) and is_valid_slug(base) and self.is_allocatable(base):
                row = self._insert(conn, address=base, base=base, source=source,
                                   suffixed=False, enterprise_id=enterprise_id,
                                   owner_open_id=owner_open_id, now=now,
                                   status=intended_status)
                if row is not None:
                    return _record_view(row)
                tried.append(base)

            # ② 稳定短码兜底（同企业同候选可复现）
            for attempt in range(max_attempts):
                code = stable_short_code(f"{enterprise_id}|{base}", attempt)
                candidate = _join_short_code(base, code)
                if not candidate or is_reserved(candidate):
                    continue
                if not self.is_allocatable(candidate):
                    tried.append(candidate)
                    continue
                row = self._insert(conn, address=candidate, base=base, source=source,
                                   suffixed=True, enterprise_id=enterprise_id,
                                   owner_open_id=owner_open_id, now=now,
                                   status=intended_status)
                if row is not None:
                    return _record_view(row)
                tried.append(candidate)

        raise AddressUnavailableError(
            f"no allocatable address for enterprise {enterprise_id!r}; tried={tried[:12]}")

    def reserve_default_mailbox(self, *, enterprise_id: str, brand_name_en: str = "",
                                short_name_en: str = "", pinyin_abbr: str = "",
                                company_name: str = "", owner_open_id: str | None = None,
                                at: datetime | str | None = None,
                                max_attempts: int = 8) -> dict:
        """为企业预留默认邮箱；已存在则**幂等返回原地址**。"""
        if not enterprise_id:
            raise NamingError("enterprise_id is required")
        now = _iso(at)
        bases = _candidate_bases(
            enterprise_id=enterprise_id, brand_name_en=brand_name_en,
            short_name_en=short_name_en, pinyin_abbr_hint=pinyin_abbr,
            company_name=company_name)
        with self._write_tx() as conn:
            existing = self._current_row(conn, enterprise_id)
            if existing is not None:
                return _record_view(existing, idempotent=True)
            return self._allocate_in_conn(
                conn, enterprise_id=enterprise_id, owner_open_id=owner_open_id,
                bases=bases, now=now, max_attempts=max_attempts)

    def replace_default_mailbox(self, *, enterprise_id: str, brand_name_en: str = "",
                                short_name_en: str = "", pinyin_abbr: str = "",
                                company_name: str = "", owner_open_id: str | None = None,
                                at: datetime | str | None = None,
                                retention_days: int | None = None,
                                reason: str = "replaced_default",
                                max_attempts: int = 8) -> dict:
        """替换默认邮箱（同一事务内）：旧地址立即停发 + receive_only + tombstone。"""
        if not enterprise_id:
            raise NamingError("enterprise_id is required")
        days = self.default_retention_days if retention_days is None else retention_days
        if days < MIN_RETENTION_DAYS:
            raise ValueError(f"retention must be >= {MIN_RETENTION_DAYS} days")
        now_dt = _as_dt(at)
        now = now_dt.isoformat()
        bases = _candidate_bases(
            enterprise_id=enterprise_id, brand_name_en=brand_name_en,
            short_name_en=short_name_en, pinyin_abbr_hint=pinyin_abbr,
            company_name=company_name)
        with self._write_tx() as conn:
            previous: dict | None = None
            existing = self._current_row(conn, enterprise_id)
            if existing is not None:
                previous = self._retire_in_conn(
                    conn, existing, now_dt=now_dt, days=days, reason=reason)
                conn.execute(
                    "UPDATE mailbox_address SET replace_count = replace_count + 1"
                    " WHERE enterprise_id = ?", (enterprise_id,))
            view = self._allocate_in_conn(
                conn, enterprise_id=enterprise_id, owner_open_id=owner_open_id,
                bases=bases, now=now, max_attempts=max_attempts)
            view["previous"] = previous
            view["replaced"] = previous is not None
            return view

    # ── 状态迁移 ────────────────────────────────────────────
    def _apply_transition(self, conn: sqlite3.Connection, row: sqlite3.Row, target: str,
                          *, now: str, reason: str = "") -> dict:
        current = row["status"]
        address = row["address"]
        if target not in STATES:
            raise NamingError(f"unknown target status {target!r}")
        if target == current:
            raise InvalidTransitionError(f"{address}: already in status {current!r}")
        if not can_transition(current, target):
            raise InvalidTransitionError(f"{address}: {current} -> {target} is not allowed")
        if target == STATE_ACTIVE and self._is_tombstoned(conn, address):
            raise InvalidTransitionError(
                f"{address}: retired address can never send again (tombstone)")
        fields = ["status = ?", "updated_at = ?", "status_reason = ?"]
        args: list[Any] = [target, now, reason]
        if target == STATE_ACTIVE and not row["activated_at"]:
            fields.append("activated_at = ?")
            args.append(now)
        args.append(address)
        conn.execute(f"UPDATE mailbox_address SET {', '.join(fields)} WHERE address = ?",
                     tuple(args))
        return _record_view(self._row(conn, address),
                            tombstoned=self._is_tombstoned(conn, address))

    def transition(self, address: str, target: str, *,
                   at: datetime | str | None = None, reason: str = "") -> dict:
        """通用状态迁移（非法路径抛 InvalidTransitionError）。"""
        now = _iso(at)
        with self._write_tx() as conn:
            row = self._row(conn, address)
            if row is None:
                raise NamingError(f"unknown address {address!r}")
            return self._apply_transition(conn, row, target, now=now, reason=reason)

    def activate(self, address: str, *, at=None, reason: str = "activated") -> dict:
        return self.transition(address, STATE_ACTIVE, at=at, reason=reason)

    def suspend(self, address: str, *, at=None, reason: str = "suspended") -> dict:
        return self.transition(address, STATE_SUSPENDED, at=at, reason=reason)

    def resume(self, address: str, *, at=None, reason: str = "resumed") -> dict:
        return self.transition(address, STATE_ACTIVE, at=at, reason=reason)

    def set_receive_only(self, address: str, *, at=None,
                         reason: str = "manual_receive_only") -> dict:
        """临时停发（非退休）：不写 tombstone、不设保留期。"""
        return self.transition(address, STATE_RECEIVE_ONLY, at=at, reason=reason)

    # ── 退休 / tombstone ────────────────────────────────────
    def _retire_in_conn(self, conn: sqlite3.Connection, row: sqlite3.Row, *,
                        now_dt: datetime, days: int, reason: str) -> dict:
        address = row["address"]
        if row["retired_at"] or self._is_tombstoned(conn, address):
            raise InvalidTransitionError(f"{address}: already retired")
        if row["status"] not in (STATE_RESERVED, STATE_ACTIVE, STATE_RECEIVE_ONLY):
            raise InvalidTransitionError(
                f"{address}: cannot retire from status {row['status']!r}")
        now = now_dt.isoformat()
        until = (now_dt + timedelta(days=days)).isoformat()
        conn.execute(
            "UPDATE mailbox_address SET status = ?, is_current = 0, retired_at = ?,"
            " receive_only_until = ?, updated_at = ?, status_reason = ?"
            " WHERE address = ?",
            (STATE_RECEIVE_ONLY, now, until, now, reason, address))
        conn.execute(
            "INSERT OR IGNORE INTO address_tombstone"
            " (address, full_address, enterprise_id, retired_at, receive_only_until, reason)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (address, row["full_address"], row["enterprise_id"], now, until, reason))
        return _record_view(self._row(conn, address), tombstoned=True)

    def retire(self, address: str, *, at=None, retention_days: int | None = None,
               reason: str = "retired") -> dict:
        """退休单个地址：立即停发 + ≥180 天收信 + 永久 tombstone。"""
        days = self.default_retention_days if retention_days is None else retention_days
        if days < MIN_RETENTION_DAYS:
            raise ValueError(f"retention must be >= {MIN_RETENTION_DAYS} days")
        now_dt = _as_dt(at)
        with self._write_tx() as conn:
            row = self._row(conn, address)
            if row is None:
                raise NamingError(f"unknown address {address!r}")
            return self._retire_in_conn(conn, row, now_dt=now_dt, days=days, reason=reason)

    def enforce_retention(self, *, at=None) -> dict:
        """把超过收信保留期的 receive_only 地址停用（→ suspended）。"""
        now_dt = _as_dt(at)
        now = now_dt.isoformat()
        expired: list[str] = []
        with self._write_tx() as conn:
            rows = conn.execute(
                "SELECT * FROM mailbox_address WHERE status = ?",
                (STATE_RECEIVE_ONLY,)).fetchall()
            for row in rows:
                until = row["receive_only_until"]
                if until and _as_dt(until) < now_dt and can_transition(
                        STATE_RECEIVE_ONLY, STATE_SUSPENDED):
                    conn.execute(
                        "UPDATE mailbox_address SET status = ?, updated_at = ?,"
                        " status_reason = ? WHERE address = ?",
                        (STATE_SUSPENDED, now, "retention_expired", row["address"]))
                    expired.append(row["address"])
        return {"expired": expired, "count": len(expired)}

    # ── 收发能力判定 ────────────────────────────────────────
    def can_send(self, address: str, *, at=None) -> bool:
        """只有 active 且未被退休的地址可以发信（receive_only/suspended 立即停发）。"""
        rows = self._query("SELECT * FROM mailbox_address WHERE address = ?", (address,))
        if not rows:
            return False
        row = rows[0]
        return row["status"] == STATE_ACTIVE and not row["retired_at"]

    def can_receive(self, address: str, *, at=None) -> bool:
        """receive_only 在保留期内仍可收信；过期/停用/未激活均不可。"""
        now_dt = _as_dt(at)
        rows = self._query("SELECT * FROM mailbox_address WHERE address = ?", (address,))
        if not rows:
            return False
        row = rows[0]
        return _receives(row["status"], row["receive_only_until"], now_dt)
