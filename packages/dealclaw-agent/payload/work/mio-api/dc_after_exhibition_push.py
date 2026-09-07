#!/usr/bin/env python3
# -- coding: UTF-8 --
"""dc_after_exhibition_push.py — 展后买家推荐自动推送调度（纯函数层）

混合推送方案：
  - 闭展后 30~60 分钟：推简版结果（close_day）
  - D+1 09:30：推正式跟进清单（d1）
  - D+2、D+3 09:30：仅存在未处理的高优先级买家时提醒（d2/d3）
  - 无新增价值或全部完成时静默
  - 用户可随时主动触发（manual，不受此调度限制，不占用自动推送键）

本文件只做「纯函数」：时机判断、幂等键、数据就绪、静默判断、综合发送判断。
真实发送、并发 lease、状态落库在 dc_after_exhibition_runtime.py。

幂等键（delivery_key）：
  delivery_key = exhibition_id + push_type + scheduled_local_date
  - scheduled_local_date = 闭展日在展会时区下的日期 + 按 push_type 的偏移天数
  - 与 recommendation_version / content_hash / 代码版本无关，代码版本变化不会触发重复发送
  - manual 用独立命名空间 exhibition_id + manual + scheduled_local_date，不占用自动推送键

配置优先级：展会 meta 配置 > 企业/租户配置 > DEFAULT_CONFIG。
时区回退：exhibition.timezone > 企业 timezone > Asia/Shanghai（回退时输出 warning）。
生产默认 enabled=False，完成真实数据联调后人工开启。
"""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

PUSH_TYPES = ("close_day", "d1", "d2", "d3")

# 各 push_type 相对闭展日的天数偏移（用于计算 scheduled_local_date）
PUSH_TYPE_DAY_OFFSET = {"close_day": 0, "d1": 1, "d2": 2, "d3": 3}

# 生产默认：enabled=False，完成真实数据联调后人工开启
DEFAULT_CONFIG = {
    "auto_after_exhibition_push": True,
    "close_day_push": True,
    "d1_push": True,
    "followup_reminder_days": [2, 3],
    "quiet_if_no_value": True,
    "timezone": "",
    "enabled": False,
}

# 配置字段校验规则：字段名 -> 校验/归一函数（返回 (值, 错误) 或 (值, None)）
CONFIG_FIELDS = tuple(DEFAULT_CONFIG.keys())


def _parse_end_at(end_at) -> Optional[datetime]:
    """解析闭展时间（ISO 字符串 / datetime），返回带时区的 datetime。"""
    if not end_at:
        return None
    if isinstance(end_at, datetime):
        return end_at if end_at.tzinfo else end_at.replace(tzinfo=timezone.utc)
    s = str(end_at).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _resolve_tz(tz_name: str) -> ZoneInfo:
    """解析时区名，非法/空回退 UTC（供内部计算兜底，对外时间仍按 resolve_timezone 结果）。"""
    try:
        return ZoneInfo(tz_name or "UTC")
    except Exception:
        return ZoneInfo("UTC")


# ─────────────────────────────────────────────────────────────
# 1. 配置读取（优先级：展会 meta > 企业/租户 > DEFAULT_CONFIG）
# ─────────────────────────────────────────────────────────────

def validate_field(key: str, value) -> tuple[Any, Optional[str]]:
    """校验单个配置字段，非法返回 (None, 错误说明)。"""
    if key == "timezone":
        if isinstance(value, str):
            return value, None
        return None, f"timezone 非法值 {value!r}，使用默认"
    if key == "followup_reminder_days":
        if isinstance(value, list) and all(isinstance(x, int) and not isinstance(x, bool) for x in value):
            return list(value), None
        return None, f"followup_reminder_days 非法值 {value!r}，使用默认"
    # 布尔字段：auto_after_exhibition_push / close_day_push / d1_push / quiet_if_no_value / enabled
    if isinstance(value, bool):
        return value, None
    return None, f"{key} 非法值 {value!r}，使用默认"


