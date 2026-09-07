#!/usr/bin/env python3
"""Regression checks for weekday-only DealClaw morning/evening reports."""

from datetime import datetime
import os
import tempfile
from zoneinfo import ZoneInfo

os.environ["DC_DATA_DIR"] = tempfile.mkdtemp(prefix="dc-weekday-reports-")

from dc_daily_cycle import is_business_day, run_daily_job
from exhibition_cron import to_beijing_cron


def main() -> int:
    shanghai = ZoneInfo("Asia/Shanghai")
    assert to_beijing_cron("Asia/Shanghai", "09:30") == "30 9 * * 1-5"
    assert to_beijing_cron("Asia/Shanghai", "17:30") == "30 17 * * 1-5"
    assert not is_business_day(datetime(2026, 9, 6, 9, 30, tzinfo=shanghai))
    assert is_business_day(datetime(2026, 9, 8, 9, 30, tzinfo=shanghai))

    weekend = run_daily_job(
        "testco", "morning", execute=True, dispatch=True,
        now=datetime(2026, 9, 6, 9, 30, tzinfo=shanghai),
    )
    assert weekend["status"] == "skipped_weekend"
    assert weekend["next_action"] == "resume_next_business_day"
    assert weekend["message_id"] == ""
    print("weekday report scheduling checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
