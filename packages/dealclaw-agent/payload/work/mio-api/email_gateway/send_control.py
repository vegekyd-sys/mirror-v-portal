#!/usr/bin/env python3
"""T8 — 发信刹车开关 + 阈值可见（最小版）。

刻意**不做**限流：额度已是每租户 30/天，不需要令牌桶 / 队列 / 动态降速。
本模块只解两件与发信量无关的事：

1. **聚合风险**：额度按租户切，但所有租户共用同一个 ``mail.dealclaw.io`` + 同一个
   Provider 账号。一个坏租户能拖垮整个域、连累全部客户 → 需要
   平台级总开关（一键全停）+ 单租户隔离开关（只停一个 enterprise_id）。
2. **小样本脆弱**：投诉率分母是送达量，30 封里 1 个投诉就是 3.3%（行业红线约 0.1%）。
   → 需要**最小样本量门槛**，样本不足时不算比率告警，只记录。

状态落盘：``<DC_DATA_DIR 或 mio-api>/data/send-control/state.json``（复用现有 data
目录，不新建存储服务、不加依赖、SQLite/Redis 一律不用）。

阈值默认**只告警、不自动熔断**（产品要求：先看得见，人再决定）。所以本模块与
``quality_metrics`` 一样是纯读 + 显式动作；唯一的写动作是人工执行 CLI 拨开关。

读取失败的处理（**有意取舍**，见 ``blocked_result``）：开关读不出来时**不阻断发信**，
只在 stderr 响亮告警。理由：开关是「防坏租户连累全平台」的刹车，不是安全边界；
让一个状态文件故障误伤全部租户的发信，比暂时漏掉一次刹车更贵。
"""

from __future__ import annotations

import fcntl
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

__all__ = [
    "SCHEMA_VERSION",
    "STATE_DIR",
    "STATE_FILENAME",
    "CODE_BLOCKED_PLATFORM",
    "CODE_BLOCKED_TENANT",
    "DEFAULT_THRESHOLDS",
    "SendControlError",
    "resolve_data_dir",
    "state_path",
    "default_state",
    "load_state",
    "save_state",
    "normalize_tenant_id",
    "switch_status",
    "switch_overview",
    "blocked_result",
    "set_platform_paused",
    "set_tenant_paused",
    "evaluate_alerts",
    "alerts_for_tenant",
    "format_alerts_line",
]

SCHEMA_VERSION = 1
STATE_DIR = "send-control"
STATE_FILENAME = "state.json"

#: 拒绝发送的错误码（上层按 code 分支，不看文案）。
CODE_BLOCKED_PLATFORM = "send_blocked_platform"
CODE_BLOCKED_TENANT = "send_blocked_tenant"

#: 默认阈值。``min_accepted`` 是**最小样本量门槛**（accepted < 20 时不算比率告警）。
#: 取值理由见 ``evaluate_alerts`` 的 docstring。
DEFAULT_THRESHOLDS = {
    "min_accepted": 20,
    "complaint_rate": 0.005,   # 0.5%
    "bounce_rate": 0.05,       # 5%
}


class SendControlError(Exception):
    """开关状态读写失败（调用方决定是阻断还是放行，本模块不替它决定）。"""


# ── 路径 ────────────────────────────────────────────────
def resolve_data_dir(data_dir=None) -> Path:
    """与 ``EmailStore`` 完全同口径的数据目录解析（复用现有 data 目录）。"""
    if data_dir:
        return Path(data_dir)
    default = Path(__file__).resolve().parent.parent / "data"
    return Path(os.environ.get("DC_DATA_DIR", str(default)))


def state_path(data_dir=None) -> Path:
    return resolve_data_dir(data_dir) / STATE_DIR / STATE_FILENAME


def normalize_tenant_id(enterprise_id: str) -> str:
    """租户主键归一：与 ``quality_metrics`` / ``enterprise_ids`` 同一套 canonical。"""
    try:
        from enterprise_ids import canonical_company_id
        return canonical_company_id(str(enterprise_id or ""))
    except ImportError:  # pragma: no cover - 独立运行时的兜底
        return str(enterprise_id or "").strip()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _warn(message: str) -> None:
    print(f"[send_control] {message}", file=sys.stderr)


