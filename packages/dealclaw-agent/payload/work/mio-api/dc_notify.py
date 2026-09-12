#!/usr/bin/env python3
"""
DC-Notify — DealClaw 统一通知底座（V1）

唯一通知出口。负责接收、保存、合并、去重、发送模拟与失败记录。
所有用户可见消息最终只从这里出去（后续阶段迁移旧通知入口）。

本阶段范围：
  - 只提供 publish/dispatch/retry-failed 三个稳定接口 + Markdown 持久化 + 薄 CLI
  - 不注册 Cron，不迁移旧入口，不真实调用飞书（默认 dry-run）
  - 不修改 Campaign/Skill/Agent.md，不删除旧脚本

持久化：
  data/notifications/{pending,sent,failed}.md
  每个文件 = Markdown 标题注释 + 每行一个 JSON 对象（JSONL）。
  只有 dc_notify.py 结构化读写，用文件锁 + 临时文件原子替换保证并发安全。

依赖（只读复用）：
  - dc_audit.AuditLog  : 每次 publish/dispatch 写审计
  - 时间格式           : UTC ISO 8601（与 dc_send_log / dc_audit 一致）
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import subprocess
import tempfile
from abc import ABC, abstractmethod
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from _tenant_env import load_tenant_env

load_tenant_env()

# ── 路径与常量 ──────────────────────────────────────────────

DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent / "data")))
NOTIFY_DIR = DATA_DIR / "notifications"
PENDING_FILE = NOTIFY_DIR / "pending.md"
SENT_FILE = NOTIFY_DIR / "sent.md"
FAILED_FILE = NOTIFY_DIR / "failed.md"
LOCK_FILE = NOTIFY_DIR / ".lock"
ROUTES_FILE = NOTIFY_DIR / "routes.json"

VALID_KINDS = {"plan_item", "summary_item", "system_alert", "signal_item"}
VALID_SLOTS = {"morning", "evening", "realtime"}
# 只写审计、不进入发送队列的 kind
AUDIT_ONLY_KINDS = {"system_alert"}
# 最大自动重试次数（达到后停止自动重试，管理员 --force 可强制）
MAX_ATTEMPTS = 5

_HEADER = {
    "pending.md": "# DealClaw Notifications — Pending\n# DO NOT EDIT MANUALLY. Managed by dc_notify.py. One JSON object per line.\n",
    "sent.md": "# DealClaw Notifications — Sent\n# DO NOT EDIT MANUALLY. Managed by dc_notify.py. One JSON object per line.\n",
    "failed.md": "# DealClaw Notifications — Failed\n# DO NOT EDIT MANUALLY. Managed by dc_notify.py. One JSON object per line.\n",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── 文件锁与原子写 ──────────────────────────────────────────

@contextmanager
def _file_lock(lock_path: Path):
    """跨进程文件锁（fcntl.flock），保护 pending/sent/failed 的并发读写。"""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    f = open(lock_path, "a")
    fcntl.flock(f, fcntl.LOCK_EX)
    try:
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def _atomic_write(path: Path, content: str) -> None:
    """临时文件 + os.replace 原子替换，避免写一半的文件被读到。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


# ── 稳定 ID ────────────────────────────────────────────────

def _stable_id(company_id: str, kind: str, payload, slot, campaign_id: str) -> str:
    """无 dedupe_key 时生成稳定 ID：同 company+kind+slot+campaign+payload 恒相同。"""
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    key = f"{company_id}|{kind}|{slot or ''}|{campaign_id or ''}|{canonical}"
    return "n_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def _dedupe_id(dedupe_key: str) -> str:
    return "n_" + hashlib.sha1(dedupe_key.encode("utf-8")).hexdigest()[:16]


# ── Sender 抽象 ────────────────────────────────────────────

@dataclass
class SendResult:
    """发送结果。ok 表示本次调用是否成功（含 dry-run 校验通过）。

    - sent=True 表示真实发送了消息；
    - dry_run=True 表示只校验/预演，未真实发送；
    - ok=False 时 error 保存失败原因。
    """
    ok: bool = False
    message_id: str = ""
    error: str = ""
    sent: bool = False
    dry_run: bool = False
    backend: str = ""


class Sender(ABC):
    """统一发送器接口。

    所有通知出口只通过这一个接口发消息，禁止各自硬编码 webhook。
    """

    @abstractmethod
    def send(self, target: str, message: str, idempotency_key: str | None = None) -> SendResult:
        """发送一条消息到 target。

        target          : 最终路由目标（飞书群 chat_id / user:open_id / company_id）
        message         : 已格式化的消息正文
        idempotency_key : 幂等键，用于防止重复发送（可空）
        """
        raise NotImplementedError


