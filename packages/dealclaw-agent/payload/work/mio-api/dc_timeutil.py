#!/usr/bin/env python3
"""dc_timeutil.py — 业务时区时间工具（规则 [timezone] 的可执行落点）

规则：任何「今日/当日」口径必须先转业务时区再取日，禁止用 ISO 前 10 位直接比本地日期。
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

DEFAULT_TZ = "Asia/Shanghai"


def _tzinfo(tz: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz or DEFAULT_TZ)
    except Exception:  # noqa: BLE001
        return ZoneInfo(DEFAULT_TZ)


def today_in_tz(tz: str | None = None, now: datetime | None = None) -> str:
    """当前业务时区日期 YYYY-MM-DD。"""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(_tzinfo(tz)).date().isoformat()


def local_date_of(ts, tz: str | None = None) -> str:
    """把带时区 ISO 时间转业务时区日期；无时区按 UTC；解析失败回退前 10 位。"""
    if not ts:
        return ""
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(_tzinfo(tz)).date().isoformat()
    except (ValueError, TypeError):
        return str(ts)[:10]


def is_today(ts, tz: str | None = None, now: datetime | None = None) -> bool:
    d = local_date_of(ts, tz)
    return bool(d) and d == today_in_tz(tz, now)
