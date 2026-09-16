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

# 发送窗口模式（2026-09-15）：
#   window     = 常态：不在买家当地工作日 8:00-18:00 就阻断（原行为，默认）
#   exhibition = 展会即时触达：非窗口也**不阻断**，只提示；供展中「邀约到展位」等场景使用
# 可用环境变量 DC_SEND_WINDOW_MODE 覆盖默认（便于按租户/展会期落配置）
import os
import pathlib

MODES = ("window", "exhibition")
DEFAULT_MODE = "window"


def resolve_mode(explicit: str = "") -> str:
    """模式优先级（2026-09-15）：显式参数 > `DC_SEND_WINDOW_MODE` > **展会期自动判定** > window。

    展会期由 `dc_exhibition_mode.py` 按「展会 ID + 日期区间」配置判定；
    展会期内自动切 `exhibition`（窗口不阻断）。判定失败一律回落到 window（不能因为
    读不到展会配置就把常态规则放宽）。
    """
    value = str(explicit or os.environ.get("DC_SEND_WINDOW_MODE", "") or "").strip().lower()
    if value in MODES:
        return value
    try:
        import sys as _sys

        _sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
        from dc_exhibition_mode import in_exhibition_mode  # noqa: PLC0415

        if in_exhibition_mode():
            return "exhibition"
    except Exception:  # noqa: BLE001 - 配置缺失/导入异常都按常态处理
        pass
    return DEFAULT_MODE

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
    p.add_argument("--mode", default="", choices=["", *MODES],
                   help="window=常态窗口判定（默认）；exhibition=展会即时触达（非窗口也放行，仅提示）")
    args = p.parse_args(argv)
    mode = resolve_mode(args.mode)

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

    if mode == "exhibition":
        print(
            f"[send_window] ⚠️ 展会模式放行 | 买家当地 {now:%A} {now:%H:%M}"
            f"（时区 {tz_name}），{reason}"
        )
        print("[send_window] 展会即时触达：不阻断。内容里不要给买家时间承诺（不写“几小时内回”）")
        return 0

    print(
        f"[send_window] ❌ 阻断 | 买家当地 {now:%A} {now:%H:%M}"
        f"（时区 {tz_name}），{reason}"
    )
    print(f"[send_window] 预计可发送时间：{nxt:%Y-%m-%d %A %H:%M}（当地）")
    return 1


if __name__ == "__main__":
    sys.exit(main())
