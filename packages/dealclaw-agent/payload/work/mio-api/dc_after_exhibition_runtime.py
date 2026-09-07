#!/usr/bin/env python3
# -- coding: UTF-8 --
"""dc_after_exhibition_runtime.py — 展后买家推荐运行时（调度 Worker）

职责（与纯函数层 dc_after_exhibition_push.py 分离）：
  1. 查询需要检查的已结束 / 闭展日展会
  2. 读取展会级配置（展会 meta > 企业/租户 > DEFAULT_CONFIG）
  3. 获取持久化调度锁（lease，pending → sending → sent/failed）
  4. 调用 should_send 判断时机 + 幂等 + 数据就绪 + 静默
  5. 检查数据同步 watermark
  6. 生成推荐 / 提醒
  7. 发送（自动推送用 delivery_key 作为幂等键；manual 用独立命名空间）
  8. 发送成功后记录 sent
  9. 释放锁并输出脱敏运行摘要

并发安全：
  - 同一 delivery_key 同时只能有一个 worker 获得 lease（lease_owner + lease_expires_at）
  - worker 崩溃后 lease 到期可重试
  - 只有消息发送成功且获得 message_id 后才标 sent
  - 失败采用指数退避重试，设置最大重试次数
  - 不允许因为记录状态失败而重复发送已成功的消息（发送层以 delivery_key 幂等兜底）

脱敏：摘要只输出 exhibition_id / push_type / 计数 / 状态，不输出买家姓名、邮箱、电话、会议全文。

生产默认 enabled=False；真实数据联调完成前不开启推送。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    import fcntl
except ImportError:  # 非 POSIX（如测试环境）降级为无锁
    fcntl = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_after_exhibition_push import (  # noqa: E402
    DEFAULT_CONFIG,
    decide_push_type,
    delivery_key,
    is_data_ready,
    manual_delivery_key,
    resolve_config,
    resolve_timezone,
    scheduled_local_date,
    should_send,
)
from dc_after_exhibition_recommend import recommend  # noqa: E402

LEASE_TTL_SECONDS = 300          # lease 有效期：worker 崩溃后 5 分钟可被接管
MAX_ATTEMPTS = 5                 # 最大重试次数（失败退避）
BACKOFF_BASE_SECONDS = 60        # 退避基数：60s、120s、240s、480s ...

PENDING = "pending"
SENDING = "sending"
SENT = "sent"
FAILED = "failed"

_AUTO_TRIGGER = "auto"
_MANUAL_TRIGGER = "manual"


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────
# 配置读取（文件层）
# ─────────────────────────────────────────────────────────────

def tenant_config_path(supplier_id: str) -> Path:
    return _workspace_root() / "data" / "memory" / str(supplier_id) / "after-exhibition-config.json"


def load_tenant_config(supplier_id: str) -> dict:
    """读取企业/租户配置（data/memory/<sid>/after-exhibition-config.json），缺失返回 {}。"""
    p = tenant_config_path(supplier_id)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def load_exhibition_config(exhibition: dict) -> dict:
    """读取展会 meta 配置：优先 exhibition.after_exhibition 子对象，其次 exhibition 顶层直挂字段。"""
    exh = exhibition or {}
    nested = exh.get("after_exhibition") or exh.get("after_exhibition_config") or {}
    if isinstance(nested, dict) and nested:
        return nested
    # 顶层直挂的已知字段也视为展会级配置
    return {k: exh[k] for k in DEFAULT_CONFIG if k in exh}


def resolve_effective_config(exhibition: dict, supplier_id: str = "") -> tuple[dict, list[str], str, list[str]]:
    """解析生效配置 + 时区。返回 (config, errors, tz_name, warnings)。"""
    tenant_cfg = load_tenant_config(supplier_id) if supplier_id else {}
    exh_cfg = load_exhibition_config(exhibition)
    config, errors = resolve_config(exh_cfg, tenant_cfg)
    tz, warnings = resolve_timezone(exhibition, tenant_cfg, config)
    return config, errors, tz, warnings


# ─────────────────────────────────────────────────────────────
# 持久化调度状态（lease）
# ─────────────────────────────────────────────────────────────

class DeliveryStateStore:
    """按 delivery_key 持久化发送状态 + lease（并发安全）。

    状态机：pending → sending → sent；sending → failed →（退避）→ sending。
    文件锁（fcntl.flock）+ 原子写（tmp+replace）保证同机多进程安全；
    lease（lease_owner + lease_expires_at）保证崩溃后到期可重试。
    """

    def __init__(self, path: Path):
        self.path = path
        self._lock_path = path.with_suffix(path.suffix + ".lock")

    # -- 底层读写（原子） --

    def _read(self) -> dict:
        if not self.path.exists():
            return {"deliveries": {}}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {"deliveries": {}}
        if not isinstance(data, dict) or not isinstance(data.get("deliveries"), dict):
            return {"deliveries": {}}
        return data

    def _write(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def _locked(self):
        """文件锁上下文；非 POSIX 环境降级为无操作（测试）。"""
        class _NoLock:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        if fcntl is None:
            return _NoLock()

        class _FLock:
            def __init__(self, path):
                self.fh = None
                self.path = path

            def __enter__(self):
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.fh = open(self.path, "a")
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX)
                return self

            def __exit__(self, *a):
                if self.fh:
                    fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
                    self.fh.close()

        return _FLock(self._lock_path)

    # -- 状态查询 --

    def get(self, key: str) -> dict:
        data = self._read()
        return data["deliveries"].get(key) or {}

    def is_sent(self, key: str) -> bool:
        rec = self.get(key)
        return rec.get("status") == SENT

    def list_all(self) -> dict:
        return self._read()["deliveries"]

    # -- lease 获取 --

    def acquire_lease(self, key: str, owner: str, now: datetime,
                      lease_ttl: int = LEASE_TTL_SECONDS) -> dict:
        """尝试获取 lease。返回 {acquired, status, reason}。

        - 无记录 → sending + lease → acquired
        - sent → 拒绝（already_sent）
        - sending 且 lease 未到期 → 拒绝（lease_held）
        - sending 且 lease 到期 → 接管（lease_recovered）
        - failed → 按退避/最大次数判断是否重试（retry / backoff / max_attempts）
        - pending → sending + lease → acquired
        """
        with self._locked():
            data = self._read()
            rec = data["deliveries"].get(key)

            if rec is None:
                rec = self._new_record(key, _AUTO_TRIGGER)
                data["deliveries"][key] = rec
            status = rec.get("status", PENDING)

            if status == SENT:
                return {"acquired": False, "status": SENT, "reason": "already_sent"}
            if status == SENDING:
                expires = self._parse_time(rec.get("lease_expires_at"))
                if expires and expires > now:
                    return {"acquired": False, "status": SENDING, "reason": "lease_held"}
                # lease 到期 → 接管重试
                rec["attempts"] = int(rec.get("attempts", 0)) + 1
                rec["lease_owner"] = owner
                rec["lease_expires_at"] = _iso(now + timedelta(seconds=lease_ttl))
                rec["status"] = SENDING
                data["deliveries"][key] = rec
                self._write(data)
                return {"acquired": True, "status": SENDING, "reason": "lease_recovered",
                        "attempts": rec["attempts"]}
            if status == FAILED:
                attempts = int(rec.get("attempts", 0))
                if attempts >= MAX_ATTEMPTS:
                    return {"acquired": False, "status": FAILED, "reason": "max_attempts"}
                next_retry = self._parse_time(rec.get("next_retry_at"))
                if next_retry and next_retry > now:
                    return {"acquired": False, "status": FAILED, "reason": "backoff"}
                rec["attempts"] = attempts + 1
                rec["lease_owner"] = owner
                rec["lease_expires_at"] = _iso(now + timedelta(seconds=lease_ttl))
                rec["status"] = SENDING
                data["deliveries"][key] = rec
                self._write(data)
                return {"acquired": True, "status": SENDING, "reason": "retry",
                        "attempts": rec["attempts"]}

            # pending → sending
            rec["lease_owner"] = owner
            rec["lease_expires_at"] = _iso(now + timedelta(seconds=lease_ttl))
            rec["status"] = SENDING
            data["deliveries"][key] = rec
            self._write(data)
            return {"acquired": True, "status": SENDING, "reason": "acquired"}

    # -- 状态落库 --

    def mark_sent(self, key: str, owner: str, message_id: str, *,
                  recommendation_version: str = "", content_hash: str = "",
                  revision: int = 1, trigger_source: str = _AUTO_TRIGGER,
                  sent_at: datetime = None) -> dict:
        """标记 sent。仅当 lease_owner == owner 且 status == sending 时生效。"""
        sent_at = sent_at or _now_utc()
        with self._locked():
            data = self._read()
            rec = data["deliveries"].get(key)
            if not rec or rec.get("status") != SENDING or rec.get("lease_owner") != owner:
                return {"ok": False, "reason": "lease_not_owned"}
            rec["status"] = SENT
            rec["message_id"] = message_id
            rec["sent_at"] = _iso(sent_at)
            rec["recommendation_version"] = recommendation_version
            rec["content_hash"] = content_hash
            rec["revision"] = revision
            rec["trigger_source"] = trigger_source
            rec["lease_owner"] = None
            rec["lease_expires_at"] = None
            data["deliveries"][key] = rec
            self._write(data)
            return {"ok": True, "reason": "sent"}

    def mark_failed(self, key: str, owner: str, error: str = "",
                    now: datetime = None) -> dict:
        """标记 failed。仅当 lease_owner == owner 时生效；设置退避 next_retry_at。"""
        now = now or _now_utc()
        with self._locked():
            data = self._read()
            rec = data["deliveries"].get(key)
            if not rec or rec.get("status") != SENDING or rec.get("lease_owner") != owner:
                return {"ok": False, "reason": "lease_not_owned"}
            attempts = int(rec.get("attempts", 0))
            backoff = BACKOFF_BASE_SECONDS * (2 ** (attempts - 1)) if attempts >= 1 else BACKOFF_BASE_SECONDS
            rec["status"] = FAILED
            rec["last_error"] = error
            rec["next_retry_at"] = _iso(now + timedelta(seconds=backoff))
            rec["lease_owner"] = None
            rec["lease_expires_at"] = None
            data["deliveries"][key] = rec
            self._write(data)
            return {"ok": True, "reason": "failed", "next_retry_at": rec["next_retry_at"]}

    def release_lease(self, key: str, owner: str) -> dict:
        """释放 lease 回到 pending（未发送、无需退避时用）。"""
        with self._locked():
            data = self._read()
            rec = data["deliveries"].get(key)
            if not rec or rec.get("status") != SENDING or rec.get("lease_owner") != owner:
                return {"ok": False, "reason": "lease_not_owned"}
            rec["status"] = PENDING
            rec["lease_owner"] = None
            rec["lease_expires_at"] = None
            data["deliveries"][key] = rec
            self._write(data)
            return {"ok": True, "reason": "released"}

    # -- 工具 --

    @staticmethod
    def _new_record(key: str, trigger_source: str) -> dict:
        return {
            "delivery_key": key,
            "status": PENDING,
            "attempts": 0,
            "lease_owner": None,
            "lease_expires_at": None,
            "recommendation_version": "",
            "content_hash": "",
            "revision": 0,
            "trigger_source": trigger_source,
            "sent_at": None,
            "message_id": None,
            "last_error": None,
            "next_retry_at": None,
        }

    @staticmethod
    def _parse_time(s) -> datetime:
        if not s:
            return None
        try:
            return datetime.fromisoformat(str(s))
        except ValueError:
            return None


# ─────────────────────────────────────────────────────────────
# 内容 hash
# ─────────────────────────────────────────────────────────────

def content_hash(result: dict) -> str:
    """推荐结果内容 hash（记录用，不参与幂等键）。"""
    canonical = json.dumps(result, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


# ─────────────────────────────────────────────────────────────
# 展会查询（已结束 / 闭展日）
# ─────────────────────────────────────────────────────────────

def _parse_date(s) -> str:
    s = (s or "").strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return s[:10]


def query_finished_exhibitions(supplier_id: str, *, now: datetime = None,
                               explicit_id: str = "") -> list[dict]:
    """查询需要检查的已结束/闭展日展会。

    来源：data/memory/<sid>/meta.json 的 exhibitions[]（start/end 日期）。
    已结束 = end <= 今日（按 Asia/Shanghai 基准，展会时区精确判断在 decide_push_type 层做）。
    explicit_id 给定则只返回该展会（定向联调）。
    """
    now = now or _now_utc()
    meta_path = _workspace_root() / "data" / "memory" / str(supplier_id) / "meta.json"
    if not meta_path.exists():
        return []
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    exhs = meta.get("exhibitions", []) if isinstance(meta, dict) else []
    if not isinstance(exhs, list):
        return []

    out = []
    for e in exhs:
        if not isinstance(e, dict):
            continue
        eid = str(e.get("exhibition_id") or e.get("id") or "")
        if explicit_id and eid != explicit_id:
            continue
        end = _parse_date(e.get("end") or e.get("start") or "")
        # 已结束 = end 日期已过（保守：end 当天仍算进行中，次日才进入展后）
        if end and end < now.strftime("%Y-%m-%d"):
            out.append({
                "exhibition_id": eid or "",
                "name": e.get("name") or e.get("name_en") or "",
                "end_at": end + "T23:59:59+00:00",
                "timezone": (e.get("timezone") or "").strip(),
                "after_exhibition": e.get("after_exhibition") or {},
            })
    return out


# ─────────────────────────────────────────────────────────────
# 摘要（脱敏）
# ─────────────────────────────────────────────────────────────

def summarize(entry: dict) -> dict:
    """输出脱敏运行摘要：只保留 exhibition_id / push_type / 计数 / 状态。"""
    return {
        "exhibition_id": entry.get("exhibition_id"),
        "push_type": entry.get("push_type"),
        "status": entry.get("status"),
        "reason": entry.get("reason"),
        "buyers_total": entry.get("buyers_total"),
        "buyers_not_connected": entry.get("buyers_not_connected"),
    }


# ─────────────────────────────────────────────────────────────
# 发送器（可注入，测试替换）
# ─────────────────────────────────────────────────────────────

class _Result:
    """最小发送结果（与 dc_notify.SendResult 对齐的鸭子类型）。"""

    def __init__(self, ok=False, message_id="", error="", sent=False):
        self.ok = ok
        self.message_id = message_id
        self.error = error
        self.sent = sent


def default_sender():
    """生产发送器：复用 dc_notify 的 Sender 抽象（真实发送 / disabled 均安全）。"""
    try:
        from dc_notify import build_sender_from_env
        return build_sender_from_env()
    except Exception:
        class _Noop:
            def send(self, target, message, idempotency_key=None):
                return _Result(ok=True, sent=False, message_id="")
        return _Noop()


# ─────────────────────────────────────────────────────────────
# 单条展会处理（核心 Worker 逻辑，可测试）
# ─────────────────────────────────────────────────────────────

def process_exhibition(
    exhibition: dict,
    *,
    state_store: DeliveryStateStore,
    sender,
    fetch_fn,
    recommend_fn=None,
    supplier_id: str = "",
    now: datetime = None,
    dry_run: bool = False,
    trigger_source: str = _AUTO_TRIGGER,
    recommendation_version: str = "v1",
) -> dict:
    """处理单个展会：配置 → 时机 → lease → 数据就绪 → 生成 → 发送 → 记录 → 释放。

    返回脱敏摘要条目。
    """
    now = now or _now_utc()
    recommend_fn = recommend_fn or recommend

    config, errors, tz_name, tz_warnings = resolve_effective_config(exhibition, supplier_id)
    exh_for_logic = dict(exhibition)
    exh_for_logic["timezone"] = exh_for_logic.get("timezone") or tz_name

    entry = {
        "exhibition_id": exhibition.get("exhibition_id", ""),
        "push_type": None,
        "status": "skip",
        "reason": "",
        "buyers_total": 0,
        "buyers_not_connected": 0,
    }

    # enabled 开关（生产默认 False）
    if not config.get("enabled", False):
        entry["status"] = "skip"
        entry["reason"] = "disabled"
        return entry

    # 数据同步水位（先 fetch，校验 watermark，再决定是否进入发送流程）
    try:
        sync, records = fetch_fn(str(exhibition.get("exhibition_id") or ""))
    except Exception as e:
        sync, records = {"api_error": True, "error": str(e)}, []

    ready, ready_reason = is_data_ready(sync, exh_for_logic)
    if not ready:
        entry["status"] = "delay"
        entry["reason"] = ready_reason
        return entry

    if trigger_source == _MANUAL_TRIGGER:
        # manual：用户主动触发，跳过时机判断，用独立命名空间键（不占用自动推送键）
        push_type = "manual"
        try:
            local_today = now.astimezone(ZoneInfo(exh_for_logic.get("timezone") or "Asia/Shanghai")).date().isoformat()
        except Exception:
            local_today = now.astimezone(timezone.utc).date().isoformat()
        key = manual_delivery_key(str(exhibition.get("exhibition_id") or ""), local_today)
    else:
        # 判断推送时机（config 里已带 enabled）
        decision = should_send(exh_for_logic, now, sync, None, config,
                               sent_checker=state_store.is_sent)
        if not decision["send"]:
            entry["status"] = "skip"
            entry["reason"] = decision["reason"]
            return entry
        push_type = decision["push_type"]
        key = decision["delivery_key"]
    entry["push_type"] = push_type

    # 生成推荐/提醒
    target_id = str(exhibition.get("exhibition_id") or "")
    result = recommend_fn(
        target_exhibition_id=target_id,
        candidates=records,
        historical_pool=[],
        ideal_profile={},
        exhibition_name=exhibition.get("name", ""),
    )
    not_connected = (len(result.get("uncontacted_recommendations", []))
                     + len(result.get("contacted_but_not_connected", [])))
    entry["buyers_total"] = result.get("statistics", {}).get("attended_buyers", 0)
    entry["buyers_not_connected"] = not_connected

    if push_type in ("d2", "d3") and not not_connected:
        # 无未处理高优先级买家 → 静默（should_send 已判，这里兜底）
        entry["status"] = "skip"
        entry["reason"] = "quiet"
        return entry

    # lease 获取（并发门禁）
    owner = f"worker-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    lease = state_store.acquire_lease(key, owner, now)
    if not lease["acquired"]:
        entry["status"] = "skip"
        entry["reason"] = lease["reason"]
        return entry

    try:
        if dry_run:
            # dry-run：不发送、不写 sent，仅释放 lease 回 pending
            state_store.release_lease(key, owner)
            entry["status"] = "dry_run"
            entry["reason"] = "dry_run_no_send"
            return entry

        # 发送（以 delivery_key 作为发送幂等键，发送层二次兜底防重）
        links = resolve_lead_pool_links(supplier_id)
        message = _format_message(exhibition, push_type, result, links=links)
        send_res = sender.send(_target(exhibition), message, idempotency_key=key)
        message_id = getattr(send_res, "message_id", "") or ""

        if not (getattr(send_res, "sent", False) and message_id):
            # 发送失败（无 message_id）→ 标 failed，退避重试
            err = getattr(send_res, "error", "") or "send_failed_no_message_id"
            state_store.mark_failed(key, owner, error=err, now=now)
            entry["status"] = "failed"
            entry["reason"] = "send_failed"
            return entry

        # 发送成功且拿到 message_id → 标 sent
        ch = content_hash(result)
        mark = state_store.mark_sent(key, owner, message_id,
                                     recommendation_version=recommendation_version,
                                     content_hash=ch, revision=1,
                                     trigger_source=trigger_source, sent_at=now)
        if not mark.get("ok"):
            # 状态写入失败：不得重复发送。消息已发出且带 delivery_key 幂等，仅记录告警。
            entry["status"] = "sent_unrecorded"
            entry["reason"] = f"state_write_failed:{mark.get('reason')}"
            return entry
        entry["status"] = "sent"
        entry["reason"] = "ok"
        return entry
    except Exception as e:  # 未预期异常 → 标 failed，不阻塞其他展会
        state_store.mark_failed(key, owner, error=str(e), now=now)
        entry["status"] = "failed"
        entry["reason"] = f"exception:{type(e).__name__}"
        return entry


def _target(exhibition: dict) -> str:
    """发送目标：优先 chat_id，其次通知路由。运行时由上层注入更精确目标。"""
    return str(exhibition.get("chat_id") or "")


def resolve_lead_pool_links(company_id: str) -> dict:
    """解析企业线索池链接 + 跟进记录链接（参考现有线索池样例 / 跟进记录样例）。

    - 线索池链接 = CompanyRegistry 的 bitable_url（线索池 Bitable，含「报名参展展会」字段）
    - 跟进记录链接 = 优先「沟通明细」子表（interaction_table_id），兜底线索池 bitable_url

    无线索池 / 无跟进表 → 对应链接空串（调用方不追加该行）。
    脱敏：只返回 URL，不返回任何买家姓名/邮箱/电话。
    """
    cid = (company_id or "").strip()
    if not cid:
        return {"lead_pool_url": "", "followup_url": ""}
    try:
        from dc_company_registry import CompanyRegistry
    except Exception:
        return {"lead_pool_url": "", "followup_url": ""}
    try:
        from enterprise_ids import slug_for
    except Exception:
        def slug_for(x):
            return x

    registry = CompanyRegistry()
    entry = None
    for key in (slug_for(cid), cid):
        try:
            e = registry.get(key)
        except Exception:
            e = None
        if e:
            entry = e
            break
    if not entry:
        return {"lead_pool_url": "", "followup_url": ""}

    app_token = entry.get("app_token", "")
    table_id = entry.get("table_id", "")
    lead_pool_url = entry.get("bitable_url") or ""
    if not lead_pool_url and app_token and table_id:
        lead_pool_url = f"https://versa-ai.feishu.cn/base/{app_token}?table={table_id}"

    followup_tid = entry.get("interaction_table_id") or entry.get("followup_table_id", "")
    followup_url = ""
    if app_token and followup_tid:
        followup_url = f"https://versa-ai.feishu.cn/base/{app_token}?table={followup_tid}"
    elif lead_pool_url:
        followup_url = lead_pool_url
    return {"lead_pool_url": lead_pool_url, "followup_url": followup_url}


def _format_message(exhibition: dict, push_type: str, result: dict, links: dict = None) -> str:
    """格式化推送正文（自动推送摘要，不含会议全文）。

    正文下方追加本次展会的线索池链接 + 跟进记录链接（参考现有线索池样例 / 跟进记录样例）。
    """
    name = exhibition.get("name") or exhibition.get("exhibition_id") or "展会"
    stats = result.get("statistics", {})
    not_connected = (len(result.get("uncontacted_recommendations", []))
                     + len(result.get("contacted_but_not_connected", [])))
    followup = len(result.get("connected_followups", []))
    if push_type == "close_day":
        head = f"🏁 {name} 已闭展"
    elif push_type == "d1":
        head = f"📋 {name} 展后跟进清单"
    else:
        head = f"⏰ {name} 展后跟进提醒"
    lines = [
        head,
        f"待建联买家 {not_connected} 家 · 已建联跟进 {followup} 家（共 {stats.get('attended_buyers', 0)} 家）",
    ]
    links = links or {}
    if links.get("lead_pool_url"):
        lines.append(f"📋 线索池 → {links['lead_pool_url']}")
    if links.get("followup_url"):
        lines.append(f"📧 跟进记录 → {links['followup_url']}")
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────

def run(
    supplier_id: str = "",
    *,
    explicit_id: str = "",
    dry_run: bool = False,
    now: datetime = None,
    sender=None,
    fetch_fn=None,
    recommend_fn=None,
    state_store: DeliveryStateStore = None,
    trigger_source: str = _AUTO_TRIGGER,
    recommendation_version: str = "v1",
) -> dict:
    """运行一次调度。返回脱敏摘要 + 返回码。"""
    now = now or _now_utc()
    state_store = state_store or DeliveryStateStore(
        _workspace_root() / "data" / "after-exhibition" / "push-state.json")

    if fetch_fn is None:
        fetch_fn = _default_fetch

    exhibitions = query_finished_exhibitions(supplier_id, now=now, explicit_id=explicit_id)
    if not exhibitions:
        return {"ok": True, "code": "no_exhibition", "summary": [], "exhibitions": 0}

    sender = sender or default_sender()
    results = []
    for exh in exhibitions:
        entry = process_exhibition(
            exh, state_store=state_store, sender=sender, fetch_fn=fetch_fn,
            recommend_fn=recommend_fn, supplier_id=supplier_id, now=now,
            dry_run=dry_run, trigger_source=trigger_source,
            recommendation_version=recommendation_version,
        )
        results.append(summarize(entry))

    code = "ok"
    sent = sum(1 for r in results if r["status"] == "sent")
    delay = sum(1 for r in results if r["status"] == "delay")
    failed = sum(1 for r in results if r["status"] == "failed")
    if failed:
        code = "failed"
    elif delay:
        code = "delayed"
    elif sent == 0:
        code = "no_action"

    return {"ok": True, "code": code, "summary": results,
            "exhibitions": len(results), "sent": sent, "delayed": delay, "failed": failed}


def _default_fetch(exhibition_id: str) -> tuple[dict, list]:
    """默认数据获取：调 after-exhibition-recommend adapter（mock 空，9/8 接真实数据）。

    返回 (sync, records)。sync 含 watermark 字段供 is_data_ready 校验。
    """
    from dc_after_exhibition_recommend import fetch_after_exhibition
    records = fetch_after_exhibition(exhibition_id)
    # mock 阶段：records 为空视为未完成同步（不输出「0 家买家」），真实数据接入后再校准
    sync = {
        "status": "completed_empty" if records == [] else "completed",
        "synced_through": None,
        "exhibition_id": exhibition_id,
        "records": len(records),
    }
    return sync, records


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="展后买家推荐运行时调度 Worker")
    p.add_argument("--company-id", default="", help="企业 supplier_id（缺省读 MIO_CDP_SUPPLIER_ID）")
    p.add_argument("--exhibition-id", default="", help="定向联调：只处理该展会")
    p.add_argument("--dry-run", action="store_true", help="只预演，不发送、不写 sent")
    p.add_argument("--manual", action="store_true", help="用户主动触发（不占用自动推送键）")
    p.add_argument("--state-file", default="", help="状态文件路径（缺省 data/after-exhibition/push-state.json）")
    args = p.parse_args(argv)

    supplier_id = args.company_id or os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()
    state_store = (DeliveryStateStore(Path(args.state_file))
                   if args.state_file else None)
    trigger = _MANUAL_TRIGGER if args.manual else _AUTO_TRIGGER

    result = run(
        supplier_id, explicit_id=args.exhibition_id, dry_run=args.dry_run,
        state_store=state_store, trigger_source=trigger,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("code") in ("ok", "no_action", "no_exhibition", "delayed") else 1


if __name__ == "__main__":
    sys.exit(main())
