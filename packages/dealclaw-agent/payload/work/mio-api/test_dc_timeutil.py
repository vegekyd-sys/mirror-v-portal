#!/usr/bin/env python3
"""test_dc_timeutil.py — 规则 [timezone] 回归测试（跨日时区）

运行：cd work/mio-api && python3 test_dc_timeutil.py
"""
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dc_timeutil as t  # noqa: E402


class TestTimezone(unittest.TestCase):
    def test_cross_day_utc_to_shanghai(self):
        # UTC 09-10 17:10 = 上海 09-11 01:10
        self.assertEqual(t.local_date_of("2026-09-10T17:10:00+00:00"), "2026-09-11")
        self.assertEqual(t.local_date_of("2026-09-10T02:00:00+00:00"), "2026-09-10")

    def test_naive_treated_as_utc(self):
        self.assertEqual(t.local_date_of("2026-09-10T17:10:00"), "2026-09-11")

    def test_z_suffix(self):
        self.assertEqual(t.local_date_of("2026-09-10T17:10:00Z"), "2026-09-11")

    def test_today_in_tz(self):
        now = datetime(2026, 9, 10, 17, 10, tzinfo=timezone.utc)
        self.assertEqual(t.today_in_tz("Asia/Shanghai", now), "2026-09-11")

    def test_is_today(self):
        now = datetime(2026, 9, 10, 17, 10, tzinfo=timezone.utc)
        self.assertTrue(t.is_today("2026-09-10T17:30:00+00:00", now=now))
        self.assertFalse(t.is_today("2026-09-09T17:30:00+00:00", now=now))

    def test_bad_input_fallback(self):
        self.assertEqual(t.local_date_of("not-a-date"), "not-a-date")


if __name__ == "__main__":
    unittest.main(verbosity=2)
