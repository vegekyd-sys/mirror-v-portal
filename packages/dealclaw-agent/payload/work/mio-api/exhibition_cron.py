#!/usr/bin/env python3
"""exhibition_cron.py — DealClaw 展会早晚报 cron 生成器 + 企业ID自动发现。

职责：
1. 企业 ID 自动发现：--company-id 缺省时，从环境 MIO_CDP_SUPPLIER_ID 读（当前租户标识）。
2. 输出早晚报 cron 表达式：
   - 未给 --event：固定北京时区（Asia/Shanghai）9:30 / 17:30
   - 给 --event：从展会城市映射时区，输出展会当地 9:30/17:30 对应的北京时间
     （展会城市从 exhibition_plan_*.csv.txt 展会数据取；当前展会数据无该展会记录时会提示）

用法:
  python3 exhibition_cron.py --company-id <id>
  python3 exhibition_cron.py --company-id <id> --event <event_id>
  python3 exhibition_cron.py                  # company-id 自动读 MIO_CDP_SUPPLIER_ID

输出示例（固定北京时区）:
  {"morning_cron": "30 9 * * 1-5", "evening_cron": "30 17 * * 1-5", "timezone": "Asia/Shanghai", "company_id": "..."}
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import pytz

DEFAULT_TZ = "Asia/Shanghai"
MORNING_TIME = "09:30"
EVENING_TIME = "17:30"
# Cron day-of-week uses 1-5 for Monday through Friday. Existing schedules stay
# registered, but generated early/evening reports never target weekends.
WORKDAYS_CRON = "1-5"

# 展会城市 → IANA 时区（用于 --event 时的时区适配；知识库缺失时兜底用）
CITY_TZ = {
    "sao paulo": "America/Sao_Paulo",
    "sao_paulo": "America/Sao_Paulo",
    "new york": "America/New_York",
    "los angeles": "America/Los_Angeles",
    "london": "Europe/London",
    "berlin": "Europe/Berlin",
    "paris": "Europe/Paris",
    "dubai": "Asia/Dubai",
    "singapore": "Asia/Singapore",
    "tokyo": "Asia/Tokyo",
    "jakarta": "Asia/Jakarta",
}


def resolve_env(key: str) -> str:
    """从脚本目录向上逐级找 .env（work/mio-api/.env 或 workspace/.env）里的 key。"""
    here = os.path.dirname(os.path.abspath(__file__))
    d = here
    while d and d != os.path.dirname(d):
        for env_file in (os.path.join(d, "work", "mio-api", ".env"), os.path.join(d, ".env")):
            if os.path.isfile(env_file):
                with open(env_file, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith(f"{key}="):
                            return line.split("=", 1)[1].strip().strip('"').strip("'")
        d = os.path.dirname(d)
    return ""


def resolve_company_id(explicit: str | None) -> str:
    """企业 ID 自动发现：显式传参优先，否则读 MIO_CDP_SUPPLIER_ID。"""
    if explicit and explicit.strip():
        return explicit.strip()
    sid = resolve_env("MIO_CDP_SUPPLIER_ID") or os.environ.get("MIO_CDP_SUPPLIER_ID", "")
    if sid:
        return sid
    raise SystemExit(
        "[exhibition_cron] 无法自动发现企业 ID：请 --company-id 显式指定，"
        "或确保 .env 里有 MIO_CDP_SUPPLIER_ID"
    )


def event_timezone(event_id: str | None) -> str:
    """展会时区适配：有 event 时尝试映射展会城市时区，否则固定北京。"""
    if not event_id:
        return DEFAULT_TZ
    # 最小可跑：展会城市数据在 exhibition_plan_*.csv.txt，当前无结构化接口，
    # 先用 event_id 里可能带的城市名模糊匹配，匹配不到固定北京。
    e = event_id.lower().replace("-", " ").replace("_", " ")
    for city, tz in CITY_TZ.items():
        if city in e:
            return tz
    return DEFAULT_TZ


def hour_minute(t: str) -> tuple[int, int]:
    h, m = t.split(":")
    return int(h), int(m)


def to_beijing_cron(tz_name: str, local_time: str) -> str:
    """把「某时区 local_time」转成北京时间的工作日 cron 分时。"""
    tz = pytz.timezone(tz_name)
    bj = pytz.timezone(DEFAULT_TZ)
    h, m = hour_minute(local_time)
    # 用今天日期构造当地时间，转北京时间，取北京的分/时
    import datetime
    today = datetime.date.today()
    local_dt = tz.localize(datetime.datetime(today.year, today.month, today.day, h, m))
    bj_dt = local_dt.astimezone(bj)
    return f"{bj_dt.minute} {bj_dt.hour} * * {WORKDAYS_CRON}"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="DealClaw 展会早晚报 cron 生成器")
    p.add_argument("--company-id", default=None, help="企业 ID（缺省自动读 MIO_CDP_SUPPLIER_ID）")
    p.add_argument("--event", default=None, help="展会 event_id（给定则做时区适配，否则固定北京）")
    args = p.parse_args(argv)

    company_id = resolve_company_id(args.company_id)
    tz_name = event_timezone(args.event)

    result = {
        "company_id": company_id,
        "timezone": tz_name,
        "morning_time": MORNING_TIME,
        "evening_time": EVENING_TIME,
        "morning_cron": to_beijing_cron(tz_name, MORNING_TIME),
        "evening_cron": to_beijing_cron(tz_name, EVENING_TIME),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
