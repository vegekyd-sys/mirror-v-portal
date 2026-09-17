"""P0-E3C.1c Resend 直连 source adapter — 自检测试。"""

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))


class ResendSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        os.environ["DC_SIGNAL_PUSH_AUTOMATION_MODE"] = "shadow"
        os.environ["DC_SIGNAL_PUSH_ENABLED_AFTER"] = "2000-01-01T00:00:00+00:00"
        from dc_email_controller import dc_resend_source, dc_email_ingest, dc_webhook_handler
        importlib.reload(dc_webhook_handler)
        importlib.reload(dc_email_ingest)
        importlib.reload(dc_resend_source)
        self.src = dc_resend_source
        self.ingest = dc_email_ingest

    def tearDown(self):
        self.tmp.cleanup()

    def test_01_to_ingest_event(self):
        ev = self.src.to_ingest_event({"id": "r1", "from": "a@b.com", "to": ["x@y.com"], "subject": "S", "created_at": "t"})
        self.assertEqual(ev["event_type"], "email.received")
        self.assertEqual(ev["svix_id"], "resend-poll:received:r1")
        self.assertEqual(ev["payload"]["email_id"], "r1")

    def test_02_to_status_event(self):
        ev = self.src.to_status_event({"id": "s1", "last_event": "delivered", "created_at": "t"})
        self.assertEqual(ev["event_type"], "email.delivered")
        self.assertEqual(ev["svix_id"], "resend-poll:status:s1:delivered")

    @patch("dc_email_controller.dc_resend_source.list_received")
    def test_03_poll_advances_cursor(self, mock_list):
        mock_list.return_value = (200, {"data": [
            {"id": "r1", "created_at": "2026-08-16T00:00:00Z", "from": "a@b.com", "to": ["x@y.com"], "subject": "S"},
        ], "has_more": False})
        with patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest:
            mock_ingest.return_value = {"ok": True, "status": "bound"}
            r = self.src.poll_received_once()
        self.assertTrue(r["ok"])
        self.assertEqual(r["high_water_received_id"], "r1")
        cur = self.src.load_cursor()
        self.assertEqual(cur["high_water_received_id"], "r1")

    @patch("dc_email_controller.dc_resend_source.list_received")
    def test_04_retryable_no_advance(self, mock_list):
        mock_list.return_value = (200, {"data": [
            {"id": "r1", "created_at": "2026-08-16T00:00:00Z", "from": "a@b.com", "to": ["x@y.com"], "subject": "S"},
        ], "has_more": False})
        with patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest:
            mock_ingest.return_value = {"ok": False, "status": "retryable"}
            r = self.src.poll_received_once()
        self.assertEqual(r["high_water_received_id"], None)  # 不前移

    @patch("dc_email_controller.dc_resend_source.list_received")
    def test_06_cba_incremental(self, mock_list):
        self.src.save_cursor("A", "2026-08-16T01:00:00Z", [])
        mock_list.return_value = (200, {"data": [
            {"id": "C", "created_at": "2026-08-16T03:00:00Z", "from": "a@b.com", "to": ["x@y.com"], "subject": "S"},
            {"id": "B", "created_at": "2026-08-16T02:00:00Z", "from": "a@b.com", "to": ["x@y.com"], "subject": "S"},
            {"id": "A", "created_at": "2026-08-16T01:00:00Z", "from": "a@b.com", "to": ["x@y.com"], "subject": "S"},
        ], "has_more": False})
        with patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest:
            mock_ingest.return_value = {"ok": True}
            r = self.src.poll_received_once()
        self.assertEqual([x["received_id"] for x in r["results"]], ["C", "B"])
        self.assertEqual(r["high_water_received_id"], "C")
        self.assertEqual(self.src.load_cursor()["high_water_received_id"], "C")

    @patch("dc_email_controller.dc_resend_source.list_received")
    def test_07_c_success_b_fail_no_advance(self, mock_list):
        self.src.save_cursor("A", "2026-08-16T01:00:00Z", [])
        mock_list.return_value = (200, {"data": [
            {"id": "C", "created_at": "2026-08-16T03:00:00Z", "from": "a@b.com", "to": ["x@y.com"], "subject": "S"},
            {"id": "B", "created_at": "2026-08-16T02:00:00Z", "from": "a@b.com", "to": ["x@y.com"], "subject": "S"},
            {"id": "A", "created_at": "2026-08-16T01:00:00Z", "from": "a@b.com", "to": ["x@y.com"], "subject": "S"},
        ], "has_more": False})
        calls = {"n": 0}
        def fake_ingest(ev):
            calls["n"] += 1
            if calls["n"] == 1:  # C 成功
                return {"ok": True}
            return {"ok": False, "status": "retryable"}  # B 失败
        with patch("dc_email_controller.dc_email_ingest.ingest_resend_event", side_effect=fake_ingest):
            r = self.src.poll_received_once()
        self.assertEqual(r["advanced"], False)  # 不前移
        self.assertEqual(self.src.load_cursor()["high_water_received_id"], "A")

    @patch("dc_email_controller.dc_resend_source.list_received")
    def test_05_duplicate_skipped(self, mock_list):
        # 第一次处理 r1
        mock_list.return_value = (200, {"data": [
            {"id": "r1", "created_at": "2026-08-16T00:00:00Z", "from": "a@b.com", "to": ["x@y.com"], "subject": "S"},
        ], "has_more": False})
        with patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest:
            mock_ingest.return_value = {"ok": True, "status": "bound"}
            self.src.poll_received_once()
        # 第二次同 r1 → 跳过
        with patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest2:
            mock_ingest2.return_value = {"ok": True, "status": "bound"}
            r2 = self.src.poll_received_once()
            self.assertEqual(mock_ingest2.call_count, 0)