# ── 状态读写 ────────────────────────────────────────────
def default_state() -> dict:
    return {"schema_version": SCHEMA_VERSION,
            "platform": {"paused": False, "reason": "", "by": "", "at": ""},
            "tenants": {},
            "thresholds": dict(DEFAULT_THRESHOLDS)}


@contextmanager
def _state_lock(path: Path):
    """读-改-写 串行化（与 store 的 flock 约定一致；锁文件与状态文件同目录）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path.with_suffix(".lock"), "a")
    try:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def load_state(data_dir=None) -> dict:
    """读状态。文件不存在 → 默认状态（全放行）；文件损坏 → 抛 ``SendControlError``。"""
    path = state_path(data_dir)
    if not path.exists():
        return default_state()
    try:
        raw = json.loads(path.read_text(encoding="utf-8") or "{}")
    except (OSError, ValueError) as exc:
        raise SendControlError(f"开关状态不可读 {path}: {type(exc).__name__}: {exc}") from exc
    state = default_state()
    if isinstance(raw, dict):
        if isinstance(raw.get("platform"), dict):
            state["platform"].update(raw["platform"])
        if isinstance(raw.get("tenants"), dict):
            state["tenants"] = {str(k): dict(v) for k, v in raw["tenants"].items()
                                if isinstance(v, dict)}
        if isinstance(raw.get("thresholds"), dict):
            state["thresholds"].update(raw["thresholds"])
    return state


def save_state(state: dict, data_dir=None) -> dict:
    """原子写状态（临时文件 → fsync → os.replace；权限 0600）。"""
    path = state_path(data_dir)
    payload = dict(state)
    payload["schema_version"] = SCHEMA_VERSION
    payload["updated_at"] = _now()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
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
    return payload


# ── 开关查询 ────────────────────────────────────────────
def switch_status(enterprise_id: str = "", *, data_dir=None) -> dict:
    """当前开关结论（只读，不抛异常以外的副作用）。

    平台级对**全部**发件身份生效（自有邮箱 @ 托管邮箱都停），租户级同理。
    """
    state = load_state(data_dir)
    tenant = normalize_tenant_id(enterprise_id)
    entry = (state.get("tenants") or {}).get(tenant) or {}
    platform = state.get("platform") or {}
    platform_paused = bool(platform.get("paused"))
    tenant_paused = bool(entry.get("paused"))
    result = {
        "enterprise_id": str(enterprise_id or ""),
        "tenant_id": tenant,
        "platform_paused": platform_paused,
        "platform": dict(platform),
        "tenant_paused": tenant_paused,
        "tenant": dict(entry) if entry else {},
        "allowed": not (platform_paused or tenant_paused),
        "code": "",
        "reason": "",
        "next_action": "",
        "state_file": str(state_path(data_dir)),
    }
    if platform_paused:
        result["code"] = CODE_BLOCKED_PLATFORM
        result["reason"] = str(platform.get("reason") or "平台级发信总开关已关闭")
        result["next_action"] = ("由平台运维恢复："
                                 "email_gateway/cli.py send-switch-platform --action resume")
    elif tenant_paused:
        result["code"] = CODE_BLOCKED_TENANT
        result["reason"] = str(entry.get("reason") or f"租户 {tenant} 发信已停用")
        result["next_action"] = (f"由该租户负责人/平台运维确认后恢复：email_gateway/cli.py "
                                 f"send-switch-tenant --enterprise {tenant} --action resume")
    return result


def switch_overview(enterprise_id: str = "", *, data_dir=None) -> dict:
    """CLI 用总览（只读）：平台开关 + 全部被停租户 + 指定租户的结论。"""
    state = load_state(data_dir)
    tenants = state.get("tenants") or {}
    platform = state.get("platform") or {}
    overview = {
        "ok": True,
        "platform_paused": bool(platform.get("paused")),
        "platform": dict(platform),
        "tenants_paused": {k: dict(v) for k, v in sorted(tenants.items()) if v.get("paused")},
        "tenants_paused_count": sum(1 for v in tenants.values() if v.get("paused")),
        "thresholds": dict(state.get("thresholds") or DEFAULT_THRESHOLDS),
        "state_file": str(state_path(data_dir)),
        "updated_at": state.get("updated_at", ""),
    }
    if enterprise_id:
        overview["enterprise"] = switch_status(enterprise_id, data_dir=data_dir)
    return overview


def blocked_result(enterprise_id: str = "", *, data_dir=None) -> dict | None:
    """发信前刹车判定：``None`` = 放行；dict = 拒绝，可直接作为调用方返回体。

    **读取失败取舍**：状态文件读不出来 → 返回 ``None``（不阻断）+ stderr 响亮告警。
    开关是「防坏租户拖垮全平台」的刹车，不是安全边界；让一次状态故障误伤全部租户
    的发信，比暂时漏掉一次刹车更贵。这是有意取舍，不是遗漏。

    真正被停用时不返回 ``success=True``，不带假成功字段。
    """
    try:
        status = switch_status(enterprise_id, data_dir=data_dir)
    except Exception as exc:  # noqa: BLE001 — 见 docstring 的取舍
        _warn("发信开关读取失败 → 不阻断发信（保可用性，避免开关故障误伤全部发信）："
              f"{type(exc).__name__}: {exc}")
        return None
    if status["allowed"]:
        return None
    code = status["code"]
    label = "平台级发信总开关已关闭" if code == CODE_BLOCKED_PLATFORM else "该租户发信已被停用"
    return {
        "success": False,
        "sent": False,
        "count": 0,
        "error": f"{label}，拒绝发送：{status['reason']}",
        "code": code,
        "blockers": [code],
        "reason": status["reason"],
        "next_action": status["next_action"],
        "switch": status,
        "gate": None,
    }


# ── 拨开关（人工动作）──────────────────────────────────
def set_platform_paused(paused: bool, *, reason: str = "", by: str = "",
                        data_dir=None) -> dict:
    """平台级总开关：一键停 / 恢复**全部**对外发信（自有 + 托管邮箱都停）。"""
    with _state_lock(state_path(data_dir)):
        state = load_state(data_dir)
        state["platform"] = {"paused": bool(paused),
                             "reason": str(reason or ""),
                             "by": str(by or ""),
                             "at": _now()}
        return save_state(state, data_dir)


def set_tenant_paused(enterprise_id: str, paused: bool, *, reason: str = "",
                      by: str = "", data_dir=None) -> dict:
    """单租户隔离开关：只停/恢复一个 enterprise_id，其他租户不受影响。

    同一租户的多个发件身份（多个 account / 多个地址）一起停——按租户判定，不按账号。
    """
    tenant = normalize_tenant_id(enterprise_id)
    if not tenant:
        raise SendControlError("enterprise_id is required（否则无法隔离到租户）")
    with _state_lock(state_path(data_dir)):
        state = load_state(data_dir)
        tenants = state.setdefault("tenants", {})
        if paused:
            tenants[tenant] = {"paused": True, "reason": str(reason or ""),
                               "by": str(by or ""), "at": _now()}
        else:
            tenants.pop(tenant, None)  # 恢复 = 抹掉条目，不留 paused=False 残渣
        return save_state(state, data_dir)


# ── 阈值可见（只告警，不熔断）─────────────────────────────
def evaluate_alerts(view: dict, *, thresholds: dict | None = None) -> dict:
    """按 ``quality_metrics.metrics_view`` 的结果算阈值告警（纯函数，不写状态、不发消息）。

    口径（与 T7 完全一致，不另立一套）：
      - 分母统一 ``accepted``（Provider 受理数），分子 ``bounced`` / ``complained``；
      - 计数取 ``view["provider_health"]`` 的**全渠道合计**（一个租户一个决定，
        不再按渠道拆分，避免分渠道各报一次把人淹没）；
      - 比率用原始计数现算（不用视图里已 round(4) 的 rate），避免四舍五入把
        「刚好越线」判成没越线。

    最小样本量门槛（``min_accepted``）：``accepted < 20`` 时**不算比率告警**，
    状态置 ``insufficient_sample``，只记录 accepted，不产生误导性的 3.3% / 10%。
    accepted 为 ``None``（数据源不可用）置 ``unavailable``；accepted 为 0 同样置
    ``insufficient_sample``（不看比率，也就不存在除零）——一律不告警、不猜 0。

    默认值理由：
      - ``min_accepted = 20``：20 封时 1 个投诉即 5%（远超 0.5% 阈值），既能报警
        又不会因为 1 封样本把比率算爆；
      - ``complaint_rate = 0.5%``：行业红线约 0.1%，这里放到 5 倍——因为本层**只告警
        不自动停**，宁可作为「需要人看一眼」的信号，而不是提前吓人；真要更早预警，
        把它收到 0.3% 即可（单点改动，不改代码结构）；
      - ``bounce_rate = 5%``：30 封里 3 个硬退信 = 10%，20~30 封区间 1 个退信 = 3.3%
        ~5%，5% 能抓住「名单质量开始变差」的拐点。
    """
    th = dict(DEFAULT_THRESHOLDS)
    th.update(thresholds or {})
    min_accepted = int(th["min_accepted"])
    health = (view or {}).get("provider_health") or {}
    accepted = health.get("accepted")
    bounced = health.get("bounced")
    complained = health.get("complained")

    out = {
        "enterprise_id": (view or {}).get("enterprise_id", ""),
        "range": (view or {}).get("range", {}),
        "status": "ok",
        "accepted": accepted,
        "min_accepted": min_accepted,
        "min_sample_met": False,
        "thresholds": th,
        "observed": {"complaint_rate": None, "bounce_rate": None},
        "alerts": [],
        "threshold_layer": "alert_only_no_auto_cut",
        "read_only": True,
    }

    if accepted is None:
        out["status"] = "unavailable"
        out["reason"] = "数据源不可用，无法判定阈值（不告警、不猜 0）"
        return out
    if accepted < min_accepted or accepted <= 0:
        out["status"] = "insufficient_sample"
        out["reason"] = (f"样本不足（accepted={accepted}，门槛 {min_accepted}），"
                         f"比率告警不触发，仅记录")
        return out

    out["min_sample_met"] = True
    accepted = int(accepted)
    complaint_rate = int(complained or 0) / accepted
    bounce_rate = int(bounced or 0) / accepted
    out["observed"] = {"complaint_rate": round(complaint_rate, 4),
                       "bounce_rate": round(bounce_rate, 4)}

    for metric, value, key in (("complaint_rate", complaint_rate, "complaint_rate"),
                               ("bounce_rate", bounce_rate, "bounce_rate")):
        limit = float(th[key])
        if value > limit:
            out["alerts"].append({
                "metric": metric,
                "value": round(value, 4),
                "threshold": limit,
                "level": "alert",
                "sample": accepted,
                "message": (f"{metric} {value * 100:.2f}% 超过阈值 {limit * 100:.2f}%"
                            f"（accepted={accepted}）"),
                "next_action": ("人工确认后执行：email_gateway/cli.py send-switch-tenant "
                                f"--enterprise {out['enterprise_id']} --action pause"),
            })
    if out["alerts"]:
        out["status"] = "alert"
    return out


def alerts_for_tenant(enterprise_id: str, *, start=None, end=None, tenant=None,
                      data_dir=None, store=None) -> dict:
    """取某租户的阈值结论（CLI / 定时巡检入口）。复用 T7 的 ``metrics_view``，不重算口径。"""
    from email_metrics.quality_metrics import metrics_view
    view = metrics_view(enterprise_id, start=start, end=end, tenant=tenant, store=store)
    return evaluate_alerts(view, thresholds=(load_state(data_dir).get("thresholds") or None))


def format_alerts_line(result: dict) -> str:
    """一行摘要（供群消息 / 日报贴用）。"""
    status = result.get("status")
    if status == "ok":
        return (f"[ok] {result['enterprise_id']} 无阈值告警"
                f"（accepted={result.get('accepted')}）")
    if status in ("insufficient_sample", "unavailable"):
        return f"[{status}] {result['enterprise_id']} {result.get('reason', '')}"
    lines = [f"[alert] {result['enterprise_id']} 命中 {len(result['alerts'])} 条阈值"]
    for a in result["alerts"]:
        lines.append(f"  · {a['message']}")
    lines.append("  → 仅告警，未自动停发；人工确认后再决定是否停用该租户")
    return "\n".join(lines)