def resolve_config(exhibition_config: Optional[dict] = None,
                   tenant_config: Optional[dict] = None) -> tuple[dict, list[str]]:
    """解析配置，返回 (merged_config, errors)。

    优先级：展会 meta 配置 > 企业/租户配置 > DEFAULT_CONFIG。
    只有某层「显式提供且校验通过」的字段才会覆盖下层；非法字段回退默认并记录错误。
    """
    merged = dict(DEFAULT_CONFIG)
    errors: list[str] = []

    def apply_layer(raw, layer_name: str) -> None:
        if not isinstance(raw, dict):
            return
        for k in CONFIG_FIELDS:
            if k not in raw:
                continue
            v, err = validate_field(k, raw[k])
            if err:
                errors.append(f"[{layer_name}] {err}")
            else:
                merged[k] = v

    apply_layer(tenant_config, "tenant")
    apply_layer(exhibition_config, "exhibition")
    return merged, errors


def resolve_timezone(exhibition: Optional[dict] = None,
                     tenant_config: Optional[dict] = None,
                     config: Optional[dict] = None) -> tuple[str, list[str]]:
    """解析时区：exhibition.timezone > 企业 timezone > Asia/Shanghai（回退输出 warning）。

    返回 (tz_name, warnings)。非法时区名同样回退 Asia/Shanghai 并告警。
    """
    warnings: list[str] = []
    exh = exhibition or {}
    ten = tenant_config or {}
    cfg = config or {}

    tz = (exh.get("timezone") or "").strip()
    if not tz:
        tz = (ten.get("timezone") or "").strip()
    if not tz:
        tz = (cfg.get("timezone") or "").strip()
    if not tz:
        tz = "Asia/Shanghai"
        warnings.append("未配置 timezone，回退 Asia/Shanghai")

    try:
        ZoneInfo(tz)
    except Exception:
        warnings.append(f"timezone 非法 {tz!r}，回退 Asia/Shanghai")
        tz = "Asia/Shanghai"
    return tz, warnings


# ─────────────────────────────────────────────────────────────
# 2. 幂等键（delivery_key）
# ─────────────────────────────────────────────────────────────

def scheduled_local_date(exhibition: dict, push_type: str) -> str:
    """推送的调度本地日期 = 闭展日（展会时区）+ push_type 偏移天数，ISO 日期字符串。

    与推荐版本 / 内容 / 代码版本无关，因此代码升级不会导致重复发送。
    """
    end_at = _parse_end_at(exhibition.get("end_at"))
    if not end_at:
        return ""
    tz = _resolve_tz((exhibition.get("timezone") or "").strip())
    end_local = end_at.astimezone(tz)
    offset = PUSH_TYPE_DAY_OFFSET.get(push_type, 0)
    return (end_local.date() + timedelta(days=offset)).isoformat()


def delivery_key(exhibition_id: str, push_type: str, scheduled_local_date: str) -> str:
    """自动推送幂等键 = exhibition_id + push_type + scheduled_local_date。"""
    return f"{exhibition_id}:{push_type}:{scheduled_local_date}"


def manual_delivery_key(exhibition_id: str, scheduled_local_date: str) -> str:
    """用户主动触发（manual）幂等键，独立命名空间，不占用 close_day/d1/d2/d3 自动键。"""
    return f"{exhibition_id}:manual:{scheduled_local_date}"


# 兼容旧调用方（原 push_key 用 recommendation_version 组成键，已废弃）
def push_key(exhibition_id: str, push_type: str, recommendation_version: str) -> str:
    """【已废弃】旧幂等键（含推荐版本），仅保留兼容。新代码请用 delivery_key。"""
    return f"{exhibition_id}:{push_type}:{recommendation_version}"


# ─────────────────────────────────────────────────────────────
# 3. 推送时机判断（按展会所在地时区）
# ─────────────────────────────────────────────────────────────