class ResendPollerBudgetTests(unittest.TestCase):
    """墙钟预算 + 断点（2026-09-17）：到点收手不丢进度，积压不再报 cursor_gap 卡死。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        from dc_email_controller import dc_resend_source
        importlib.reload(dc_resend_source)
        self.src = dc_resend_source

    def tearDown(self):
        self.tmp.cleanup()
        os.environ.pop("DC_RESEND_SCAN_MAX_PAGES", None)

    @staticmethod
    def _item(rid, created="2026-08-16T03:00:00Z"):
        return {"id": rid, "created_at": created, "from": "a@b.com",
                "to": ["x@y.com"], "subject": "S"}

    def test_deadline_stops_but_keeps_progress(self):
        self.src.save_cursor("A", "2026-08-16T01:00:00Z", [])
        ticks = {"n": 0}

        def fake_clock():
            ticks["n"] += 1
            return ticks["n"] * 5.0

        with patch("dc_email_controller.dc_resend_source.list_received") as mock_list, \
                patch.object(self.src, "_clock", fake_clock), \
                patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest:
            mock_list.return_value = (200, {"data": [self._item("C"), self._item("B"), self._item("A")],
                                            "has_more": False})
            mock_ingest.return_value = {"ok": True}
            r = self.src.poll_received_once(timeout_seconds=15)
        self.assertEqual(r["stopped_reason"], "deadline")
        self.assertTrue(r["partial"])
        self.assertEqual([x["received_id"] for x in r["results"]], ["C"])
        self.assertFalse(r["advanced"])
        self.assertEqual(self.src.load_cursor()["high_water_received_id"], "A")  # 高水位不动
        self.assertIn("C", self.src.load_cursor()["recent_processed_ids"])      # 但进度落盘了

    def test_next_round_finishes_the_job(self):
        self.src.save_cursor("A", "2026-08-16T01:00:00Z", ["C"])
        with patch("dc_email_controller.dc_resend_source.list_received") as mock_list, \
                patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest:
            mock_list.return_value = (200, {"data": [self._item("C"), self._item("B"), self._item("A")],
                                            "has_more": False})
            mock_ingest.return_value = {"ok": True}
            r = self.src.poll_received_once(timeout_seconds=120)
        self.assertEqual([x["received_id"] for x in r["results"]], ["B"])   # C 已被上轮做过
        self.assertEqual(r["high_water_received_id"], "C")
        self.assertTrue(r["advanced"])

    def test_backlog_scan_persists_and_resumes(self):
        self.src.save_cursor("A", "2026-08-16T01:00:00Z", [])

        def pager(limit=50, after=None):
            if after is None:
                return 200, {"data": [self._item("C"), self._item("B")], "has_more": True}
            if after == "B":
                return 200, {"data": [self._item("D"), self._item("E")], "has_more": True}
            # 第二轮：从断点（E）接着往回翻，终于碰到游标
            return 200, {"data": [self._item("F"), self._item("A")], "has_more": False}

        with patch("dc_email_controller.dc_resend_source.list_received", side_effect=pager), \
                patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest:
            mock_ingest.return_value = {"ok": True}
            r1 = self.src.poll_received_once(limit=2, max_pages=2, timeout_seconds=120)
        self.assertTrue(r1["ok"])
        self.assertTrue(r1["scan_in_progress"])
        self.assertFalse(r1["advanced"])
        self.assertEqual(self.src.load_scan()["resume_after"], "E")
        self.assertEqual(self.src.load_scan()["resume_newest"], "C")

        with patch("dc_email_controller.dc_resend_source.list_received", side_effect=pager), \
                patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest2:
            mock_ingest2.return_value = {"ok": True}
            r2 = self.src.poll_received_once(limit=2, max_pages=2, timeout_seconds=120)
        self.assertTrue(r2["advanced"])
        self.assertEqual(r2["high_water_received_id"], "C")   # 扫完才推到窗口最顶端
        self.assertEqual(self.src.load_scan(), {})

    def test_scan_gives_up_after_max_pages(self):
        os.environ["DC_RESEND_SCAN_MAX_PAGES"] = "2"
        self.src.save_cursor("A", "2026-08-16T01:00:00Z", [])

        def pager(limit=50, after=None):
            base = "Z" if after is None else after
            return 200, {"data": [self._item(f"{base}1"), self._item(f"{base}2")], "has_more": True}

        with patch("dc_email_controller.dc_resend_source.list_received", side_effect=pager), \
                patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest:
            mock_ingest.return_value = {"ok": True}
            r = self.src.poll_received_once(limit=2, max_pages=2, timeout_seconds=120)
        self.assertFalse(r["ok"])
        self.assertTrue(r["cursor_gap"])
        self.assertEqual(self.src.load_scan(), {})

    def test_zero_budget_means_no_limit(self):
        self.src.save_cursor("A", "2026-08-16T01:00:00Z", [])
        with patch("dc_email_controller.dc_resend_source.list_received") as mock_list, \
                patch("dc_email_controller.dc_email_ingest.ingest_resend_event") as mock_ingest:
            mock_list.return_value = (200, {"data": [self._item("B"), self._item("A")], "has_more": False})
            mock_ingest.return_value = {"ok": True}
            r = self.src.poll_received_once(timeout_seconds=0)
        self.assertEqual(r["stopped_reason"], "complete")
        self.assertEqual(r["high_water_received_id"], "B")


if __name__ == "__main__":
    unittest.main()
