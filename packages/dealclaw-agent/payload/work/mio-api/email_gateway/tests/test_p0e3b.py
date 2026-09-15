"""P0-E3B.1 通知路由接入 + Canary 预演（dry-run）— 自检测试。"""

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))


class P0E3BTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        os.environ["DC_SIGNAL_PUSH_MODE"] = ""
        os.environ["DC_SIGNAL_PUSH_ENABLED"] = ""
        os.environ["DC_SIGNAL_PUSH_ALLOWED_COMPANIES"] = ""
        os.environ["DC_NOTIFY_SENDER_MODE"] = ""
        os.environ["DC_NOTIFY_SEND_ENABLED"] = ""
        os.environ["DC_NOTIFY_ALLOWED_COMPANIES"] = ""
        os.environ.pop("DC_NOTIFY_FEISHU_APP_ID", None)
        from dc_email_controller import dc_email_signals, dc_signal_push
        import dc_notify
        importlib.reload(dc_email_signals)
        importlib.reload(dc_signal_push)
        importlib.reload(dc_notify)
        self.sig = dc_email_signals
        self.push = dc_signal_push
        self.notify = dc_notify

    def tearDown(self):
        self.tmp.cleanup()

    def enable_switches(self, company="testco"):
        os.environ["DC_SIGNAL_PUSH_MODE"] = "feishu"
        os.environ["DC_SIGNAL_PUSH_ENABLED"] = "1"
        os.environ["DC_SIGNAL_PUSH_ALLOWED_COMPANIES"] = company
        os.environ["DC_NOTIFY_SENDER_MODE"] = "feishu"
        os.environ["DC_NOTIFY_SEND_ENABLED"] = "1"
        os.environ["DC_NOTIFY_ALLOWED_COMPANIES"] = company

    def make_candidate(self, company="testco", signal_types=("quote_request",)):
        for st in signal_types:
            sid = self.sig.stable_signal_id(st, "<m1>", "camp1")
            self.sig.record_signal({"signal_id": sid, "signal_type": st, "status": "active",
                                    "company_id": company, "campaign_id": "camp1",
                                    "source_message_id": "<m1>",
                                    "evidence": {"excerpt": "Please send MOQ and delivery time.",
                                                 "missing_fields": ["delivery_time"]}})
        out = self.push.run(company)
        return [c for c in out["candidates"] if c["category"] == "opportunity"][0]

    def engine(self):
        return self.notify.NotifyEngine()

    # 1 route_missing 不发送
    def test_01_route_missing_no_send(self):
        self.enable_switches()
        c = self.make_candidate()
        r = self.push.publish_candidate(c["candidate_id"], dry_run=False)
        self.assertEqual(r["status"], "route_missing")
        self.assertEqual(self.push.get_candidate(c["candidate_id"])["status"], "proposed")

    # 2 company_id 不可作 target
    def test_02_company_id_not_target(self):
        e = self.engine()
        e.set_notification_route("testco", target_type="chat_id", target_id="testco")
        r = e.resolve_notification_route("testco")
        self.assertEqual(r["status"], "route_invalid")

    # 3 open_id 缺 app_id 拒绝
    def test_03_open_id_missing_app_id_rejected(self):
        e = self.engine()
        e.set_notification_route("testco", target_type="open_id", target_id="ou_xxx")
        r = e.resolve_notification_route("testco")
        self.assertEqual(r["status"], "route_invalid")

    # 4 跨 app open_id 拒绝
    def test_04_cross_app_open_id_rejected(self):
        e = self.engine()
        e.set_notification_route("testco", target_type="open_id", target_id="ou_xxx", app_id="cli_other_app")
        r = e.resolve_notification_route("testco")
        self.assertEqual(r["status"], "route_invalid")

    # 5 chat_id 路由成功
    def test_05_chat_id_route_ok(self):
        self.enable_switches()
        self.engine().set_notification_route("testco", target_type="chat_id", target_id="oc_test", label="DealClaw 测试群")
        c = self.make_candidate()
        r = self.push.publish_candidate(c["candidate_id"], dry_run=False)
        self.assertEqual(r["status"], "published")
        self.assertEqual(self.push.get_candidate(c["candidate_id"])["status"], "queued")

    # 6 多信号 candidate 只生成一个 signal_item
    def test_06_multi_signal_one_signal_item(self):
        self.enable_switches()
        self.engine().set_notification_route("testco", target_type="chat_id", target_id="oc_test")
        c = self.make_candidate(signal_types=("quote_request", "sample_request", "meeting_interest", "missing_info"))
        self.push.publish_candidate(c["candidate_id"], dry_run=False)
        pending = self.engine().store.read_pending()
        signal_items = [p for p in pending if p.get("kind") == "signal_item"]
        self.assertEqual(len(signal_items), 1)

    # 7 dry-run 不标 sent
    def test_07_dry_run_not_sent(self):
        self.enable_switches()
        self.engine().set_notification_route("testco", target_type="chat_id", target_id="oc_test")
        c = self.make_candidate()
        r = self.push.publish_candidate(c["candidate_id"], dry_run=True)
        self.assertEqual(r["status"], "dry_run")
        self.assertEqual(self.push.get_candidate(c["candidate_id"])["status"], "proposed")

    # 8 重复 publish 幂等
    def test_08_duplicate_publish_idempotent(self):
        self.enable_switches()
        self.engine().set_notification_route("testco", target_type="chat_id", target_id="oc_test")
        c = self.make_candidate()
        self.push.publish_candidate(c["candidate_id"], dry_run=False)
        self.push.publish_candidate(c["candidate_id"], dry_run=False)  # skip（已 queued）
        pending = self.engine().store.read_pending()
        self.assertEqual(len([p for p in pending if p.get("kind") == "signal_item"]), 1)

    # 9 发送失败保持可重试
    def test_09_failed_retryable(self):
        self.enable_switches()
        self.engine().set_notification_route("testco", target_type="chat_id", target_id="oc_test")
        c = self.make_candidate()
        self.push.publish_candidate(c["candidate_id"], dry_run=False)
        self.push.mark_candidate_failed(c["candidate_id"], "timeout", attempts=1)
        cand = self.push.get_candidate(c["candidate_id"])
        self.assertEqual(cand["status"], "failed")
        self.assertIn("last_error", cand)

    # 10 sent 保存 message_id
    def test_10_sent_saves_message_id(self):
        self.enable_switches()
        self.engine().set_notification_route("testco", target_type="chat_id", target_id="oc_test")
        c = self.make_candidate()
        self.push.publish_candidate(c["candidate_id"], dry_run=False)
        self.push.mark_candidate_sent(c["candidate_id"], "om_test_123")
        cand = self.push.get_candidate(c["candidate_id"])
        self.assertEqual(cand["status"], "sent")
        self.assertEqual(cand["message_id"], "om_test_123")

    # 11 非白名单不发送
    def test_11_not_whitelisted(self):
        self.enable_switches(company="otherco")
        self.engine().set_notification_route("testco", target_type="chat_id", target_id="oc_test")
        c = self.make_candidate(company="testco")
        r = self.push.publish_candidate(c["candidate_id"], dry_run=False)
        self.assertEqual(r["status"], "forced_dry_run")

    # 12 resolved candidate 不发送
    def test_12_resolved_candidate_no_send(self):
        self.enable_switches()
        self.engine().set_notification_route("testco", target_type="chat_id", target_id="oc_test")
        c = self.make_candidate()
        self.sig.resolve_signal(c["candidate_id"] if False else None, "handled")  # no-op guard
        # 直接把 candidate 标 resolved
        self.push._update_candidate(c["candidate_id"], status="resolved")
        r = self.push.publish_candidate(c["candidate_id"], dry_run=False)
        self.assertEqual(r["status"], "skip")

    # 13 消息格式不泄露内部字段
    def test_13_message_no_internal_fields(self):
        self.enable_switches()
        self.engine().set_notification_route("testco", target_type="chat_id", target_id="oc_test")
        c = self.make_candidate(signal_types=("quote_request", "meeting_interest"))
        msg = self.push.format_candidate_message(c)
        for bad in ("signal_id", "confidence", "intent", "candidate_id", "quote_request"):
            self.assertNotIn(bad, msg)


if __name__ == "__main__":
    unittest.main()
