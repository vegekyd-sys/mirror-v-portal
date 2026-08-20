#!/usr/bin/env python3
"""send_window.py — 邮件发送窗口检查。

判断买家当地时间是否在「工作日 8:00-18:00」发送窗口内。
不在窗口则阻断（exit 1），并说明原因 + 预计可发送时间。

用法:
  python3 send_window.py --country BR [--city "Sao Paulo"]

时区解析:
  - 国家 ISO 码 → IANA 时区（pytz.country_timezones）
  - 多时区国家用 --city 辅助匹配，匹配不到则取该国家第一个时区
"""
from __future__ import annotations

import argparse
import datetime
import sys

import pytz

WINDOW_START = 8   # 8:00
WINDOW_END = 18    # 18:00（不含）

# 常见国家的主要时区（多时区国家取主要时区，避免默认取到偏远时区）
PRIMARY_TZ = {
    "BR": "America/Sao_Paulo", "US": "America/New_York", "CN": "Asia/Shanghai",
    "DE": "Europe/Berlin", "GB": "Europe/London", "FR": "Europe/Paris",
    "IT": "Europe/Rome", "ES": "Europe/Madrid", "NL": "Europe/Amsterdam",
    "IN": "Asia/Kolkata", "JP": "Asia/Tokyo", "KR": "Asia/Seoul",
    "RU": "Europe/Moscow", "AU": "Australia/Sydney", "CA": "America/Toronto",
    "MX": "America/Mexico_City", "AE": "Asia/Dubai", "SA": "Asia/Riyadh",
    "TR": "Europe/Istanbul", "VN": "Asia/Ho_Chi_Minh", "TH": "Asia/Bangkok",
    "ID": "Asia/Jakarta", "MY": "Asia/Kuala_Lumpur", "SG": "Asia/Singapore",
    "PH": "Asia/Manila", "PL": "Europe/Warsaw", "PT": "Europe/Lisbon",
}


def resolve_timezone(country: str, city: str | None) -> str:
    """国家 ISO 码 → IANA 时区名。多时区国家：city 匹配 > 主要时区 > 第一个。"""
    country = country.strip().upper()
    zones = pytz.country_timezones.get(country)
    if not zones:
        raise SystemExit(f"[send_window] 无法解析国家码: {country!r}")
    if city:
        cl = city.lower().replace(" ", "_")
        for z in zones:
            if cl in z.lower():
                return z
    if country in PRIMARY_TZ:
        return PRIMARY_TZ[country]
    return zones[0]


def next_window(now: datetime.datetime) -> datetime.datetime:
    """下一个 8:00 窗口（跳过周末）。"""
    nxt = now.replace(hour=WINDOW_START, minute=0, second=0, microsecond=0)
    if now.hour >= WINDOW_END:
        nxt += datetime.timedelta(days=1)
    while nxt.weekday() >= 5:  # 5=周六 6=周日
        nxt += datetime.timedelta(days=1)
    return nxt


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="邮件发送窗口检查")
    p.add_argument("--country", required=True, help="买家国家 ISO 码，如 BR / US / DE")
    p.add_argument("--city", default=None, help="买家城市（多时区国家时辅助定位）")
    args = p.parse_args(argv)

    tz_name = resolve_timezone(args.country, args.city)
    tz = pytz.timezone(tz_name)
    now = datetime.datetime.now(tz)

    is_weekend = now.weekday() >= 5
    in_window = (not is_weekend) and (WINDOW_START <= now.hour < WINDOW_END)

    if in_window:
        print(
            f"[send_window] ✅ 可发送 | 买家当地 {now:%A} {now:%H:%M}"
            f"（时区 {tz_name}），在 {WINDOW_START}:00-{WINDOW_END}:00 窗口内"
        )
        return 0

    reason = "非工作日" if is_weekend else f"当地 {now:%H:%M} 不在 {WINDOW_START}:00-{WINDOW_END}:00"
    nxt = next_window(now)
    print(
        f"[send_window] ❌ 阻断 | 买家当地 {now:%A} {now:%H:%M}"
        f"（时区 {tz_name}），{reason}"
    )
    print(f"[send_window] 预计可发送时间：{nxt:%Y-%m-%d %A %H:%M}（当地）")
    return 1


if __name__ == "__main__":
    sys.exit(main())
