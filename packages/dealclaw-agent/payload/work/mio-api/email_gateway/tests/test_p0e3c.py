"""P0-E3C.1 dispatch 回归 + Shadow 灰度 — 自检测试。"""

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


class DispatchRegressionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        os.environ["DC_NOTIFY_ALLOWED_COMPANIES"] = "testco"
        os.environ["DC_NOTIFY_SENDER_MODE"] = ""
        os.environ["DC_NOTIFY_SEND_ENABLED"] = ""
        import dc_notify
        importlib.reload(dc_notify)
        self.notify = dc_notify
        self.sender = dc_notify.MockSender()
        self.eng = dc_notify.NotifyEngine(sender=self.sender)
        self.eng.set_route("testco", "oc_test")

    def tearDown(self):
        self.tmp.cleanup()

    def test_01_signal_item_single_not_merged(self):
        self.eng.publish("testco", "signal_item", payload={"message": "hello 1"}, dedupe_key="signal-push:c1", slot="realtime")
        res = self.eng.dispatch("testco", slot="realtime")
        self.assertEqual(len(res["results"]), 1)
        self.assertEqual(res["results"][0]["status"], "sent")
        self.assertEqual(self.sender.sent[0]["message"], "hello 1")

    def test_02_two_signal_items_sent_separately(self):
        self.eng.publish("testco", "signal_item", payload={"message": "a"}, dedupe_key="signal-push:c1", slot="realtime")
        self.eng.publish("testco", "signal_item", payload={"message": "b"}, dedupe_key="signal-push:c2", slot="realtime")
        res = self.eng.dispatch("testco", slot="realtime")
        self.assertEqual(len(res["results"]), 2)

    def test_03_redispatch_no_dup(self):
        self.eng.publish("testco", "signal_item", payload={"message": "a"}, dedupe_key="signal-push:c1", slot="realtime")
        self.eng.dispatch("testco", slot="realtime")
        res2 = self.eng.dispatch("testco", slot="realtime")
        self.assertEqual(res2["status"], "quiet")

    def test_04_plan_summary_merge_not_regressed(self):
        self.eng.publish("testco", "plan_item", payload={"a": 1}, slot="morning")
        self.eng.publish("testco", "plan_item", payload={"b": 2}, slot="morning")
        res = self.eng.dispatch("testco", slot="morning")
        # 合并成 1 条 batch
        self.assertEqual(len(res["results"]), 1)

    def test_05_message_id_saved(self):
        self.eng.publish("testco", "signal_item", payload={"message": "x"}, dedupe_key="signal-push:c1", slot="realtime")
        res = self.eng.dispatch("testco", slot="realtime")
        self.assertTrue(res["results"][0]["message_id"].startswith("mock_"))
        sent = self.eng.store.read_sent()
        self.assertTrue(any(s.get("message_id", "").startswith("mock_") for s in sent))


class ShadowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        os.environ["DC_SIGNAL_PUSH_AUTOMATION_MODE"] = ""
        os.environ.pop("DC_SIGNAL_PUSH_ENABLED_AFTER", None)
        from dc_email_controller import dc_email_signals, dc_signal_push
        import dc_notify
        importlib.reload(dc_email_signals)
        importlib.reload(dc_signal_push)
        importlib.reload(dc_notify)
        self.sig = dc_email_signals
        self.push = dc_signal_push
        self.notify = dc_notify
        self.notify.NotifyEngine().set_notification_route("testco", target_type="chat_id", target_id="oc_test", label="E2E 测试群")

    def tearDown(self):
        self.tmp.cleanup()

    def mk_signal(self, st, company="testco", mid="<m1>"):
        sid = self.sig.stable_signal_id(st, mid, "camp1")
        self.sig.record_signal({"signal_id": sid, "signal_type": st, "status": "active",
                                "company_id": company, "campaign_id": "camp1",
                                "source_message_id": mid, "evidence": {"excerpt": "test"}})
        return sid

    def test_06_off_no_candidate(self):
        os.environ["DC_SIGNAL_PUSH_AUTOMATION_MODE"] = "off"
        sid = self.mk_signal("quote_request")
        r = self.push.evaluate_for_push([sid])
        self.assertEqual(r["mode"], "off")
        self.assertEqual(r["count"], 0)

    def test_07_requires_enabled_after(self):
        os.environ["DC_SIGNAL_PUSH_AUTOMATION_MODE"] = "shadow"
        sid = self.mk_signal("quote_request")
        r = self.push.evaluate_for_push([sid])
        self.assertTrue(r.get("rejected"))
        self.assertEqual(r["reason"], "enabled_after not configured")

    def test_08_shadow_candidate_fields(self):
        os.environ["DC_SIGNAL_PUSH_AUTOMATION_MODE"] = "shadow"
        os.environ["DC_SIGNAL_PUSH_ENABLED_AFTER"] = "2000-01-01T00:00:00+00:00"
        sid = self.mk_signal("quote_request")
        r = self.push.evaluate_for_push([sid])
        self.assertEqual(r["count"], 1)
        cand = r["candidates"][0]
        self.assertEqual(cand["automation_mode"], "shadow")
        self.assertEqual(cand["status"], "proposed")
        self.assertEqual(cand["would_publish"], True)
        self.assertEqual(cand["blocked_reason"], "shadow_mode")
        self.assertEqual(cand["trigger"], "signal_created")

    def test_09_history_truncation(self):
        os.environ["DC_SIGNAL_PUSH_AUTOMATION_MODE"] = "shadow"
        os.environ["DC_SIGNAL_PUSH_ENABLED_AFTER"] = "2099-01-01T00:00:00+00:00"
        sid = self.mk_signal("quote_request")
        r = self.push.evaluate_for_push([sid])
        self.assertEqual(r["count"], 0)

    def test_10_non_testco_filtered(self):
        os.environ["DC_SIGNAL_PUSH_AUTOMATION_MODE"] = "shadow"
        os.environ["DC_SIGNAL_PUSH_ENABLED_AFTER"] = "2000-01-01T00:00:00+00:00"
        sid = self.mk_signal("quote_request", company="otherco")
        r = self.push.evaluate_for_push([sid])
        self.assertEqual(r["count"], 0)

    def test_11_multi_signal_one_candidate(self):
        os.environ["DC_SIGNAL_PUSH_AUTOMATION_MODE"] = "shadow"
        os.environ["DC_SIGNAL_PUSH_ENABLED_AFTER"] = "2000-01-01T00:00:00+00:00"
        sids = [self.mk_signal(st) for st in ("quote_request", "sample_request", "meeting_interest", "missing_info")]
        r = self.push.evaluate_for_push(sids)
        self.assertEqual(r["count"], 1)


if __name__ == "__main__":
    unittest.main()