class MockSender(Sender):
    """测试/模拟发送器：记录发送，可按条件注入失败。"""

    def __init__(self, fail_on=None):
        self.sent: list[dict] = []
        self._fail_on = fail_on  # callable(dict) -> bool，入参含 target/idempotency_key

    def send(self, target: str, message: str, idempotency_key: str | None = None) -> SendResult:
        rec = {"target": target, "message": message, "idempotency_key": idempotency_key}
        self.sent.append(rec)
        if self._fail_on and self._fail_on(rec):
            return SendResult(ok=False, error="mock failure", backend="mock")
        return SendResult(ok=True, sent=True, backend="mock",
                          message_id="mock_" + (idempotency_key or hashlib.sha1(
                              (target + message).encode()).hexdigest()[:16]))


class FeishuSender(Sender):
    """飞书发送器：适配 OpenClaw 统一 message.send，不硬编码 webhook。

    启用开关：环境变量 DC_NOTIFY_SEND_ENABLED（默认开启，即未配置=1）。
    业务代码不得临时改 enabled；真实发送需同时满足：
      1) 配置启用（enabled=True）
      2) dispatch 非 dry-run
      3) 路由解析成功（route status=ok）
      4) Sender 参数校验通过
    任一不满足都保持 dry-run / 不发送。
    """

    def __init__(self, enabled: bool | None = None):
        # enabled=None 时从环境变量读取；默认开启（未配置=1）
        if enabled is None:
            enabled = os.getenv("DC_NOTIFY_SEND_ENABLED", "1") == "1"
        self.enabled = bool(enabled)
        self.sent: list[dict] = []

    def send(self, target: str, message: str, idempotency_key: str | None = None) -> SendResult:
        # 参数校验（disabled 也校验，保证契约）
        if not target or not str(target).strip():
            return SendResult(ok=False, error="target required", backend="feishu")
        if not message or not str(message).strip():
            return SendResult(ok=False, error="message required", backend="feishu")

        rec = {"target": target, "message": message, "idempotency_key": idempotency_key}

        # 本轮禁用 → dry-run，不真实发送
        if not self.enabled:
            self.sent.append({**rec, "dry_run": True})
            return SendResult(ok=True, dry_run=True, sent=False, backend="feishu",
                              message_id="")

        # 启用 → 通过 OpenClaw message.send CLI（无明文 webhook）
        return self._send_via_cli(rec)

    def _send_via_cli(self, rec: dict) -> SendResult:
        """通过 `lark-cli im +messages-send` 统一发送（文本 + 交互卡片都支持，单租户无 account 歧义）。

        群 oc_ 走 --chat-id，用户 ou_ 走 --user-id；文本用 --text。
        """
        target = rec["target"]
        cmd = ["lark-cli", "im", "+messages-send", "--as", "bot", "--json"]
        if target.startswith("oc_"):
            cmd += ["--chat-id", target]
        elif target.startswith("ou_"):
            cmd += ["--user-id", target]
        else:
            return SendResult(ok=False, error=f"invalid target format: {target[:16]}", backend="feishu")
        if rec.get("idempotency_key"):
            cmd += ["--idempotency-key", str(rec["idempotency_key"])[:50]]
        cmd += ["--text", rec["message"]]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        except FileNotFoundError:
            return SendResult(ok=False, error="lark-cli not found", backend="feishu")
        except subprocess.TimeoutExpired:
            return SendResult(ok=False, error="lark-cli send timeout", backend="feishu")

        if p.returncode != 0:
            return SendResult(ok=False, error=(p.stderr or p.stdout or "send failed")[-200:],
                              backend="feishu")
        self.sent.append({**rec, "dry_run": False})
        # 从 JSON 输出尽力提取 message_id（lark-cli 返回 {ok, data:{message_id}}）
        mid = ""
        try:
            data = json.loads(p.stdout or "{}")
            mid = str((data.get("data") or {}).get("message_id")
                      or data.get("message_id") or data.get("messageId") or "")
        except Exception:
            pass
        return SendResult(ok=True, sent=True, backend="feishu", message_id=mid)


class DisabledSender(Sender):
    """禁用发送器：始终 dry_run，不标记 sent，不真实发送。安全默认。"""

    def __init__(self):
        self.sent: list[dict] = []

    def send(self, target: str, message: str, idempotency_key: str | None = None) -> SendResult:
        rec = {"target": target, "message": message, "idempotency_key": idempotency_key}
        self.sent.append({**rec, "dry_run": True})
        return SendResult(ok=True, dry_run=True, sent=False, backend="disabled", message_id="")