def decide_push_type(exhibition: dict, now_utc: datetime, config: Optional[dict] = None,
                     timezone_name: Optional[str] = None) -> Optional[str]:
    """判断当前该推什么。返回 push_type 或 None（不推）。

    - enabled=False → None（运行时开关，生产默认关闭）
    - 展会未结束（end_at 未到）→ None（路由 onsite-recommend）
    - 闭展后 30~60 分钟 → close_day
    - D+1 09:30 → d1
    - D+2/D+3 09:30 → d2/d3
    """
    cfg = {**DEFAULT_CONFIG, **(config or {})}
    if not cfg.get("auto_after_exhibition_push", True):
        return None

    end_at = _parse_end_at(exhibition.get("end_at"))
    if not end_at:
        return None

    tz = _resolve_tz(timezone_name or (exhibition.get("timezone") or "").strip())
    now_local = now_utc.astimezone(tz)
    end_local = end_at.astimezone(tz)

    minutes_after = (now_local - end_local).total_seconds() / 60
    if minutes_after < 0:
        return None  # 展会进行中

    days_after = (now_local.date() - end_local.date()).days

    # 闭展后 30~60 分钟 → close_day（简版）
    if 30 <= minutes_after < 60 and cfg.get("close_day_push", True):
        return "close_day"

    # D+1 09:30 → d1（正式清单，只在闭展次日）
    if days_after == 1 and now_local.time() >= time(9, 30) and cfg.get("d1_push", True):
        return "d1"

    # D+2/D+3 09:30 → d2/d3（仅高优先级未处理提醒）
    if days_after in cfg.get("followup_reminder_days", [2, 3]) and now_local.time() >= time(9, 30):
        return f"d{days_after}"

    return None


# ─────────────────────────────────────────────────────────────
# 4. 数据就绪判断（watermark / 同步状态）
# ─────────────────────────────────────────────────────────────

def is_data_ready(sync: Optional[dict], exhibition: Optional[dict] = None) -> tuple[bool, str]:
    """数据就绪判断，返回 (ready, reason)。

    sync 字段约定（数据源 adapter 返回）：
      - api_error          : bool，接口异常
      - sync_incomplete    : bool，同步未完成（兼容旧字段）
      - status             : "completed" | "completed_empty" | "syncing" | "error" | "stale"
      - synced_through     : ISO 时间，数据同步覆盖到的时间点
      - exhibition_id      : 数据归属展会
      - stale / fetched_at : 是否过期缓存
      - records            : 记录数

    就绪条件：
      - 接口非空（无 api_error）
      - 数据源同步成功（status = completed / completed_empty）
      - synced_through >= exhibition.end_at
      - exhibition_id 与当前目标一致
      - 数据不是过期缓存
      - records=0 时必须是明确的 completed_empty（否则延迟，不得误报「0 家买家」）
    """
    if not sync:
        return False, "no_sync_data"
    if sync.get("api_error"):
        return False, "api_error"
    if sync.get("sync_incomplete"):
        return False, "sync_incomplete"

    status = sync.get("status") or ""
    # 同步中 / 出错 / 未完成 → 延迟
    if status in ("error", "syncing", "incomplete"):
        return False, f"sync_status_{status}"
    # 过期缓存
    if sync.get("stale") or status == "stale":
        return False, "stale_cache"

    # exhibition_id 与当前目标一致
    exh = exhibition or {}
    target_id = str(exh.get("exhibition_id") or "")
    sync_id = str(sync.get("exhibition_id") or "")
    if target_id and sync_id and target_id != sync_id:
        return False, "exhibition_id_mismatch"

    # synced_through >= end_at
    end_at = _parse_end_at(exh.get("end_at"))
    synced_through = _parse_end_at(sync.get("synced_through"))
    if end_at and synced_through and synced_through < end_at:
        return False, "synced_through_before_end"

    records = sync.get("records", 0)
    if records == 0:
        # 0 条记录只允许在明确的 completed_empty 状态下输出「本届暂无符合条件的买家」
        if status == "completed_empty":
            return True, "completed_empty"
        return False, "zero_records_not_completed_empty"

    return True, "ready"


# ─────────────────────────────────────────────────────────────
# 5. 后续提醒（D+2/D+3 增量，不重发整份名单）
# ─────────────────────────────────────────────────────────────

