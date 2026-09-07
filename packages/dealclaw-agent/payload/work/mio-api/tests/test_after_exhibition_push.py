#!/usr/bin/env python3
"""test_after_exhibition_push.py — 展后推荐自动推送调度纯函数测试。

覆盖：配置读取（优先级/回退/非法值）、时区回退、幂等键、数据就绪（watermark）、
静默判断、manual 命名空间、recommendation_version 变化不重复推送。
"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_after_exhibition_push import (  # noqa: E402
    DEFAULT_CONFIG,
    decide_push_type,
    should_send,
    build_reminder,
    is_data_ready,
    should_push,
    delivery_key,
    manual_delivery_key,
    scheduled_local_date,
    resolve_config,
    resolve_timezone,
)
from dc_after_exhibition_recommend import recommend  # noqa: E402

# 墨西哥城（UTC-6，无夏令时）。闭展 18:00 UTC = 墨西哥 12:00。
EXHIBITION = {
    "exhibition_id": "exh_2026_mexico",
    "end_at": "2026-09-10T18:00:00+00:00",
    "timezone": "America/Mexico_City",
}
IDEAL = {"products": ["outdoor furniture"]}
ENABLED = {"enabled": True}

# 数据同步 ready（watermark 覆盖闭展时间）
SYNC_READY = {
    "status": "completed",
    "synced_through": "2026-09-10T19:00:00+00:00",
    "exhibition_id": "exh_2026_mexico",
    "records": 3,
}


def _utc(s):
    return datetime.fromisoformat(s)


def _buyer(**kw):
    base = {
        "companyCdpId": "cdp_1", "companyName": "Casa Outdoor", "country": "MX",
        "website": "www.casaoutdoor.mx", "exhibition_id": "exh_2026_mexico",
        "source": "after-exhibition-recommend", "product_tags": ["outdoor furniture"],
        "confirmed_onsite": True, "has_contact": True,
    }
    base.update(kw)
    return base


# ─────────────────────────────────────────────────────────────
# 配置读取
# ─────────────────────────────────────────────────────────────

class TestConfigReading(unittest.TestCase):
    def test_1_exhibition_overrides_tenant(self):
        """展会 meta 配置覆盖企业/租户配置。"""
        tenant = {"d1_push": False, "enabled": True, "close_day_push": False}
        exh = {"d1_push": True}
        cfg, errs = resolve_config(exh, tenant)
        self.assertTrue(cfg["d1_push"])          # 展会级覆盖租户
        self.assertTrue(cfg["enabled"])          # 租户级保留
        self.assertFalse(cfg["close_day_push"])  # 租户级生效
        self.assertEqual(errs, [])

    def test_2_missing_uses_default(self):
        """配置缺失 → 用 DEFAULT_CONFIG。"""
        cfg, errs = resolve_config({}, {})
        self.assertEqual(cfg, DEFAULT_CONFIG)
        self.assertEqual(errs, [])
        self.assertFalse(cfg["enabled"])  # 生产默认关闭

    def test_3_invalid_value_fallback(self):
        """配置字段非法 → 使用默认值并记录错误。"""
        cfg, errs = resolve_config({"enabled": "yes", "followup_reminder_days": "abc"},
                                   {"d1_push": 1, "timezone": 123})
        self.assertFalse(cfg["enabled"])                    # "yes" 非法 → 默认 False
        self.assertEqual(cfg["followup_reminder_days"], [2, 3])  # "abc" 非法 → 默认
        self.assertTrue(cfg["d1_push"])                     # 1 非法 → 默认 True
        self.assertEqual(cfg["timezone"], "")               # 123 非法 → 默认 ""
        self.assertTrue(len(errs) >= 4)                     # 记录 4 条错误

    def test_4_timezone_exhibition_first(self):
        """timezone 优先 exhibition.timezone。"""
        tz, warns = resolve_timezone({"timezone": "America/Mexico_City"}, {"timezone": "Asia/Shanghai"})
        self.assertEqual(tz, "America/Mexico_City")
        self.assertEqual(warns, [])

    def test_5_timezone_tenant_fallback(self):
        """缺失 exhibition.timezone → 回退企业 timezone。"""
        tz, warns = resolve_timezone({}, {"timezone": "Asia/Shanghai"})
        self.assertEqual(tz, "Asia/Shanghai")
        self.assertEqual(warns, [])

    def test_6_timezone_default_warning(self):
        """都缺失 → 回退 Asia/Shanghai 并输出 warning。"""
        tz, warns = resolve_timezone({}, {})
        self.assertEqual(tz, "Asia/Shanghai")
        self.assertTrue(any("Asia/Shanghai" in w for w in warns))

    def test_7_timezone_invalid_warning(self):
        """非法时区名 → 回退 Asia/Shanghai 并告警。"""
        tz, warns = resolve_timezone({"timezone": "Not/AZone"}, {})
        self.assertEqual(tz, "Asia/Shanghai")
        self.assertTrue(any("非法" in w for w in warns))


# ─────────────────────────────────────────────────────────────
# 幂等键
# ─────────────────────────────────────────────────────────────

class TestDeliveryKey(unittest.TestCase):
    def test_8_key_uses_scheduled_local_date(self):
        """delivery_key = exhibition_id + push_type + scheduled_local_date。"""
        sld = scheduled_local_date(EXHIBITION, "d1")  # 闭展日 09-10 → d1 = 09-11
        self.assertEqual(sld, "2026-09-11")
        self.assertEqual(delivery_key("exh_2026_mexico", "d1", sld),
                         "exh_2026_mexico:d1:2026-09-11")

    def test_9_version_change_no_resend(self):
        """recommendation_version 变化 → delivery_key 不变（代码升级不重发）。"""
        # delivery_key 与版本无关，只依赖 exhibition_id + push_type + scheduled_local_date
        k1 = delivery_key("exh_1", "close_day", "2026-09-10")
        k2 = delivery_key("exh_1", "close_day", "2026-09-10")
        self.assertEqual(k1, k2)
        # 版本字符串完全不在键里
        self.assertNotIn("v2", k1)

    def test_10_manual_key_separate_namespace(self):
        """manual 触发用独立命名空间，不占用自动推送键。"""
        auto = delivery_key("exh_1", "d1", "2026-09-11")
        manual = manual_delivery_key("exh_1", "2026-09-11")
        self.assertNotEqual(auto, manual)
        self.assertIn("manual", manual)
        self.assertNotIn(":d1:", manual)


# ─────────────────────────────────────────────────────────────
# 数据就绪（watermark）
# ─────────────────────────────────────────────────────────────

class TestDataReady(unittest.TestCase):
    def test_11_api_error_not_ready(self):
        """接口异常 → 不 ready（延迟，不误报 0 家）。"""
        ready, reason = is_data_ready({"api_error": True}, EXHIBITION)
        self.assertFalse(ready)
        self.assertEqual(reason, "api_error")

    def test_12_sync_incomplete_not_ready(self):
        """同步未完成 → 不 ready。"""
        ready, reason = is_data_ready({"sync_incomplete": True}, EXHIBITION)
        self.assertFalse(ready)
        self.assertEqual(reason, "sync_incomplete")

    def test_13_watermark_before_end_delay(self):
        """synced_through < end_at → 延迟。"""
        sync = {"status": "completed", "synced_through": "2026-09-10T17:00:00+00:00",
                "exhibition_id": "exh_2026_mexico", "records": 3}
        ready, reason = is_data_ready(sync, EXHIBITION)
        self.assertFalse(ready)
        self.assertEqual(reason, "synced_through_before_end")

    def test_14_watermark_covers_end_ready(self):
        """synced_through >= end_at → ready。"""
        ready, reason = is_data_ready(SYNC_READY, EXHIBITION)
        self.assertTrue(ready)
        self.assertEqual(reason, "ready")

    def test_15_exhibition_id_mismatch(self):
        """exhibition_id 与目标不一致 → 延迟。"""
        sync = dict(SYNC_READY, exhibition_id="exh_other")
        ready, reason = is_data_ready(sync, EXHIBITION)
        self.assertFalse(ready)
        self.assertEqual(reason, "exhibition_id_mismatch")

    def test_16_stale_cache_not_ready(self):
        """过期缓存 → 延迟。"""
        ready, reason = is_data_ready({"status": "stale", "records": 3}, EXHIBITION)
        self.assertFalse(ready)
        self.assertEqual(reason, "stale_cache")

    def test_17_zero_records_not_completed_empty(self):
        """records=0 但非 completed_empty → 延迟（不得误报 0 家）。"""
        ready, reason = is_data_ready({"status": "completed", "records": 0}, EXHIBITION)
        self.assertFalse(ready)
        self.assertEqual(reason, "zero_records_not_completed_empty")

    def test_18_completed_empty_ready(self):
        """records=0 且 completed_empty → ready（允许输出空结果）。"""
        ready, reason = is_data_ready({"status": "completed_empty", "records": 0,
                                       "exhibition_id": "exh_2026_mexico"}, EXHIBITION)
        self.assertTrue(ready)
        self.assertEqual(reason, "completed_empty")


# ─────────────────────────────────────────────────────────────
# 时机判断 + 综合发送
# ─────────────────────────────────────────────────────────────

class TestPushScheduling(unittest.TestCase):
    def test_19_ongoing_routes_onsite(self):
        """展会进行中（闭展前）→ 不推展后。"""
        self.assertIsNone(decide_push_type(EXHIBITION, _utc("2026-09-10T17:00:00+00:00"), ENABLED))

    def test_20_close_day_push(self):
        """闭展后 45 分钟 → close_day。"""
        self.assertEqual(decide_push_type(EXHIBITION, _utc("2026-09-10T18:45:00+00:00"), ENABLED), "close_day")
        self.assertIsNone(decide_push_type(EXHIBITION, _utc("2026-09-10T18:29:00+00:00"), ENABLED))
        self.assertEqual(decide_push_type(EXHIBITION, _utc("2026-09-10T18:30:00+00:00"), ENABLED), "close_day")
        self.assertIsNone(decide_push_type(EXHIBITION, _utc("2026-09-10T19:00:00+00:00"), ENABLED))

    def test_21_d1_formal_list(self):
        """D+1 09:30 墨西哥（=15:30 UTC）→ d1。"""
        self.assertEqual(decide_push_type(EXHIBITION, _utc("2026-09-11T15:30:00+00:00"), ENABLED), "d1")

    def test_22_cross_timezone(self):
        """跨时区：用 exhibition.timezone，不是 UTC。"""
        self.assertIsNone(decide_push_type(EXHIBITION, _utc("2026-09-11T15:00:00+00:00"), ENABLED))
        self.assertEqual(decide_push_type(EXHIBITION, _utc("2026-09-11T15:30:00+00:00"), ENABLED), "d1")

    def test_23_disabled_not_send(self):
        """enabled=false → should_send 返回 disabled。"""
        r = should_send(EXHIBITION, _utc("2026-09-10T18:45:00+00:00"), SYNC_READY, None, {})
        self.assertFalse(r["send"])
        self.assertEqual(r["reason"], "disabled")

    def test_24_send_ok(self):
        """全部就绪 → send=True，带 delivery_key。"""
        r = should_send(EXHIBITION, _utc("2026-09-10T18:45:00+00:00"), SYNC_READY, {}, ENABLED)
        self.assertTrue(r["send"])
        self.assertEqual(r["push_type"], "close_day")
        self.assertEqual(r["delivery_key"], "exh_2026_mexico:close_day:2026-09-10")

    def test_25_already_sent_via_checker(self):
        """sent_checker 命中 → 不重发。"""
        r = should_send(EXHIBITION, _utc("2026-09-10T18:45:00+00:00"), SYNC_READY, {},
                        ENABLED, sent_checker=lambda k: True)
        self.assertFalse(r["send"])
        self.assertEqual(r["reason"], "already_sent")

    def test_26_data_not_ready_delay(self):
        """watermark 未覆盖 → should_send 返回延迟原因。"""
        sync = {"status": "completed", "synced_through": "2026-09-10T17:00:00+00:00",
                "exhibition_id": "exh_2026_mexico", "records": 3}
        r = should_send(EXHIBITION, _utc("2026-09-10T18:45:00+00:00"), sync, {}, ENABLED)
        self.assertFalse(r["send"])
        self.assertEqual(r["reason"], "synced_through_before_end")

    def test_27_d2_quiet_if_no_value(self):
        """D+2 无未处理买家 → 静默。"""
        result = {"uncontacted_recommendations": [], "contacted_but_not_connected": [], "connected_followups": []}
        self.assertFalse(build_reminder(result)["has_value"])
        self.assertFalse(should_push(result, "d2"))

    def test_28_d2_reminder_if_value(self):
        """D+2 有未处理买家 → 提醒。"""
        result = {"uncontacted_recommendations": [{"companyName": "A"}],
                  "contacted_but_not_connected": [], "connected_followups": []}
        self.assertTrue(build_reminder(result)["has_value"])
        self.assertTrue(should_push(result, "d2"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