class WeixinSender(Sender):
    """微信发送器：通过 OpenClaw message.send CLI 发送到微信会话。

    为什么需要它：通知通道写死单一 IM（飞书）= 微信租户直接失能，
    回复能识别、却没地方送达。通道必须可换，不是每家都上飞书。
    """

    def __init__(self, enabled: bool | None = None):
        if enabled is None:
            enabled = os.getenv("DC_NOTIFY_SEND_ENABLED", "1") == "1"
        self.enabled = bool(enabled)
        self.sent: list[dict] = []
        self.account = os.getenv("DC_NOTIFY_WEIXIN_ACCOUNT", "")

    def send(self, target: str, message: str, idempotency_key: str | None = None) -> SendResult:
        if not target or not str(target).strip():
            return SendResult(ok=False, error="target required", backend="weixin")
        if not message or not str(message).strip():
            return SendResult(ok=False, error="message required", backend="weixin")
        rec = {"target": target, "message": message, "idempotency_key": idempotency_key}
        if not self.enabled:
            self.sent.append({**rec, "dry_run": True})
            return SendResult(ok=True, dry_run=True, sent=False, backend="weixin", message_id="")
        return self._send_via_cli(rec)

    def _send_via_cli(self, rec: dict) -> SendResult:
        cmd = ["openclaw", "message", "send", "--channel", "openclaw-weixin", "--json"]
        if self.account:
            cmd += ["--account", self.account]
        cmd += ["--target", rec["target"], "--message", rec["message"]]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        except FileNotFoundError:
            return SendResult(ok=False, error="openclaw not found", backend="weixin")
        except subprocess.TimeoutExpired:
            return SendResult(ok=False, error="openclaw send timeout", backend="weixin")
        if p.returncode != 0:
            return SendResult(ok=False, backend="weixin",
                              error=(p.stderr or p.stdout or "send failed")[-200:])
        self.sent.append({**rec, "dry_run": False})
        mid = ""
        try:
            data = json.loads(p.stdout or "{}")
            mid = str((data.get("data") or {}).get("message_id")
                      or data.get("message_id") or data.get("messageId") or "")
        except Exception:  # noqa: BLE001
            pass
        return SendResult(ok=True, sent=True, backend="weixin", message_id=mid)


def build_sender_from_env() -> Sender:
    """统一 Sender 工厂：按 DC_NOTIFY_SENDER_MODE 选择发送器。

    - 未配置/feishu（默认）→ FeishuSender（真实发送，开关默认开启）
    - weixin → WeixinSender，通过 openclaw message send CLI 发到微信会话
    - disabled → DisabledSender，仅 dry_run，不标记 sent

    mock 不允许通过环境变量进入，只允许测试代码显式注入 NotifyEngine(sender=MockSender())。
    生产 CLI、dc_daily_cycle、默认 NotifyEngine 都必须走此工厂，禁止自行判断 Sender。
    """
    mode = os.getenv("DC_NOTIFY_SENDER_MODE", "feishu").strip().lower()
    if mode == "feishu":
        return FeishuSender()
    if mode == "weixin":
        return WeixinSender()
    return DisabledSender()


# ── Markdown 持久化存储 ────────────────────────────────────

class NotifyStore:
    """pending/sent/failed 三个 Markdown 文件的唯一结构化读写入口。"""

    def __init__(self, data_dir: Path | None = None):
        root = Path(data_dir) if data_dir else DATA_DIR
        self.dir = root / "notifications"
        self.pending = self.dir / "pending.md"
        self.sent = self.dir / "sent.md"
        self.failed = self.dir / "failed.md"
        self.lock = self.dir / ".lock"
        self.dir.mkdir(parents=True, exist_ok=True)
        for p in (self.pending, self.sent, self.failed):
            if not p.exists():
                _atomic_write(p, _HEADER[p.name])

    # ── 读 ──

    def _read(self, path: Path) -> list[dict]:
        if not path.exists():
            return []
        records = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return records

    def read_pending(self) -> list[dict]:
        return self._read(self.pending)

    def read_sent(self) -> list[dict]:
        return self._read(self.sent)

    def read_failed(self) -> list[dict]:
        return self._read(self.failed)

    # ── 写（内部：锁内重读-修改-原子写）──

    def _replace(self, path: Path, records: list[dict]) -> None:
        lines = _HEADER[path.name]
        for r in records:
            lines += json.dumps(r, ensure_ascii=False) + "\n"
        _atomic_write(path, lines)

    def append_pending(self, record: dict) -> None:
        with _file_lock(self.lock):
            records = self._read(self.pending)
            records.append(record)
            self._replace(self.pending, records)

    def move_pending_to(self, record: dict, target: Path, patch: dict | None = None) -> None:
        """把 pending 中某条移到 sent/failed，可附加 patch 字段。"""
        with _file_lock(self.lock):
            pending = self._read(self.pending)
            pending = [r for r in pending if r.get("notification_id") != record.get("notification_id")]
            self._replace(self.pending, pending)

            target_records = self._read(target)
            merged = dict(record)
            if patch:
                merged.update(patch)
            target_records.append(merged)
            self._replace(target, target_records)

    def update_failed(self, notification_id: str, patch: dict) -> None:
        """就地更新 failed 中某条（用于重试后增加 attempts / 成功后移走前）。"""
        with _file_lock(self.lock):
            failed = self._read(self.failed)
            for r in failed:
                if r.get("notification_id") == notification_id:
                    r.update(patch)
            self._replace(self.failed, failed)

    def move_failed_to_sent(self, record: dict, patch: dict | None = None) -> None:
        with _file_lock(self.lock):
            failed = self._read(self.failed)
            failed = [r for r in failed if r.get("notification_id") != record.get("notification_id")]
            self._replace(self.failed, failed)
            sent = self._read(self.sent)
            merged = dict(record)
            if patch:
                merged.update(patch)
            sent.append(merged)
            self._replace(self.sent, sent)

    def exists_active(self, notification_id: str) -> bool:
        """检查 notification_id 是否已存在于 pending/sent/failed（防重复）。"""
        for p in (self.pending, self.sent, self.failed):
            for r in self._read(p):
                if r.get("notification_id") == notification_id:
                    return True
        return False


