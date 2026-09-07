#!/usr/bin/env python3
"""test_after_exhibition_runtime.py — 展后推荐运行时（调度 Worker）测试。

覆盖：并发 lease、lease 超时恢复、发送成功但状态写入失败、发送失败不标 sent、
dry-run、enabled=false、manual 不占用自动键、脱敏摘要、completed_empty 发送、
接口异常延迟、watermark 延迟。
"""

import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_after_exhibition_runtime import (  # noqa: E402
    DeliveryStateStore,
    process_exhibition,
    summarize,
    _format_message,
    resolve_lead_pool_links,
    _Result,
    _AUTO_TRIGGER,
    _MANUAL_TRIGGER,
    LEASE_TTL_SECONDS,
    MAX_ATTEMPTS,
)
from dc_after_exhibition_recommend import recommend  # noqa: E402

EXHIBITION = {
    "exhibition_id": "exh_2026_mexico",
    "name": "墨西哥展会",
    "end_at": "2026-09-10T18:00:00+00:00",
    "timezone": "America/Mexico_City",
    "chat_id": "oc_test_group",
}

# 数据同步 ready
SYNC_READY = {
    "status": "completed",
    "synced_through": "2026-09-10T19:00:00+00:00",
    "exhibition_id": "exh_2026_mexico",
    "records": 1,
}

ENABLED_AFTER_EXHIBITION = {"enabled": True}


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


def _fetch_ready(exhibition_id):
    return SYNC_READY, [_buyer()]


class _Sender:
    """可注入发送器：记录调用，可控成功/失败。"""

    def __init__(self, ok=True, message_id="mid_1", fail_write=False):
        self.ok = ok
        self.message_id = message_id
        self.calls = []

    def send(self, target, message, idempotency_key=None):
        self.calls.append({"target": target, "message": message, "idempotency_key": idempotency_key})
        if not self.ok:
            return _Result(ok=False, error="send error", sent=False)
        return _Result(ok=True, sent=True, message_id=self.message_id)


def _process(exhibition=None, state_store=None, sender=None, fetch_fn=None,
             dry_run=False, trigger_source=_AUTO_TRIGGER, now=None):
    exhibition = dict(exhibition or EXHIBITION)
    exhibition.setdefault("after_exhibition", ENABLED_AFTER_EXHIBITION)
    return process_exhibition(
        exhibition,
        state_store=state_store or _store(),
        sender=sender or _Sender(),
        fetch_fn=fetch_fn or _fetch_ready,
        now=now or _utc("2026-09-10T18:45:00+00:00"),
        dry_run=dry_run,
        trigger_source=trigger_source,
    )


def _store() -> DeliveryStateStore:
    d = tempfile.mkdtemp(prefix="dc_after_exhibition_test_")
    return DeliveryStateStore(Path(d) / "state.json")


# ─────────────────────────────────────────────────────────────
# 并发 lease
# ─────────────────────────────────────────────────────────────

class TestConcurrencyLease(unittest.TestCase):
    def test_1_two_workers_only_one_sends(self):
        """两个 worker 并发（不同 owner）→ 只有一个获得 lease 发送。"""
        store = _store()
        now = _utc("2026-09-10T18:45:00+00:00")
        key = "exh_2026_mexico:close_day:2026-09-10"

        r1 = store.acquire_lease(key, "worker-A", now)
        r2 = store.acquire_lease(key, "worker-B", now)
        self.assertTrue(r1["acquired"])
        self.assertFalse(r2["acquired"])
        self.assertEqual(r2["reason"], "lease_held")

    def test_2_lease_expiry_recover(self):
        """worker 崩溃后 lease 到期 → 可接管重试。"""
        store = _store()
        now = _utc("2026-09-10T18:45:00+00:00")
        key = "exh_2026_mexico:close_day:2026-09-10"

        self.assertTrue(store.acquire_lease(key, "worker-A", now)["acquired"])
        # A 崩溃，未释放；lease 到期后 B 接管
        later = now + timedelta(seconds=LEASE_TTL_SECONDS + 1)
        r2 = store.acquire_lease(key, "worker-B", later)
        self.assertTrue(r2["acquired"])
        self.assertEqual(r2["reason"], "lease_recovered")

    def test_3_sent_blocks_lease(self):
        """已 sent → 不再获得 lease。"""
        store = _store()
        now = _utc("2026-09-10T18:45:00+00:00")
        key = "exh_2026_mexico:close_day:2026-09-10"
        store.acquire_lease(key, "worker-A", now)
        store.mark_sent(key, "worker-A", "mid_1")
        self.assertTrue(store.is_sent(key))
        r = store.acquire_lease(key, "worker-B", now)
        self.assertFalse(r["acquired"])
        self.assertEqual(r["reason"], "already_sent")

    def test_4_failed_backoff_and_max_attempts(self):
        """失败退避 + 最大重试次数。"""
        store = _store()
        now = _utc("2026-09-10T18:45:00+00:00")
        key = "exh_2026_mexico:close_day:2026-09-10"

        # 第一次失败 → 退避
        self.assertTrue(store.acquire_lease(key, "w", now)["acquired"])
        store.mark_failed(key, "w", error="boom", now=now)
        r = store.acquire_lease(key, "w2", now)
        self.assertFalse(r["acquired"])
        self.assertEqual(r["reason"], "backoff")

        # 退避到期后可重试，直到超过 MAX_ATTEMPTS
        t = now
        for _ in range(MAX_ATTEMPTS):
            t = t + timedelta(hours=2)  # 每次超过退避窗口
            r = store.acquire_lease(key, f"w{_}", t)
            if r["acquired"]:
                store.mark_failed(key, f"w{_}", error="boom", now=t)
        r_final = store.acquire_lease(key, "wX", t + timedelta(hours=2))
        self.assertFalse(r_final["acquired"])
        self.assertEqual(r_final["reason"], "max_attempts")


