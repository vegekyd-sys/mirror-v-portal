"""DealClaw 默认邮箱 provisioning（任务 T2）。

职责边界
--------
只做「懒创建 + 发信就绪判定」，不调用邮件 Provider、不发信、不起后台服务：

- ``ensure_mailbox``     幂等懒创建默认邮箱：命名占位 → account 记录 → 通知目标绑定
- ``mailbox_readiness``  发信就绪判定（收信路由 + 通知目标 + 发件身份）
- ``check_send_ready``   发信前置闸门（不抛异常，返回结构化结论）
- ``assert_send_ready``  发信前置闸门（未就绪抛 ``SendNotReadyError``）

约定
----
- 地址计算**完全复用** ``naming.py``（T1）：本模块不重写 slug 规则、保留词、
  稳定短码、状态机与 tombstone 逻辑。
- account / binding 落库**完全复用** ``store.py`` 既有表结构与调用约定，
  不新增表、不改既有表结构、不改既有函数签名。
- 仅标准库；不改 k8s / 部署配置 / 密钥 / 生产数据。

地址优先级
----------
调用方传入的 ``slug`` 视为「已解析的短名」，作为取词第一优先级（``brand_name_en``
槽位）交给 ``naming.py``。它仍是**偏好**不是强制：命中保留词或已被占用时，由
``naming.py`` 按稳定短码兜底（``suntech-7k3``），与 T1 行为一致。

错误码（``ProvisionError.code``，供 skill / 智能体判定）
-------------------------------------------------------
``invalid_input`` / ``invalid_slug`` / ``address_unavailable`` /
``account_conflict`` / ``owner_missing`` / ``send_gate_not_ready`` /
``internal_error``

发信就绪（``send_ready``）的三项判定
-----------------------------------
- ``routing_ready``  收信路由：地址有命名记录 + 企业匹配 + 可收信 + account 存在且启用
- ``notify_ready``   通知目标：account 上存在 ``notify_enabled`` 且目标为 ``oc_``/``ou_`` 的绑定
- ``naming_ready``   发件身份：命名状态为 ``active``（``reserved`` = 只占位未激活）

三项全绿才 ``send_ready``。未就绪时闸门**拒绝发送并说明原因**，不产生假成功。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .naming import (
    MAIL_DOMAIN,
    STATE_ACTIVE,
    STATE_RESERVED,
    AddressUnavailableError as _NamingAddressUnavailableError,
    MailboxNamingStore,
    NamingError,
    is_valid_slug,
    normalize_slug,
)
from .store import EmailStore

__all__ = [
    "DEFAULT_MAILBOX_PROVIDER",
    "DEFAULT_MAILBOX_KIND",
    "DEFAULT_SECRET_REF",
    "DEFAULT_DAILY_SEND_LIMIT",
    "GATE_MODE_ENV",
    "GATE_MODES",
    "NOTIFY_PREFIXES",
    "EXIT_OK",
    "EXIT_ERROR",
    "EXIT_NOT_READY",
    "ProvisionError",
    "InvalidInputError",
    "InvalidSlugInputError",
    "MailboxUnavailableError",
    "OwnerMissingError",
    "SendNotReadyError",
    "resolve_tenant_id",
    "resolve_owner_open_id",
    "canonical_address",
    "local_part",
    "engine_ready",
    "mailbox_readiness",
    "ensure_mailbox",
    "try_ensure_mailbox",
    "check_send_ready",
    "assert_send_ready",
    "gate_mode",
    "gate_blocked_result",
]

#: DealClaw 默认邮箱走 Resend（API 发信 + webhook 收信），见 PRD 九/十一。
DEFAULT_MAILBOX_PROVIDER = "resend"
#: ``dealclaw_proxy`` = DealClaw 托管的代理/收信邮箱（store.py 既有枚举值）。
DEFAULT_MAILBOX_KIND = "dealclaw_proxy"
#: 只存引用名，不存密钥本身（secrets.py 的 ``env:NAME`` 约定）。
DEFAULT_SECRET_REF = "env:RESEND_API_KEY"
#: Free 每日额度（PRD 8.1）。真正的额度扣减不在 T2 范围内。
DEFAULT_DAILY_SEND_LIMIT = 30

#: 闸门模式：``enforce``（默认，拒绝）/ ``warn``（放行但标注）/ ``off``（不判定）。
GATE_MODE_ENV = "DC_MAILBOX_GATE"
GATE_MODES = ("enforce", "warn", "off")

#: 通知目标前缀：``oc_`` 群 / ``ou_`` 用户 DM（与 dc_send_receipt.push_receipt 一致）。
NOTIFY_PREFIXES = ("oc_", "ou_")

#: CLI 退出码约定：0 就绪 / 1 参数或内部错误 / 3 未就绪（闸门拒绝）。
EXIT_OK = 0
EXIT_ERROR = 1
EXIT_NOT_READY = 3

#: 一次 ensure 内并发保护的锁名（复用 store 的 flock 机制）。
_PROVISION_LOCK_PREFIX = "mailbox-provision"


# ── 异常 / 错误码 ────────────────────────────────────────────
class ProvisionError(Exception):
    """默认邮箱 provisioning 错误基类。``code`` 供上层 skill 判定分支。"""

    code = "provision_error"

    def __init__(self, message: str, *, code: str = "", **detail: Any):
        super().__init__(message)
        if code:
            self.code = code
        self.detail: dict[str, Any] = detail

    def as_dict(self) -> dict:
        out = {"ok": False, "code": self.code, "error": str(self)}
        out.update(self.detail)
        return out


class InvalidInputError(ProvisionError):
    code = "invalid_input"


class InvalidSlugInputError(ProvisionError):
    code = "invalid_slug"


class MailboxUnavailableError(ProvisionError):
    code = "address_unavailable"


class OwnerMissingError(ProvisionError):
    code = "owner_missing"


class SendNotReadyError(ProvisionError):
    """发信前置闸门未通过（拒绝发送）。"""

    code = "send_gate_not_ready"

    def __init__(self, message: str, *, blockers: Any = (), reasons: Any = (),
                 **detail: Any):
        super().__init__(message, blockers=list(blockers), reasons=list(reasons), **detail)


def _blocked(*codes_reasons: tuple[str, str]) -> tuple[list[str], list[str]]:
    return [code for code, _ in codes_reasons], [reason for _, reason in codes_reasons]


# ── 租户 / owner / 地址解析 ──────────────────────────────────
def resolve_tenant_id(explicit: str = "") -> str:
    """租户主键解析：显式参数 → ``MIO_CDP_SUPPLIER_ID`` → ``DC_ENTERPRISE_ID``。

    口径与 ``enterprise_ids.py``（唯一权威主键 = 当前租户 supplier_id）一致；
    全部为空时返回空串，调用方必须视为「无法判定」而不是猜一个值。
    """
    for candidate in (explicit,
                      os.environ.get("MIO_CDP_SUPPLIER_ID", ""),
                      os.environ.get("DC_ENTERPRISE_ID", "")):
        value = str(candidate or "").strip()
        if value:
            return value
    return ""


def resolve_owner_open_id(explicit: str = "") -> str:
    """邮箱归属人解析：显式参数 → ``DC_MAILBOX_OWNER_OPEN_ID`` → ``MIO_V_OPEN_ID``。

    解析不到时返回空串：地址仍可占位，但 account 记录不落（不伪造归属人）。
    """
    for candidate in (explicit,
                      os.environ.get("DC_MAILBOX_OWNER_OPEN_ID", ""),
                      os.environ.get("MIO_V_OPEN_ID", "")):
        value = str(candidate or "").strip()
        if value:
            return value
    return ""


def local_part(address: str) -> str:
    """从 ``V <v@mail.dealclaw.io>`` / ``v@mail.dealclaw.io`` / ``v`` 取本地部分。"""
    addr = str(address or "").strip()
    if "<" in addr and ">" in addr:
        addr = addr[addr.rfind("<") + 1:addr.rfind(">")]
    addr = addr.strip().strip("<>").strip()
    return addr.split("@", 1)[0].strip().lower() if "@" in addr else addr.lower()


def canonical_address(address: str) -> str:
    """规范化为小写 ``local@domain``；无 ``@`` 时补 ``MAIL_DOMAIN``。"""
    addr = str(address or "").strip()
    if "<" in addr and ">" in addr:
        addr = addr[addr.rfind("<") + 1:addr.rfind(">")]
    addr = addr.strip().strip("<>").strip().lower()
    if not addr:
        return ""
    return addr if "@" in addr else f"{addr}@{MAIL_DOMAIN}"


def gate_mode(explicit: str = "") -> str:
    """闸门模式：显式参数 → ``DC_MAILBOX_GATE`` → ``enforce``（未知值按 enforce）。"""
    value = str(explicit or os.environ.get(GATE_MODE_ENV, "") or "").strip().lower()
    return value if value in GATE_MODES else "enforce"


def engine_ready(data_dir: str | os.PathLike | None = None) -> bool:
    """默认邮箱引擎是否可用（数据目录可建）。失败静默返回 False，供接线层判定。"""
    try:
        MailboxNamingStore(data_dir=data_dir)
        return True
    except Exception:  # noqa: BLE001
        return False


# ── 内部：引擎与落库 ────────────────────────────────────────
def _naming(data_dir=None) -> MailboxNamingStore:
    return MailboxNamingStore(data_dir=data_dir)


def _store(data_dir=None) -> EmailStore:
    return EmailStore(data_dir=data_dir)


def _find_account(store: EmailStore, *, enterprise_id: str, email: str) -> dict | None:
    target = email.strip().lower()
    for account in store.list_accounts(enterprise_id=enterprise_id):
        if str(account.get("email_address", "")).strip().lower() == target:
            return account
    return None


def _ensure_account(store: EmailStore, *, enterprise_id: str, email: str,
                    owner_open_id: str) -> tuple[dict | None, bool]:
    """幂等确保 account 记录存在。返回 ``(account, created)``；无归属人返回 ``(None, False)``。

    并发：唯一地址已由 naming 的唯一索引保证，这里再用 store 既有的 flock
    （``_record_lock``，按 ``enterprise_id`` 串行）保护「查-插」，避免同一邮箱
    落下两条 account 记录。
    """
    existing = _find_account(store, enterprise_id=enterprise_id, email=email)
    if existing is not None:
        return existing, False
    if not owner_open_id:
        return None, False

    with store._record_lock(f"{_PROVISION_LOCK_PREFIX}|{enterprise_id}"):
        existing = _find_account(store, enterprise_id=enterprise_id, email=email)
        if existing is not None:
            return existing, False
        # 只有该租户此前没有任何 account 时才置 is_default，避免抢走既有默认发件身份。
        first_account = not store.list_accounts(enterprise_id=enterprise_id)
        try:
            account = store.add_account(
                enterprise_id=enterprise_id,
                owner_open_id=owner_open_id,
                email_address=email,
                provider=DEFAULT_MAILBOX_PROVIDER,
                secret_ref=DEFAULT_SECRET_REF,
                mailbox_kind=DEFAULT_MAILBOX_KIND,
                auth_type="api_key",
                display_name="",
                is_default=first_account,
                daily_send_limit=DEFAULT_DAILY_SEND_LIMIT,
            )
        except ValueError:
            # 并发下另一方已插入同地址 → 复用，不制造第二条记录
            account = _find_account(store, enterprise_id=enterprise_id, email=email)
            if account is None:
                raise
            return account, False
    return account, True


def _notify_bindings(store: EmailStore, account_id: str) -> list[dict]:
    return [b for b in store.list_bindings()
            if b.get("account_id") == account_id and b.get("notify_enabled")
            and str(b.get("chat_id", "")).startswith(NOTIFY_PREFIXES)]


def _ensure_notify_binding(store: EmailStore, *, account_id: str, target: str) -> dict | None:
    """按用户显式给定的目标落一条通知绑定（复用 store.bind_group）。

    不传目标时不落任何绑定：PRD 3.1 要求「邮箱归属和通知位置分离」，
    不能在群里顺手把全部回信永久绑到该群。
    """
    value = str(target or "").strip()
    if not value:
        return None
    if not value.startswith(NOTIFY_PREFIXES):
        raise InvalidInputError(
            f"notify_target must start with {' or '.join(NOTIFY_PREFIXES)}",
            code="invalid_input", notify_target=value)
    return store.bind_group(account_id=account_id, chat_id=value,
                            inbound_filter="dealclaw_replies", notify_enabled=True)


# ── 就绪判定 ────────────────────────────────────────────────
def mailbox_readiness(*, enterprise_id: str = "", address: str = "",
                      data_dir=None) -> dict:
    """判定某租户默认邮箱的发信就绪度（只读，不抛异常）。

    ``address`` 为空时取该租户当前默认地址。
    """
    eid = resolve_tenant_id(enterprise_id)
    result: dict[str, Any] = {
        "enterprise_id": eid,
        "address": local_part(address) if address else "",
        "email": canonical_address(address) if address else "",
        "domain": MAIL_DOMAIN,
        "naming_status": "",
        "account_id": "",
        "account_enabled": False,
        "account_kind": "",
        "notify_target": "",
        "naming_ready": False,
        "routing_ready": False,
        "notify_ready": False,
        "send_ready": False,
        "blockers": [],
        "reasons": [],
    }
    if not eid:
        result["blockers"], result["reasons"] = _blocked(
            ("invalid_input", "无法确定租户主键（enterprise_id）"))
        return result

    try:
        naming = _naming(data_dir)
        store = _store(data_dir)
    except Exception as exc:  # noqa: BLE001
        result["blockers"], result["reasons"] = _blocked(
            ("internal_error", f"邮箱存储不可用：{type(exc).__name__}: {exc}"))
        return result

    # ① 命名记录（按显式地址优先，否则取该租户当前地址）
    view = None
    if result["address"]:
        view = naming.get_address(result["address"])
    if view is None:
        view = naming.get_current_address(eid)

    pairs: list[tuple[str, str]] = []
    if view is None:
        pairs.append(("naming_missing", "该租户还没有默认邮箱地址（未预留）"))
    elif str(view.get("enterprise_id", "")) != eid:
        pairs.append(("naming_enterprise_mismatch",
                      f"地址 {view.get('address')} 不属于租户 {eid}"))
        view = None

    if view is not None:
        result["address"] = view["address"]
        result["email"] = view["email"]
        result["naming_status"] = view["status"]
        result["naming_ready"] = bool(view["can_send"])
        if view.get("is_tombstoned"):
            pairs.append(("naming_tombstoned",
                          f"地址 {view['address']} 已退休，永久不可再发信"))
        elif view["status"] == STATE_RESERVED:
            pairs.append(("naming_not_active",
                          f"地址 {view['address']} 仍是 reserved（只占位未激活发件身份）"))
        elif view["status"] != STATE_ACTIVE:
            pairs.append(("naming_not_active",
                          f"地址 {view['address']} 状态为 {view['status']}，不可发信"))
        if not view["can_receive"]:
            pairs.append(("naming_not_receivable",
                          f"地址 {view['address']} 当前不可收信，回信会丢失"))

    # ② account 记录（发件身份）
    account = None
    if result["email"]:
        try:
            account = _find_account(store, enterprise_id=eid, email=result["email"])
        except Exception as exc:  # noqa: BLE001
            pairs.append(("internal_error",
                          f"account 读取失败：{type(exc).__name__}: {exc}"))
    if account is None:
        pairs.append(("account_missing",
                      "该地址还没有 account 记录（发件身份未落地）"))
    else:
        result["account_id"] = str(account.get("account_id", ""))
        result["account_enabled"] = bool(account.get("enabled"))
        result["account_kind"] = str(account.get("mailbox_kind", ""))
        if not result["account_enabled"]:
            pairs.append(("account_disabled",
                          f"account {result['account_id']} 已停用"))

    # ③ 通知目标（回信往哪里通知）
    if result["account_id"]:
        bindings = _notify_bindings(store, result["account_id"])
        if bindings:
            result["notify_target"] = str(bindings[0].get("chat_id", ""))
            result["notify_ready"] = True
        else:
            pairs.append(("notify_missing",
                          "该邮箱没有通知目标（回信无处通知）"))

    result["blockers"] = [code for code, _ in pairs]
    result["reasons"] = [reason for _, reason in pairs]
    result["routing_ready"] = bool(
        view is not None and view["can_receive"] and result["account_enabled"])
    result["send_ready"] = not pairs
    return result


# ── 懒创建 ──────────────────────────────────────────────────
def ensure_mailbox(enterprise_id: str = "", *, company_name: str = "",
                   brand_name_en: str = "", short_name_en: str = "",
                   pinyin_abbr: str = "", slug: str = "",
                   owner_open_id: str = "", notify_target: str = "",
                   activate: bool = False, data_dir=None, at=None,
                   max_attempts: int = 8) -> dict:
    """幂等懒创建租户默认邮箱，返回该租户的默认邮箱地址与就绪度。

    参数
    ----
    enterprise_id  租户主键（空则回退 env，见 ``resolve_tenant_id``）
    company_name   公司名（用于拼音降级取词）
    brand_name_en / short_name_en / pinyin_abbr  命名取词（交给 ``naming.py``）
    slug           已解析的短名，作为取词第一优先级；仍受保留词/占用兜底
    owner_open_id  邮箱归属人（空则回退 env，见 ``resolve_owner_open_id``）
    notify_target  通知目标 ``oc_``群 / ``ou_``DM；显式传入才落绑定
    activate       True 且地址为 ``reserved`` 时激活发件身份（``active``）
    at             测试用固定时间戳

    返回
    ----
    dict：``ok`` / ``enterprise_id`` / ``address`` / ``email`` / ``status`` /
    ``created``（本次是否新建占位）/ ``idempotent``（命中已有占位）/
    ``account_id`` / ``account_created`` / ``notify_target`` / ``activated`` /
    ``send_ready`` / ``routing_ready`` / ``notify_ready`` / ``blockers`` / ``reasons``

    异常
    ----
    ``InvalidInputError`` / ``InvalidSlugInputError`` / ``MailboxUnavailableError``
    / ``NamingError``（naming 层错误原样抛出）。接线层请用 ``try_ensure_mailbox``。
    """
    eid = resolve_tenant_id(enterprise_id)
    if not eid:
        raise InvalidInputError(
            "enterprise_id is required（或配置 MIO_CDP_SUPPLIER_ID）",
            code="invalid_input", enterprise_id="")

    owner = resolve_owner_open_id(owner_open_id)
    # 通知目标在校验阶段就拒绝，避免写完占位/account 再失败留下半截状态。
    if notify_target and not str(notify_target).strip().startswith(NOTIFY_PREFIXES):
        raise InvalidInputError(
            f"notify_target must start with {' or '.join(NOTIFY_PREFIXES)}",
            code="invalid_input", notify_target=str(notify_target))
    preferred_slug = ""
    if slug:
        preferred_slug = normalize_slug(slug)
        if not preferred_slug:
            raise InvalidSlugInputError(
                f"slug {slug!r} is not a valid address slug (3-32, [a-z0-9-])",
                code="invalid_slug", slug=str(slug))

    # 调用方给的已解析 slug 走第一优先级取词槽位；不重写 naming 的 slug 规则。
    brand = preferred_slug or brand_name_en

    naming = _naming(data_dir)

    # 旧地址已退休（无 current）时**不自动铸造新地址**：PRD 5.3 要求重新生成
    # 只由用户明确提出，企业改名/重试不得造成地址 churn 与 tombstone 污染。
    history = naming.list_addresses(enterprise_id=eid)
    if history and not any(row["is_current"] for row in history):
        retired = sorted(history, key=lambda r: r["created_at"])[-1]
        readiness = mailbox_readiness(enterprise_id=eid, address=retired["address"],
                                      data_dir=data_dir)
        return {
            "ok": True,
            "enterprise_id": eid,
            "address": retired["address"],
            "email": retired["email"],
            "domain": retired["domain"],
            "status": retired["status"],
            "created": False,
            "idempotent": True,
            "source": retired.get("source", ""),
            "suffixed": bool(retired.get("suffixed")),
            "activated": False,
            "needs_replace": True,
            "owner_open_id": owner,
            "account_id": readiness["account_id"],
            "account_created": False,
            "notify_target": readiness["notify_target"],
            "send_ready": False,
            "routing_ready": readiness["routing_ready"],
            "notify_ready": readiness["notify_ready"],
            "naming_ready": False,
            "blockers": ["mailbox_retired", *readiness["blockers"]],
            "reasons": ["旧地址已退休：重新生成默认邮箱必须由用户明确发起"
                        "（replace_default_mailbox），不得静默换地址", *readiness["reasons"]],
        }

    try:
        view = naming.reserve_default_mailbox(
            enterprise_id=eid, brand_name_en=brand, short_name_en=short_name_en,
            pinyin_abbr=pinyin_abbr, company_name=company_name,
            owner_open_id=owner or None, at=at, max_attempts=max_attempts)
    except _NamingAddressUnavailableError as exc:
        raise MailboxUnavailableError(
            str(exc), code="address_unavailable", enterprise_id=eid) from exc

    created = not bool(view.get("idempotent"))

    # 发件身份激活：只允许 reserved → active；已退休/停用地址绝不悄悄复活。
    activated = False
    if activate and view["status"] == STATE_RESERVED:
        view = naming.activate(view["address"], at=at, reason="ensure_mailbox")
        activated = True

    store = _store(data_dir)
    try:
        account, account_created = _ensure_account(
            store, enterprise_id=eid, email=view["email"], owner_open_id=owner)
    except Exception as exc:
        raise ProvisionError(
            f"account 记录落库失败：{type(exc).__name__}: {exc}",
            code="account_conflict", enterprise_id=eid,
            email=view["email"]) from exc

    bound = None
    if account is not None and notify_target:
        bound = _ensure_notify_binding(
            store, account_id=str(account["account_id"]), target=notify_target)

    readiness = mailbox_readiness(enterprise_id=eid, address=view["address"],
                                  data_dir=data_dir)
    result: dict[str, Any] = {
        "ok": True,
        "enterprise_id": eid,
        "address": view["address"],
        "email": view["email"],
        "domain": view["domain"],
        "status": view["status"],
        "created": created,
        "idempotent": not created,
        "source": view.get("source", ""),
        "suffixed": bool(view.get("suffixed")),
        "activated": activated,
        "needs_replace": False,
        "owner_open_id": owner,
        "account_id": str(account["account_id"]) if account else "",
        "account_created": account_created,
        "notify_target": str(bound.get("chat_id", "")) if bound else "",
        "send_ready": readiness["send_ready"],
        "routing_ready": readiness["routing_ready"],
        "notify_ready": readiness["notify_ready"],
        "naming_ready": readiness["naming_ready"],
        "blockers": readiness["blockers"],
        "reasons": readiness["reasons"],
    }
    return result


def try_ensure_mailbox(enterprise_id: str = "", **kwargs: Any) -> dict:
    """``ensure_mailbox`` 的不抛异常版本，供接线层（线索落池等）调用。

    失败不改变调用方行为，只返回 ``{"ok": False, "code": ..., "error": ...}``。
    """
    try:
        return ensure_mailbox(enterprise_id, **kwargs)
    except ProvisionError as exc:
        out = exc.as_dict()
        out.setdefault("enterprise_id", resolve_tenant_id(enterprise_id))
        return out
    except NamingError as exc:
        return {"ok": False, "code": "address_unavailable",
                "error": f"{type(exc).__name__}: {exc}",
                "enterprise_id": resolve_tenant_id(enterprise_id)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "code": "internal_error",
                "error": f"{type(exc).__name__}: {exc}",
                "enterprise_id": resolve_tenant_id(enterprise_id)}


# ── 发信前置闸门 ────────────────────────────────────────────
def _naming_db_path(data_dir=None) -> Path:
    """命名库路径（与 ``MailboxNamingStore`` 的布局一致），用于「不存在就不读」。"""
    base = (Path(data_dir) if data_dir
            else Path(os.environ.get("DC_DATA_DIR", "")
                      or (Path(__file__).resolve().parent.parent / "data")))
    return base / "email-facts" / "naming" / "addresses.sqlite3"


def _gate_applies(*, email: str, data_dir=None) -> bool:
    """闸门是否适用于这个发件地址。

    只覆盖**经命名服务（T1/T2）预留过的 DealClaw 默认邮箱**：T2 的懒创建一定先落
    命名占位，所以默认邮箱流程 100% 覆盖；任何未经命名服务的历史邮箱、自有邮箱
    （包括其它 ``mail.dealclaw.io`` 地址）一律 ``applicable=False``，既有发信行为不变。

    命名库文件不存在时直接返回 False，不做任何建库副作用。
    """
    if not email:
        return False
    if not _naming_db_path(data_dir).exists():
        return False
    try:
        return _naming(data_dir).get_address(local_part(email)) is not None
    except Exception:  # noqa: BLE001
        return False


def check_send_ready(*, enterprise_id: str = "", from_address: str = "",
                     data_dir=None, mode: str = "") -> dict:
    """发信前置闸门（不抛异常）。返回 ``allowed`` 布尔与未就绪原因。

    - ``applicable=False``：该地址不归命名服务管（未经 T1/T2 预留的邮箱，含自有邮箱）
      → 放行，既有行为不变
    - ``applicable=True`` 且 ``allowed=False``：拒绝发送，``blockers`` 给出原因
    - ``mode``：``enforce``（默认）/``warn``/``off``，可用 ``DC_MAILBOX_GATE`` 覆盖
    """
    resolved_mode = gate_mode(mode)
    eid = resolve_tenant_id(enterprise_id)
    email = canonical_address(from_address)
    result: dict[str, Any] = {
        "ok": True,
        "mode": resolved_mode,
        "applicable": False,
        "allowed": True,
        "enterprise_id": eid,
        "email": email,
        "blockers": [],
        "reasons": [],
    }
    if resolved_mode == "off" or not email:
        result["reason"] = "gate_disabled" if resolved_mode == "off" else "no_address"
        return result

    result["applicable"] = _gate_applies(email=email, data_dir=data_dir)
    if not result["applicable"]:
        result["reason"] = "not_a_dealclaw_default_mailbox"
        return result

    readiness = mailbox_readiness(enterprise_id=eid, address=email, data_dir=data_dir)
    result["readiness"] = readiness
    result["address"] = readiness["address"]
    result["blockers"] = readiness["blockers"]
    result["reasons"] = readiness["reasons"]
    result["allowed"] = bool(readiness["send_ready"]) or resolved_mode == "warn"
    if not readiness["send_ready"]:
        result["ok"] = resolved_mode != "enforce"
        result["reason"] = "; ".join(readiness["reasons"]) or "send_not_ready"
    return result


def assert_send_ready(**kwargs: Any) -> dict:
    """``check_send_ready`` 的抛异常版本：未就绪抛 ``SendNotReadyError``。"""
    gate = check_send_ready(**kwargs)
    if not gate["allowed"]:
        raise SendNotReadyError(
            "默认邮箱未就绪，已拒绝发送：" + ("；".join(gate["reasons"]) or gate.get("reason", "")),
            blockers=gate["blockers"], reasons=gate["reasons"],
            enterprise_id=gate.get("enterprise_id", ""), email=gate.get("email", ""))
    return gate


def gate_blocked_result(gate: dict, *, error_prefix: str = "默认邮箱未就绪，拒绝发送") -> dict:
    """统一构造「被闸门拒绝」的调用方返回体（不含任何假成功字段）。"""
    reason = "；".join(gate.get("reasons") or []) or gate.get("reason", "send_not_ready")
    return {
        "success": False,
        "sent": False,
        "count": 0,
        "error": f"{error_prefix}：{reason}",
        "code": "send_gate_not_ready",
        "blockers": list(gate.get("blockers") or []),
        "gate": gate,
    }