# ── 通知引擎 ───────────────────────────────────────────────

# ── 路由映射（测试环境用）──────────────────────────────────

class RouteMap:
    """company_id → 飞书 target（chat_id/open_id）路由映射。

    company_id 不是飞书 target，必须解析为群聊 chat_id(oc_) 或用户 open_id(ou_)。
    生产环境一台 VM 一个企业，映射一对一；测试环境多企业共用，需逐一绑定。
    """

    def __init__(self, data_dir: Path | None = None):
        root = Path(data_dir) if data_dir else DATA_DIR
        self.dir = root / "notifications"
        self.file = self.dir / "routes.json"
        self.dir.mkdir(parents=True, exist_ok=True)
        if not self.file.exists():
            _atomic_write(self.file, "{}\n")

    def _load(self) -> dict:
        try:
            return json.loads(self.file.read_text(encoding="utf-8") or "{}")
        except (json.JSONDecodeError, OSError):
            return {}

    def _save(self, data: dict) -> None:
        _atomic_write(self.file, json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    def set(self, company_id: str, chat_id: str, label: str = "") -> dict:
        with _file_lock(self.dir / ".lock"):
            data = self._load()
            data[company_id] = {"chat_id": chat_id, "label": label, "updated_at": _now()}
            self._save(data)
        return data[company_id]

    def get(self, company_id: str) -> dict | None:
        return self._load().get(company_id)

    def list_all(self) -> dict:
        return self._load()


def get_default_target() -> str:
    """单租户主接收方：notify_routes.json 的 default 键。

    返回 oc_（群）/ ou_（用户）target，未配置返回空串。供 lead push 等其它推送
    路径复用，与 dc_notify.resolve_target 共用同一份配置，避免各自维护目标。
    """
    try:
        r = RouteMap().get("default")
        return (r.get("chat_id") or r.get("target_id") or "").strip()
    except Exception:
        return ""


class NotifyEngine:
    """DealClaw 唯一通知出口。"""

    def __init__(self, data_dir: Path | None = None, sender: Sender | None = None, audit=None):
        self.store = NotifyStore(data_dir)
        self.routes = RouteMap(data_dir)
        self.sender = sender if sender is not None else build_sender_from_env()
        self._audit = audit

    # ── 路由（测试环境绑定 company_id → chat_id）──

    def set_route(self, company_id: str, chat_id: str, label: str = "") -> dict:
        """测试环境：把 company_id 绑定到群聊 chat_id。生产环境不调用。"""
        return self.routes.set(company_id, chat_id, label)

    def set_notification_route(self, company_id: str, target_type: str = "chat_id",
                               target_id: str = "", app_id: str = "", tenant_key: str = "",
                               label: str = "", channel: str = "feishu", status: str = "active",
                               verified_at: str = "", source: str = "manual_verified") -> dict:
        """设置完整通知路由（P0-E3B 契约）。open_id 必须带 app_id。"""
        with _file_lock(self.routes.dir / ".lock"):
            data = self.routes._load()
            data[company_id] = {
                "chat_id": target_id if target_type == "chat_id" else "",
                "company_id": company_id, "channel": channel, "target_type": target_type,
                "target_id": target_id, "app_id": app_id, "tenant_key": tenant_key,
                "label": label, "status": status, "verified_at": verified_at,
                "source": source, "updated_at": _now(),
            }
            self.routes._save(data)
        return data[company_id]

    def resolve_target(self, company_id: str) -> dict:
        """解析 company_id → 飞书 target。

        单租户单接收方：notify_routes.json 的 "default" 键存主接收方（oc_ 群 / ou_ 用户）。
        company_id 不是路由主键（初始化时不知道），但保留 company_id 专属路由作兼容。

        返回：
          status="ok"             → 有合法 chat_id/open_id，可发送
          status="route_missing"  → 无映射，禁止发送
          status="route_invalid"  → 映射值非法，禁止发送
        """
        # 1) company_id 专属路由（兼容多租户测试环境）
        r = self.routes.get(company_id)
        # 2) 默认主接收方（单租户，初始化时不知道 company_id）
        if not r:
            r = self.routes.get("default")
        if not r:
            return {"company_id": company_id, "status": "route_missing",
                    "error": "notify_routes.json 无 default 主接收方，也无 company_id 映射"}
        target = (r.get("chat_id") or r.get("target_id") or "").strip()
        if not target:
            return {"company_id": company_id, "status": "route_invalid",
                    "error": "empty chat_id in route"}
        if not (target.startswith("oc_") or target.startswith("ou_")
                or target.endswith("@im.wechat")):
            return {"company_id": company_id, "status": "route_invalid",
                    "error": f"invalid target format: {target[:16]}"}
        return {"company_id": company_id, "chat_id": target,
                "label": r.get("label", ""), "status": "ok", "source": "notify_routes"}

    def resolve_notification_route(self, company_id: str) -> dict:
        """解析 company_id → 通知路由（扩展契约，供 signal_item 使用）。

        - 群通知用 chat_id；私聊才用 open_id。
        - open_id 必须同时带 app_id；不同 app_id 的 open_id 不可互换。
        - route 缺失禁止把 company_id 当 target。
        """
        r = self.routes.get(company_id)
        if not r:
            r = self.routes.get("default")
        if not r:
            return {"company_id": company_id, "status": "route_missing",
                    "error": "no notification route for company_id"}
        target_type = r.get("target_type", "chat_id")
        target_id = (r.get("target_id") or r.get("chat_id") or "").strip()
        if not target_id:
            return {"company_id": company_id, "status": "route_invalid", "error": "empty target_id"}
        if r.get("status", "active") != "active":
            return {"company_id": company_id, "status": "route_invalid", "error": "route not active"}
        if target_type == "chat_id":
            if not (target_id.startswith("oc_") or target_id.endswith("@im.wechat")):
                return {"company_id": company_id, "status": "route_invalid", "error": "invalid chat_id"}
        elif target_type == "open_id":
            if not target_id.startswith("ou_"):
                return {"company_id": company_id, "status": "route_invalid", "error": "invalid open_id"}
            if not r.get("app_id"):
                return {"company_id": company_id, "status": "route_invalid", "error": "open_id requires app_id"}
            expected_app = os.getenv("DC_NOTIFY_FEISHU_APP_ID", "cli_a9365919fc3a1bd6")
            if r.get("app_id") != expected_app:
                return {"company_id": company_id, "status": "route_invalid", "error": "open_id app_id mismatch"}
        else:
            return {"company_id": company_id, "status": "route_invalid", "error": f"invalid target_type {target_type}"}
        return {
            "company_id": company_id,
            "channel": r.get("channel", "feishu"),
            "target_type": target_type,
            "target_id": target_id,
            "app_id": r.get("app_id", ""),
            "tenant_key": r.get("tenant_key", ""),
            "label": r.get("label", ""),
            "status": "ok",
            "verified_at": r.get("verified_at", ""),
            "source": r.get("source", ""),
        }

    def list_routes(self) -> dict:
        return self.routes.list_all()

    @staticmethod
    def _is_company_allowed(company_id: str) -> bool:
        """公司级发送白名单。DC_NOTIFY_ALLOWED_COMPANIES 逗号分隔；未配置=全部允许（默认开启）。

        配置了白名单时才按白名单过滤；未配置则不拦截，保证用户不配置也能推送。
        """
        allowed = os.getenv("DC_NOTIFY_ALLOWED_COMPANIES", "")
        if not allowed.strip():
            return True
        allowed_set = {x.strip() for x in allowed.split(",") if x.strip()}
        return company_id in allowed_set

    # ── 审计 ──

    def _audit_log(self, action: str, company_id: str, target: str, detail: str) -> None:
        if self._audit is None:
            from dc_audit import AuditLog
            self._audit = AuditLog()
        try:
            self._audit.log(action=action, user_open_id="system",
                            enterprise=company_id, target=target, detail=detail)
        except Exception:
            # 审计失败不阻塞主流程（通知底座不能因为审计挂掉）
            pass

    # ── publish ──

    def publish(self, company_id: str, kind: str, payload,
                urgency: str = "normal", dedupe_key: str | None = None,
                campaign_id: str | None = None, slot: str | None = None) -> dict:
        """发布一条通知。返回结构化结果。"""
        if not company_id or not company_id.strip():
            return {"status": "error", "error": "company_id required"}
        if kind not in VALID_KINDS:
            return {"status": "error", "error": f"invalid kind: {kind}"}
        # plan_item 只进 morning，summary_item 只进 evening，signal_item 只进 realtime
        if slot is None and kind == "plan_item":
            slot = "morning"
        if slot is None and kind == "summary_item":
            slot = "evening"
        if slot is None and kind == "signal_item":
            slot = "realtime"
        if slot is not None and slot not in VALID_SLOTS:
            return {"status": "error", "error": f"invalid slot: {slot}"}

        notification_id = _dedupe_id(dedupe_key) if dedupe_key else _stable_id(
            company_id, kind, payload, slot, campaign_id or "")

        # system_alert：只写审计，不进队列
        if kind in AUDIT_ONLY_KINDS:
            self._audit_log("notify.audit_only", company_id, notification_id,
                            f"system_alert: {str(payload)[:120]}")
            return {"status": "audited", "notification_id": notification_id, "kind": kind}

        # 去重：相同 notification_id 已存在 → duplicate
        if self.store.exists_active(notification_id):
            self._audit_log("notify.duplicate", company_id, notification_id,
                            f"duplicate publish ignored for {kind}")
            return {"status": "duplicate", "notification_id": notification_id, "kind": kind}

        record = {
            "notification_id": notification_id,
            "company_id": company_id,
            "campaign_id": campaign_id or "",
            "kind": kind,
            "slot": slot or "",
            "urgency": urgency,
            "dedupe_key": dedupe_key or "",
            "status": "pending",
            "payload": payload,
            "created_at": _now(),
            "sent_at": "",
            "attempts": 0,
            "last_error": "",
            "next_retry_at": "",
        }
        self.store.append_pending(record)
        self._audit_log("notify.publish", company_id, notification_id,
                        f"publish {kind} slot={slot or '-'} urgency={urgency}")
        return {"status": "published", "notification_id": notification_id, "kind": kind}

    # ── dispatch ──

    def dispatch(self, company_id: str, slot: str | None = None, dry_run: bool = False) -> dict:
        """按 company_id（+可选 slot）分发 pending。返回结构化结果。"""
        if not company_id or not company_id.strip():
            return {"status": "error", "error": "company_id required"}

        pending = [r for r in self.store.read_pending() if r.get("company_id") == company_id]

        # 过滤 slot
        if slot is not None:
            pending = [r for r in pending if r.get("slot") == slot]

        if not pending:
            self._audit_log("notify.quiet", company_id, "-", "dispatch: no pending items")
            return {"status": "quiet", "message": "无待发内容", "batches": []}

        # 路由解析：company_id 必须解析为 chat_id/open_id，否则禁止发送
        route = self.resolve_target(company_id)
        if route["status"] != "ok":
            # 路由缺失/非法：禁止调用 Sender，消息保留 pending，写 audit + system_alert
            self._audit_log("notify.route_error", company_id, "-",
                            f"{route['status']}: {route.get('error','')}")
            self.publish(company_id, "system_alert",
                         {"reason": route["status"], "error": route.get("error", ""),
                          "pending_count": len(pending)})
            return {"status": "route_error", "error": route.get("error", ""),
                    "route_status": route["status"],
                    "message": "路由未解析，消息保留在 pending，未发送"}

        # 分组：plan_item / summary_item 按 slot 合并成一条（同 company+slot）
        daily_by_slot: dict[str, list[dict]] = {}
        for r in pending:
            if r.get("kind") in ("plan_item", "summary_item"):
                daily_by_slot.setdefault(r.get("slot") or "unspecified", []).append(r)
            # system_alert 不应在 pending，防御性跳过

        batches: list[dict] = []
        # 合并 plan_item/summary_item
        for s, items in daily_by_slot.items():
            batch_kind = "plan_item" if s == "morning" else "summary_item"
            merged = {
                "notification_id": "b_" + hashlib.sha1(
                    f"{company_id}|{s}|{len(items)}".encode()).hexdigest()[:16],
                "company_id": company_id,
                "kind": batch_kind,
                "slot": s,
                "items": [it["payload"] for it in items],
                "original_ids": [it["notification_id"] for it in items],
                "route": route,
                "created_at": _now(),
            }
            batches.append(merged)

        # signal_item：逐条发送（不合并），用 payload.message
        for r in pending:
            if r.get("kind") == "signal_item":
                batches.append({
                    "notification_id": r["notification_id"],
                    "company_id": company_id,
                    "kind": "signal_item",
                    "slot": r.get("slot") or "realtime",
                    "payload": r.get("payload") or {},
                    "route": route,
                    "original_ids": [r["notification_id"]],
                    "created_at": _now(),
                })

        if dry_run:
            self._audit_log("notify.dispatch_dryrun", company_id, "-",
                            f"dry-run {len(batches)} batch(es), slot={slot or '-'}")
            return {"status": "dry_run", "message": f"将发送 {len(batches)} 条", "batches": batches}

        # 公司白名单：非白名单企业强制 dry-run（即使全局 DC_NOTIFY_SEND_ENABLED=1）
        if not self._is_company_allowed(company_id):
            self._audit_log("notify.company_not_allowed", company_id, "-",
                            "company not in DC_NOTIFY_ALLOWED_COMPANIES, force dry-run")
            return {"status": "dry_run", "message": f"{company_id} 不在发送白名单，强制 dry-run",
                    "batches": batches, "forced_dry_run": True}

        # 真实发送
        results = []
        for b in batches:
            # target 必须是解析后的 chat_id/open_id（route status=ok 时保证非空）
            target = b.get("route", {}).get("chat_id") or ""
            message = self._format_message(b)
            res = self.sender.send(target, message, idempotency_key=b["notification_id"])
            if res.sent:
                message_id = res.message_id or ""
                if not message_id:
                    self._audit_log("notify.message_id_missing", company_id, b["notification_id"],
                                    "sender claimed sent=true but message_id empty")
                self._mark_sent(b, message_id=message_id)
                results.append({"notification_id": b["notification_id"], "status": "sent",
                                "message_id": message_id})
            elif res.ok and res.dry_run:
                # sender 层预演（如 FeishuSender disabled），保持 pending，不标记 sent/failed
                results.append({"notification_id": b["notification_id"], "status": "dry_run",
                                "backend": res.backend})
            else:
                self._mark_failed(b, res.error or "unknown error")
                results.append({"notification_id": b["notification_id"],
                                "status": "failed", "error": res.error or ""})

        self._audit_log("notify.dispatch", company_id, "-",
                        f"dispatch {len(results)} batch(es): "
                        f"{sum(1 for x in results if x['status']=='sent')} sent, "
                        f"{sum(1 for x in results if x['status']=='dry_run')} dry_run, "
                        f"{sum(1 for x in results if x['status']=='failed')} failed")
        return {"status": "dispatched", "message": f"已处理 {len(results)} 条", "results": results}

    def _format_message(self, batch: dict) -> str:
        """把 batch 格式化为消息正文（sender 的 message 入参）。"""
        kind = batch.get("kind")
        company = batch.get("company_id", "")
        slot = batch.get("slot", "")
        if kind in ("plan_item", "summary_item"):
            head = "☀️" if slot == "morning" else "🌙"
            try:
                from dc_daily_report import company_display_name
                cname = company_display_name(company)
            except Exception:
                cname = company
            title = f"{head} {'早报' if slot == 'morning' else '晚报'} · {cname}"
            lines = [title]
            for item in batch.get("items", []):
                rt = item.get("report_text") if isinstance(item, dict) else None
                if rt:
                    lines.append(rt)
                else:
                    lines.append(f"· {json.dumps(item, ensure_ascii=False)}")
            return "\n".join(lines)
        if kind == "signal_item":
            return (batch.get("payload", {}).get("message", "") or
                    json.dumps(batch.get("payload", {}), ensure_ascii=False))
        return json.dumps(batch.get("items", []), ensure_ascii=False)

    def _mark_sent(self, batch: dict, message_id: str = "") -> None:
        sent_at = _now()
        for original_id in batch["original_ids"]:
            # 从 pending 找原始记录，移到 sent
            pending = self.store.read_pending()
            orig = next((r for r in pending if r.get("notification_id") == original_id), None)
            if orig is not None:
                self.store.move_pending_to(orig, self.store.sent,
                                           {"sent_at": sent_at, "status": "sent",
                                            "message_id": message_id})
        self._audit_log("notify.sent", batch["company_id"], batch["notification_id"],
                        f"sent {batch.get('kind')} slot={batch.get('slot','-')} "
                        f"message_id={message_id or 'missing'}")

    def _mark_failed(self, batch: dict, error: str) -> None:
        now = _now()
        for original_id in batch["original_ids"]:
            pending = self.store.read_pending()
            orig = next((r for r in pending if r.get("notification_id") == original_id), None)
            if orig is not None:
                attempts = int(orig.get("attempts", 0)) + 1
                self.store.move_pending_to(orig, self.store.failed, {
                    "status": "failed",
                    "attempts": attempts,
                    "last_error": error[:200],
                    "next_retry_at": _retry_at(attempts),
                })
        self._audit_log("notify.failed", batch["company_id"], batch["notification_id"],
                        f"failed {batch.get('kind')} slot={batch.get('slot','-')}: {error[:120]}")

    # ── retry-failed ──

    def retry_failed(self, company_id: str, dry_run: bool = False, force: bool = False) -> dict:
        """重试 failed 记录。默认仅重试 next_retry_at 已到且未超 max_attempts 的；
        force=True 忽略时间与次数限制（管理员强制）。"""
        if not company_id or not company_id.strip():
            return {"status": "error", "error": "company_id required"}

        # 路由解析：重试同样需要有效 target
        route = self.resolve_target(company_id)
        if route["status"] != "ok":
            self._audit_log("notify.route_error", company_id, "-",
                            f"retry: {route['status']}: {route.get('error','')}")
            return {"status": "route_error", "error": route.get("error", ""),
                    "route_status": route["status"], "message": "路由未解析，未重试"}

        failed = [r for r in self.store.read_failed()
                  if r.get("company_id") == company_id and r.get("status") == "failed"]
        if not failed:
            self._audit_log("notify.quiet", company_id, "-", "retry-failed: nothing to retry")
            return {"status": "quiet", "message": "无失败记录可重试", "results": []}

        now_dt = datetime.fromisoformat(_now())
        retryable: list[dict] = []
        skipped: list[dict] = []
        for r in failed:
            attempts = int(r.get("attempts", 0))
            # 达到 max_attempts 且非 force → 停止自动重试
            if attempts >= MAX_ATTEMPTS and not force:
                skipped.append({"notification_id": r["notification_id"], "reason": "max_attempts"})
                continue
            # 未到重试时间且非 force → 跳过
            nra = r.get("next_retry_at", "")
            if nra and not force:
                try:
                    if datetime.fromisoformat(nra) > now_dt:
                        skipped.append({"notification_id": r["notification_id"], "reason": "not_due"})
                        continue
                except ValueError:
                    pass
            retryable.append(r)

        if dry_run:
            return {"status": "dry_run",
                    "message": f"将重试 {len(retryable)} 条（跳过 {len(skipped)} 条）",
                    "results": [{"notification_id": r["notification_id"], "kind": r.get("kind")}
                                for r in retryable],
                    "skipped": skipped}

        if not retryable:
            self._audit_log("notify.quiet", company_id, "-",
                            f"retry-failed: {len(skipped)} skipped (not_due/max_attempts)")
            return {"status": "quiet",
                    "message": f"无可重试（跳过 {len(skipped)} 条）",
                    "results": [], "skipped": skipped}

        results = []
        for r in retryable:
            batch = {
                "notification_id": r["notification_id"],
                "company_id": company_id,
                "kind": r.get("kind"),
                "slot": r.get("slot", ""),
                "items": [r.get("payload")],
                "original_ids": [r["notification_id"]],
                "route": route,
                "created_at": _now(),
            }
            target = route["chat_id"]
            message = self._format_message(batch)
            res = self.sender.send(target, message, idempotency_key=r["notification_id"])
            if res.sent:
                message_id = res.message_id or ""
                if not message_id:
                    self._audit_log("notify.message_id_missing", company_id, r["notification_id"],
                                    "retry: sender claimed sent=true but message_id empty")
                # 转 sent，保留累计 attempts + message_id
                self.store.move_failed_to_sent(r, {"sent_at": _now(), "status": "sent",
                                                   "message_id": message_id})
                results.append({"notification_id": r["notification_id"], "status": "sent",
                                "attempts": r.get("attempts", 0), "message_id": message_id})
                self._audit_log("notify.sent", company_id, r["notification_id"],
                                f"retry succeeded message_id={message_id or 'missing'}")
            elif res.ok and res.dry_run:
                results.append({"notification_id": r["notification_id"], "status": "dry_run",
                                "backend": res.backend})
            else:
                attempts = int(r.get("attempts", 0)) + 1
                self.store.update_failed(r["notification_id"], {
                    "attempts": attempts,
                    "last_error": (res.error or "unknown")[:200],
                    "next_retry_at": _retry_at(attempts),
                })
                results.append({"notification_id": r["notification_id"], "status": "failed",
                                "attempts": attempts})
                self._audit_log("notify.failed", company_id, r["notification_id"],
                                f"retry failed: {(res.error or '')[:120]}")

        return {"status": "dispatched",
                "message": f"重试 {len(results)} 条（跳过 {len(skipped)} 条）",
                "results": results, "skipped": skipped}


def _retry_at(attempts: int) -> str:
    """指数退避重试时间：5min * 2^attempts，封顶 24h。"""
    minutes = min(5 * (2 ** max(0, attempts - 1)), 24 * 60)
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


# ── CLI ────────────────────────────────────────────────────

def _cli():
    ap = argparse.ArgumentParser(description="DealClaw 统一通知底座")
    ap.add_argument("--data-dir", default=None, help="数据根目录（默认 data/，测试时指向临时目录）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("publish", help="发布一条通知")
    p.add_argument("--company-id", required=True)
    p.add_argument("--kind", required=True, choices=sorted(VALID_KINDS))
    p.add_argument("--payload", required=True, help="JSON 字符串")
    p.add_argument("--urgency", default="normal")
    p.add_argument("--dedupe-key", default=None)
    p.add_argument("--campaign-id", default=None)
    p.add_argument("--slot", default=None, choices=["morning", "evening"])

    d = sub.add_parser("dispatch", help="分发待发通知")
    d.add_argument("--company-id", required=True)
    d.add_argument("--slot", default=None, choices=["morning", "evening"])
    d.add_argument("--dry-run", action="store_true")

    r = sub.add_parser("retry-failed", help="重试失败通知")
    r.add_argument("--company-id", required=True)
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--force", action="store_true", help="忽略重试时间与最大次数限制（管理员强制）")

    rt = sub.add_parser("route", help="测试环境：绑定/查看 company_id → chat_id 路由")
    rt.add_argument("--company-id", required=True)
    rt.add_argument("--chat-id", default=None, help="飞书群 chat_id（oc_xxx）。不传则仅查看当前映射")
    rt.add_argument("--label", default="")

    args = ap.parse_args()
    engine = NotifyEngine(data_dir=Path(args.data_dir) if args.data_dir else None)

    if args.cmd == "publish":
        try:
            payload = json.loads(args.payload)
        except json.JSONDecodeError as e:
            print(json.dumps({"status": "error", "error": f"payload 不是合法 JSON: {e}"}, ensure_ascii=False))
            return 1
        result = engine.publish(args.company_id, args.kind, payload,
                                urgency=args.urgency, dedupe_key=args.dedupe_key,
                                campaign_id=args.campaign_id, slot=args.slot)
    elif args.cmd == "dispatch":
        result = engine.dispatch(args.company_id, slot=args.slot, dry_run=args.dry_run)
    elif args.cmd == "retry-failed":
        result = engine.retry_failed(args.company_id, dry_run=args.dry_run, force=args.force)
    elif args.cmd == "route":
        if args.chat_id:
            result = engine.set_route(args.company_id, args.chat_id, args.label)
            result = {"status": "route_set", "company_id": args.company_id, "route": result}
        else:
            result = {"status": "route_get", "company_id": args.company_id,
                      "route": engine.routes.get(args.company_id)}

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