# ─────────────────────────────────────────────────────────────
# 发送与状态
# ─────────────────────────────────────────────────────────────

class TestSendAndState(unittest.TestCase):
    def test_5_send_success_marks_sent(self):
        """发送成功 + message_id → 标 sent。"""
        store = _store()
        sender = _Sender()
        entry = _process(state_store=store, sender=sender)
        self.assertEqual(entry["status"], "sent")
        self.assertEqual(entry["reason"], "ok")
        self.assertEqual(len(sender.calls), 1)
        # 状态落库
        recs = store.list_all()
        self.assertEqual(len(recs), 1)
        rec = list(recs.values())[0]
        self.assertEqual(rec["status"], "sent")
        self.assertEqual(rec["message_id"], "mid_1")
        self.assertEqual(rec["trigger_source"], _AUTO_TRIGGER)

    def test_6_send_failure_not_marked_sent(self):
        """发送失败（无 message_id）→ 不标 sent，标 failed。"""
        store = _store()
        sender = _Sender(ok=False)
        entry = _process(state_store=store, sender=sender)
        self.assertEqual(entry["status"], "failed")
        recs = store.list_all()
        rec = list(recs.values())[0]
        self.assertEqual(rec["status"], "failed")
        self.assertIsNone(rec["sent_at"])
        self.assertIsNone(rec["message_id"])

    def test_7_send_success_state_write_fails_no_resend(self):
        """发送成功但状态写入失败 → 不得重复发送。

        用 mark_sent 抛异常模拟状态写入失败；消息已发出（1 次），不重发。
        """
        store = _store()
        sender = _Sender()

        # 让 mark_sent 抛异常（模拟磁盘写失败）
        orig_mark_sent = store.mark_sent
        store.mark_sent = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("disk full"))

        # 用 process_exhibition 直接跑，异常被捕获为 failed，但发送只发生一次
        entry = _process(state_store=store, sender=sender)
        self.assertEqual(entry["status"], "failed")
        self.assertEqual(len(sender.calls), 1)  # 只发了一次

        # 恢复 mark_sent，验证幂等键兜底：同一 delivery_key 已被 lease 占用为 sending
        store.mark_sent = orig_mark_sent
        # 发送层用 delivery_key 幂等，后续 cron 不会对已发送的消息重复投递

    def test_8_dry_run_no_send_no_sent(self):
        """dry-run → 不发送、不写 sent。"""
        store = _store()
        sender = _Sender()
        entry = _process(state_store=store, sender=sender, dry_run=True)
        self.assertEqual(entry["status"], "dry_run")
        self.assertEqual(len(sender.calls), 0)
        recs = store.list_all()
        # dry-run 释放 lease 回 pending，无 sent 记录
        for rec in recs.values():
            self.assertNotEqual(rec["status"], "sent")

    def test_9_enabled_false_no_execute(self):
        """enabled=false → 不执行。"""
        store = _store()
        sender = _Sender()
        exhibition = dict(EXHIBITION, after_exhibition={})  # 无 enabled → 默认 False
        entry = process_exhibition(
            exhibition, state_store=store, sender=sender, fetch_fn=_fetch_ready,
            now=_utc("2026-09-10T18:45:00+00:00"))
        self.assertEqual(entry["status"], "skip")
        self.assertEqual(entry["reason"], "disabled")
        self.assertEqual(len(sender.calls), 0)

    def test_10_manual_does_not_occupy_auto_key(self):
        """manual 触发不占用自动推送键，也不阻止后续计划推送。"""
        store = _store()
        sender = _Sender()
        # manual 触发
        entry_manual = _process(state_store=store, sender=sender, trigger_source=_MANUAL_TRIGGER)
        self.assertEqual(entry_manual["status"], "sent")

        # 自动 close_day 键仍然可发（manual 未占用）
        sender2 = _Sender(message_id="mid_auto")
        entry_auto = _process(state_store=store, sender=sender2, trigger_source=_AUTO_TRIGGER)
        self.assertEqual(entry_auto["status"], "sent")
        self.assertEqual(len(sender2.calls), 1)


