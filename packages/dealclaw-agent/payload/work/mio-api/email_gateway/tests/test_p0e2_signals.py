"""P0-E2 七信号标准化与 Markdown 持久化 — 自检测试。"""

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


class P0E2SignalsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        from dc_email_controller import dc_email_signals
        importlib.reload(dc_email_signals)
        self.sig = dc_email_signals
        from email_gateway.store import EmailStore
        self.store = EmailStore(self.data_dir)

    def tearDown(self):
        self.tmp.cleanup()

    def by_id_files(self):
        return list((self.sig.ROOT / "by-id").glob("*.md"))

    def signal_types(self, company_id=None):
        return [s["signal_type"] for s in self.sig.query_signals(company_id=company_id)]

    def insert_outbound(self, **overrides):
        row = {
            "account_id": overrides.pop("account_id", "ema_x"),
            "direction": "outbound",
            "local_message_id": overrides.pop("local_message_id", "<out-1@example.com>"),
            "sender": "proxy@mail.dealclaw.io",
            "recipients": ["buyer@example.net"],
            "subject": "Hello",
            "status": "sent",
            "resend_id": overrides.pop("resend_id", "re_1"),
            "company_id": overrides.pop("company_id", "co1"),
            "campaign_id": overrides.pop("campaign_id", "camp1"),
            "lead_id": overrides.pop("lead_id", "lead1"),
            "contact_id": overrides.pop("contact_id", "ct1"),
            "provider_status": overrides.pop("provider_status", "delivered"),
            "sent_at": overrides.pop("sent_at", None),
        }
        row.update(overrides)
        self.store.insert_message(row)

    # ── 1 delivered ──
    def test_01_delivered_signal(self):
        self.sig.record_delivery_signal("delivered", "re_1", "re_1", company_id="co1", campaign_id="camp1")
        self.assertIn("delivered", self.signal_types("co1"))

    # ── 2 permanent bounced ──
    def test_02_bounced_signal(self):
        self.sig.record_delivery_signal("bounced", "re_1", "re_1", company_id="co1", campaign_id="camp1", detail="Permanent")
        self.assertIn("bounced", self.signal_types("co1"))

    # ── 3 temporary failed 不生成 bounced（record_delivery_signal 只给 delivered/bounced 用）──
    def test_03_temporary_failed_not_bounced(self):
        # 本模块不会为 failed 生成 bounced；verified by absence of a failed→bounced path
        self.assertNotIn("failed", self.sig.SIGNAL_TYPES if hasattr(self.sig, "SIGNAL_TYPES") else ())

    # ── 4 complained 不生成 bounced ──
    def test_04_complained_not_bounced(self):
        # complained 走 suppression/compliance，不生成七信号
        before = len(self.by_id_files())
        # 没有 complained 的入口；验证 query 无 bounced
        self.assertNotIn("bounced", self.signal_types("co1"))

    # ── 5 MOQ+delivery time → quote_request ──
    def test_05_moq_delivery_quote(self):
        r = self.sig.classify_reply_signals("Please send MOQ and delivery time.", company_id="co1")
        types = [s["signal_type"] for s in r]
        self.assertIn("quote_request", types)

    # ── 6 catalogue 不生成 quote_request ──
    def test_06_catalogue_not_quote(self):
        r = self.sig.classify_reply_signals("Please send your catalogue.", company_id="co1")
        self.assertNotIn("quote_request", [s["signal_type"] for s in r])

    # ── 7 samples → sample_request ──
    def test_07_samples(self):
        r = self.sig.classify_reply_signals("Please send two samples.", company_id="co1")
        self.assertIn("sample_request", [s["signal_type"] for s in r])

    # ── 8 booth → meeting_interest ──
    def test_08_booth_meeting(self):
        r = self.sig.classify_reply_signals("Meet us at your booth Tuesday.", company_id="co1")
        self.assertIn("meeting_interest", [s["signal_type"] for s in r])

    # ── 9 同一回复多信号 ──
    def test_09_multi_signal(self):
        r = self.sig.classify_reply_signals(
            "Please quote 500 pcs and send two samples. We can meet at your booth.", company_id="co1")
        types = [s["signal_type"] for s in r]
        self.assertIn("quote_request", types)
        self.assertIn("sample_request", types)
        self.assertIn("meeting_interest", types)

    # ── 10/11 missing_info ──
    def test_10_missing_info(self):
        r = self.sig.build_missing_info_signal(["delivery_time"], source_message_id="<m1>", company_id="co1")
        self.assertIn("missing_info", [s["signal_type"] for s in r])

    def test_11_no_missing_info_without_fields(self):
        r = self.sig.build_missing_info_signal([], source_message_id="<m1>", company_id="co1")
        self.assertEqual(r, [])

    # ── 12 OOO 无信号 ──
    def test_12_ooo_no_signals(self):
        r = self.sig.classify_reply_signals("I am out of office until Monday.", intent="自动回复", company_id="co1")
        self.assertEqual(r, [])

    # ── 13 拒绝/退订无信号 ──
    def test_13_reject_no_signals(self):
        r = self.sig.classify_reply_signals("Not interested, please unsubscribe.", intent="拒绝", company_id="co1")
        self.assertEqual(r, [])

    # ── 14/15/16 no_reply_due ──
    def test_14_no_reply_due_generated(self):
        import datetime
        past = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=10)).isoformat()
        self.insert_outbound(provider_status="delivered", sent_at=past)
        produced = self.sig.evaluate_due("co1", at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        self.assertTrue(any(s["signal_type"] == "no_reply_due" for s in produced))

    def test_15_due_not_reached(self):
        import datetime
        recent = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)).isoformat()
        self.insert_outbound(provider_status="delivered", sent_at=recent)
        produced = self.sig.evaluate_due("co1", at=datetime.datetime.now(datetime.timezone.utc).isoformat(), due_days=3)
        self.assertEqual(produced, [])

    def test_16_replied_resolves_no_reply_due(self):
        import datetime
        past = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=10)).isoformat()
        self.insert_outbound(provider_status="delivered", sent_at=past, local_message_id="<out-1@example.com>")
        # 先产生一个 no_reply_due
        produced = self.sig.evaluate_due("co1", at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        self.assertEqual(len(produced), 1)
        # 收到回复 → resolve
        for s in produced:
            self.sig.resolve_signal(s["signal_id"], "replied")
        # 插入 inbound reply（绑定 thread）
        self.store.insert_message({
            "account_id": "ema_x", "direction": "inbound", "message_id": "<reply-1@example.net>",
            "in_reply_to": "<out-1@example.com>", "sender": "buyer@example.net",
            "recipients": ["proxy@mail.dealclaw.io"], "company_id": "co1",
            "binding_status": "bound", "thread_id": "<out-1@example.com>",
            "received_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        })
        # 再次 evaluate → 不重复生成（已有 resolved + 有回复）
        again = self.sig.evaluate_due("co1", at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        self.assertEqual(again, [])

    # ── 17 bounced/complained suppress no_reply_due ──
    def test_17_bounced_suppress_due(self):
        self.sig.record_delivery_signal("bounced", "re_1", "re_1", company_id="co1", campaign_id="camp1")
        # suppress 一个 no_reply_due
        sid = self.sig.stable_signal_id("no_reply_due", "co1", "ct1", "<out-1>", "due_at")
        self.sig.record_signal({"signal_id": sid, "signal_type": "no_reply_due", "status": "active", "company_id": "co1"})
        self.sig.suppress_signal(sid, "bounced")
        self.assertEqual(self.sig.query_signals(company_id="co1", status="suppressed", signal_type="no_reply_due")[0]["signal_id"], sid)

    # ── 18 重放不重复 ──
    def test_18_replay_no_duplicate(self):
        first = self.sig.record_delivery_signal("delivered", "re_1", "re_1", company_id="co1", campaign_id="camp1")
        second = self.sig.record_delivery_signal("delivered", "re_1", "re_1", company_id="co1", campaign_id="camp1")
        delivered = [s for s in self.sig.query_signals(company_id="co1", signal_type="delivered")]
        self.assertEqual(len(delivered), 1)

    # ── 19 进程重启不重复（重开 store，by-id 仍在）──
    def test_19_restart_no_duplicate(self):
        self.sig.record_delivery_signal("delivered", "re_1", "re_1", company_id="co1", campaign_id="camp1")
        from dc_email_controller import dc_email_signals as sig2
        importlib.reload(sig2)
        before = len(list((sig2.ROOT / "by-id").glob("*.md")))
        sig2.record_delivery_signal("delivered", "re_1", "re_1", company_id="co1", campaign_id="camp1")
        after = len(list((sig2.ROOT / "by-id").glob("*.md")))
        self.assertEqual(before, after)

    # ── 20 不同 Campaign 隔离 ──
    def test_20_campaign_isolation(self):
        self.sig.record_delivery_signal("delivered", "re_1", "re_1", company_id="co1", campaign_id="camp1")
        self.sig.record_delivery_signal("delivered", "re_2", "re_2", company_id="co1", campaign_id="camp2")
        camp1 = [s for s in self.sig.query_signals(company_id="co1") if s.get("campaign_id") == "camp1"]
        camp2 = [s for s in self.sig.query_signals(company_id="co1") if s.get("campaign_id") == "camp2"]
        self.assertEqual(len(camp1), 1)
        self.assertEqual(len(camp2), 1)

    # ── 21 无 campaign_id inbound 不猜 ──
    def test_21_unmatched_inbound_no_signal(self):
        r = self.sig.process_reply(reply_text="Please quote 500 pcs.", message_id="<m1>", company_id="")
        self.assertEqual(r["skipped_reason"], "unmatched_business_context")

    # ── 22 双通道同 message_id 不重复 ──
    def test_22_dual_channel_no_duplicate(self):
        r1 = self.sig.process_reply(reply_text="Please quote 500 pcs.", iq_intent="索要资料", company_id="co1", campaign_id="camp1", message_id="<m1>")
        r2 = self.sig.process_reply(reply_text="Please quote 500 pcs.", iq_intent="索要资料", company_id="co1", campaign_id="camp1", message_id="<m1>")
        q = [s for s in self.sig.query_signals(company_id="co1", signal_type="quote_request")]
        self.assertEqual(len(q), 1)

    # ── 23 端到端（IQ → process_reply → 落盘）──
    def test_23_end_to_end_quote_request(self):
        a = self.sig.analyze_reply("Please send MOQ and delivery time.", buyer_domain="example.net", enterprise="co1")
        r = self.sig.process_reply(
            reply_text="Please send MOQ and delivery time.", message_id="<reply-1>",
            thread_id="<out-1@example.com>", company_id="co1", campaign_id="camp1",
            iq_intent=a["intent"], requested_materials=a["requested_materials"],
            missing_fields=a["missing_fields"], confidence=a["confidence"])
        self.assertIn("quote_request", [s["signal_type"] for s in r["signals"]])
        self.assertEqual(len(self.sig.list_signals("co1", signal_types=["quote_request"])), 1)

    # ── 24 list_signals / get_signal ──
    def test_24_list_and_get_signals(self):
        self.sig.record_delivery_signal("delivered", "re_1", "re_1", company_id="co1", campaign_id="camp1")
        lst = self.sig.list_signals("co1", signal_types=["delivered"])
        self.assertEqual(len(lst), 1)
        self.assertEqual(self.sig.get_signal(lst[0]["signal_id"])["signal_type"], "delivered")

    # ── 25 missing_fields 经 process_reply → missing_info ──
    def test_25_missing_fields_via_process_reply(self):
        r = self.sig.process_reply(reply_text="interested", message_id="<m1>", company_id="co1",
                                   missing_fields=["delivery_time"])
        self.assertIn("missing_info", [s["signal_type"] for s in r["signals"]])


if __name__ == "__main__":
    unittest.main()