def build_reminder(recommend_result: Optional[dict]) -> dict:
    """D+2/D+3 增量提醒：只发仍需跟进的买家，不重发整份名单。

    - 仍未触达/未建联的高优先级买家（uncontacted + contacted_but_not_connected）
    - 已回复但 next_step 超期的买家（connected_followups 中 overdue）
    - 已完成 / 已拒绝 / 已建联正常推进的买家不重复提醒
    """
    result = recommend_result or {}
    pending = (
        result.get("uncontacted_recommendations", [])
        + result.get("contacted_but_not_connected", [])
    )
    overdue = [
        b for b in result.get("connected_followups", [])
        if b.get("overdue") or b.get("followup_kind") == "跟进已超时"
    ]
    return {
        "pending": pending,
        "overdue": overdue,
        "has_value": bool(pending or overdue),
    }


# ─────────────────────────────────────────────────────────────
# 6. 静默判断
# ─────────────────────────────────────────────────────────────

def should_push(recommend_result: Optional[dict], push_type: str, config: Optional[dict] = None) -> bool:
    """是否推送（静默判断）。D+2/D+3 无新增价值则静默。"""
    cfg = {**DEFAULT_CONFIG, **(config or {})}
    if push_type in ("d2", "d3"):
        if cfg.get("quiet_if_no_value", True):
            return build_reminder(recommend_result).get("has_value", False)
    return True


# ─────────────────────────────────────────────────────────────
# 7. 综合发送判断（时机 + 幂等 + 数据就绪 + 静默）
# ─────────────────────────────────────────────────────────────

def should_send(
    exhibition: dict,
    now_utc: datetime,
    sync: Optional[dict],
    recommend_result: Optional[dict],
    config: Optional[dict] = None,
    sent_checker: Optional[Any] = None,
) -> dict:
    """综合判断该不该推、推什么。返回 {send, push_type, delivery_key, scheduled_local_date, reason}。

    sent_checker: callable(delivery_key) -> bool，查询持久化状态是否已发送。
    并发下的最终原子门禁（lease）在 runtime 的 acquire_lease 完成，这里只是快速预判。
    """
    cfg = {**DEFAULT_CONFIG, **(config or {})}
    if not cfg.get("enabled", False):
        return {"send": False, "push_type": None, "delivery_key": None,
                "scheduled_local_date": None, "reason": "disabled"}

    push_type = decide_push_type(exhibition, now_utc, config)
    if not push_type:
        return {"send": False, "push_type": None, "delivery_key": None,
                "scheduled_local_date": None, "reason": "not_time"}

    sld = scheduled_local_date(exhibition, push_type)
    key = delivery_key(str(exhibition.get("exhibition_id") or ""), push_type, sld)

    if sent_checker and sent_checker(key):
        return {"send": False, "push_type": push_type, "delivery_key": key,
                "scheduled_local_date": sld, "reason": "already_sent"}

    ready, ready_reason = is_data_ready(sync, exhibition)
    if not ready:
        return {"send": False, "push_type": push_type, "delivery_key": key,
                "scheduled_local_date": sld, "reason": ready_reason}

    if not should_push(recommend_result, push_type, config):
        return {"send": False, "push_type": push_type, "delivery_key": key,
                "scheduled_local_date": sld, "reason": "quiet"}

    return {"send": True, "push_type": push_type, "delivery_key": key,
            "scheduled_local_date": sld, "reason": "ok"}


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(description="展后推荐自动推送调度（调试用）")
    ap.add_argument("--exhibition", default="{}", help="展会 JSON（exhibition_id/end_at/timezone）")
    ap.add_argument("--now", default="", help="当前时间 ISO（缺省用 now）")
    ap.add_argument("--enabled", default="false", help="是否启用（覆盖配置 enabled，调试用）")
    args = ap.parse_args()

    exhibition = json.loads(args.exhibition)
    now = datetime.fromisoformat(args.now) if args.now else datetime.now(timezone.utc)
    cfg = {"enabled": args.enabled.lower() == "true"}
    print(json.dumps(decide_push_type(exhibition, now, cfg), ensure_ascii=False, indent=2))