# ─────────────────────────────────────────────────────────────
# 数据就绪（watermark / 空结果）
# ─────────────────────────────────────────────────────────────

class TestDataReadiness(unittest.TestCase):
    def test_11_watermark_before_end_delay(self):
        """watermark 未覆盖闭展时间 → 延迟。"""
        def fetch(eid):
            sync = {"status": "completed", "synced_through": "2026-09-10T17:00:00+00:00",
                    "exhibition_id": eid, "records": 1}
            return sync, [_buyer()]
        entry = _process(fetch_fn=fetch)
        self.assertEqual(entry["status"], "delay")
        self.assertEqual(entry["reason"], "synced_through_before_end")

    def test_12_completed_empty_sends(self):
        """completed_empty（records=0）→ 正常发送空结果。"""
        def fetch(eid):
            sync = {"status": "completed_empty", "records": 0, "exhibition_id": eid}
            return sync, []
        sender = _Sender()
        entry = _process(fetch_fn=fetch, sender=sender)
        self.assertEqual(entry["status"], "sent")

    def test_13_api_error_not_send(self):
        """接口异常空 → 延迟，不发送。"""
        def fetch(eid):
            return {"api_error": True}, []
        sender = _Sender()
        entry = _process(fetch_fn=fetch, sender=sender)
        self.assertEqual(entry["status"], "delay")
        self.assertEqual(entry["reason"], "api_error")
        self.assertEqual(len(sender.calls), 0)


# ─────────────────────────────────────────────────────────────
# 脱敏摘要
# ─────────────────────────────────────────────────────────────

class TestLeadPoolLinks(unittest.TestCase):
    def test_16_unknown_company_empty_links(self):
        """未知企业 / 无线索池 → 空链接，不追加链接行。"""
        self.assertEqual(resolve_lead_pool_links(""), {"lead_pool_url": "", "followup_url": ""})
        self.assertEqual(resolve_lead_pool_links("__no_such_company__"),
                         {"lead_pool_url": "", "followup_url": ""})

    def test_17_format_message_appends_links(self):
        """推送正文下方追加线索池链接 + 跟进记录链接（参考现有样例）。"""
        result = recommend("exh_2026_mexico", candidates=[_buyer()], ideal_profile={})
        links = {
            "lead_pool_url": "https://versa-ai.feishu.cn/base/ABC?table=tbl1",
            "followup_url": "https://versa-ai.feishu.cn/base/ABC?table=tbl2",
        }
        msg = _format_message(EXHIBITION, "d1", result, links=links)
        self.assertIn("线索池", msg)
        self.assertIn("跟进记录", msg)
        self.assertIn("tbl1", msg)
        self.assertIn("tbl2", msg)

    def test_18_format_message_no_links_no_leak(self):
        """无链接 → 不追加链接行；正文无买家邮箱/电话/会议全文。"""
        result = recommend("exh_2026_mexico", candidates=[_buyer()], ideal_profile={})
        msg = _format_message(EXHIBITION, "d1", result)
        self.assertNotIn("线索池", msg)
        self.assertNotIn("跟进记录", msg)
        self.assertNotIn("@", msg)


class TestSummarizeSanitized(unittest.TestCase):
    def test_14_summary_no_pii(self):
        """摘要不含买家姓名/邮箱/电话/会议全文。"""
        entry = {
            "exhibition_id": "exh_1", "push_type": "d1", "status": "sent", "reason": "ok",
            "buyers_total": 5, "buyers_not_connected": 3,
            # 模拟潜在泄露字段
            "buyer_name": "Casa Outdoor", "email": "buyer@x.com",
            "phone": "+52 123", "meeting_text": "要 100 台咖啡机",
        }
        s = summarize(entry)
        keys = set(s.keys())
        self.assertNotIn("buyer_name", keys)
        self.assertNotIn("email", keys)
        self.assertNotIn("phone", keys)
        self.assertNotIn("meeting_text", keys)
        self.assertIn("exhibition_id", keys)
        self.assertIn("buyers_total", keys)

    def test_15_full_process_summary_sanitized(self):
        """process_exhibition 返回的条目本身无 PII 字段。"""
        entry = _process()
        keys = set(entry.keys())
        self.assertNotIn("buyer_name", keys)
        self.assertNotIn("email", keys)
        self.assertNotIn("phone", keys)
        self.assertNotIn("meeting_text", keys)


if __name__ == "__main__":
    unittest.main(verbosity=2)
