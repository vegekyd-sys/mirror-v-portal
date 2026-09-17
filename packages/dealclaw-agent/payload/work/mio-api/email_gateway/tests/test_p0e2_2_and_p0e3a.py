"""P0-E2.2 analyze_only 纯分析 + 真实入口 + P0-E3A Push 决策层（dry-run）— 自检测试。"""

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


class P0E22E3ATests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        from dc_email_controller import dc_email_signals, dc_signal_push
        importlib.reload(dc_email_signals)
        importlib.reload(dc_signal_push)
        self.sig = dc_email_signals
        self.push = dc_signal_push
        from email_gateway.store import EmailStore
        self.store = EmailStore(self.data_dir)
        self.store.add_account(
            enterprise_id="co1", owner_open_id="ou_owner_1",
            email_address="proxy@mail.dealclaw.io", provider="resend",
            secret_ref="env:TEST")
        self.acct_id = self.store.list_accounts(enterprise_id="co1")[0]["account_id"]

    def tearDown(self):
        self.tmp.cleanup()

    def _snapshot(self):
        snap = {}
        if not self.data_dir.exists():
            return snap
        for p in sorted(self.data_dir.rglob("*")):
            rel = str(p.relative_to(self.data_dir))
            if p.is_file():
                st = p.stat()
                snap[rel] = (st.st_size, st.st_mtime_ns)
            else:
                snap[rel] = "<dir>"
        return snap

    def insert_outbound(self, **kw):
        row = {"account_id": kw.pop("account_id", self.acct_id), "direction": "outbound",
               "local_message_id": kw.pop("local_message_id", "<out-1@example.com>"),
               "sender": "proxy@mail.dealclaw.io", "recipients": ["buyer@example.net"],
               "subject": "Hello", "status": "sent",
               "resend_id": kw.pop("resend_id", "re_1"),
               "company_id": kw.pop("company_id", "co1"),
               "campaign_id": kw.pop("campaign_id", "camp1"),
               "lead_id": kw.pop("lead_id", "lead1"),
               "contact_id": kw.pop("contact_id", "ct1"),
               "provider_status": kw.pop("provider_status", "delivered")}
        row.update(kw)
        self.store.insert_message(row)

    def mk_signal(self, signal_type, **kw):
        sid = self.sig.stable_signal_id(signal_type, kw.get("source_message_id", ""), kw.get("campaign_id", "camp1"))
        rec = {"signal_id": sid, "signal_type": signal_type, "status": "active",
               "company_id": "co1", "campaign_id": kw.get("campaign_id", "camp1"),
               "source_message_id": kw.get("source_message_id", ""),
               "evidence": kw.get("evidence", {})}
        self.sig.record_signal(rec)
        return sid

    # ── 阶段一：analyze_only 无副作用 ──
    def test_01_analyze_only_no_side_effect(self):
        from dc_iq_engine import analyze_only
        before = self._snapshot()
        r = analyze_only("Please send me your price list.")
        after = self._snapshot()
        self.assertEqual(before, after)
        self.assertEqual(r["intent"], "索要资料")
        self.assertIn("price", r["requested_materials"])

    def test_02_analyze_only_missing_fields(self):
        from dc_iq_engine import analyze_only
        r = analyze_only("Please send price and samples.", company_context={"available_materials": ["price"]})
        self.assertIn("sample_policy", r["missing_fields"])

    # ── 阶段一：真实入口 ──
    def test_03_webhook_entry_produces_signal(self):
        from dc_email_controller import dc_webhook_handler
        dc_webhook_handler._store = None
        dc_webhook_handler._store_db_path = None
        self.insert_outbound(resend_id="re_1", local_message_id="<out-1@example.com>")
        def fetch(email_id):
            return {"id": email_id, "from": "buyer@example.net",
                    "to": ["proxy@mail.dealclaw.io"], "subject": "Re: Hello",
                    "text": "Please send MOQ and delivery time.",
                    "headers": [{"name": "Message-ID", "value": "<reply-1@example.net>"},
                                {"name": "In-Reply-To", "value": "<out-1@example.com>"}]}
        r = dc_webhook_handler.handle_inbound_event(
            {"email_id": "em_1", "from": "buyer@example.net", "to": ["proxy@mail.dealclaw.io"]}, fetch=fetch)
        self.assertTrue(r["matched"])
        q = self.sig.list_signals("co1", signal_types=["quote_request"])
        self.assertEqual(len(q), 1)

    def test_04_imap_entry_produces_signal_and_no_duplicate(self):
        from email_gateway.imap_sync import ImapSynchronizer
        self.insert_outbound(resend_id="re_1", local_message_id="<out-1@example.com>")
        acct = self.store.get_account("ema_x") if False else self.store.list_accounts(enterprise_id="co1")[0]
        bound = {"company_id": "co1", "campaign_id": "camp1", "lead_id": "lead1",
                 "contact_id": "ct1", "thread_id": "<out-1@example.com>", "local_message_id": "<out-1@example.com>"}
        syncer = ImapSynchronizer(self.store)
        # 两次调用（同 message_id）→ 只 1 条 signal
        syncer._record_reply_fact(acct, bound, "buyer@example.net", "Please send MOQ and delivery time.", "<reply-1@example.net>")
        syncer._record_reply_fact(acct, bound, "buyer@example.net", "Please send MOQ and delivery time.", "<reply-1@example.net>")
        q = self.sig.list_signals("co1", signal_types=["quote_request"])
        self.assertEqual(len(q), 1)

    # ── 阶段二：Push 决策 ──
    def test_05_quote_one_realtime_candidate(self):
        self.mk_signal("quote_request", source_message_id="<m1>")
        out = self.push.run("co1")
        cands = [c for c in out["candidates"] if c["category"] == "opportunity"]
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0]["delivery_mode"], "realtime")

    def test_06_multi_signal_merged_one_candidate(self):
        self.mk_signal("quote_request", source_message_id="<m1>")
        self.mk_signal("sample_request", source_message_id="<m1>")
        self.mk_signal("meeting_interest", source_message_id="<m1>")
        self.mk_signal("missing_info", source_message_id="<m1>", evidence={"missing_fields": ["delivery_time"]})
        out = self.push.run("co1")
        cands = [c for c in out["candidates"] if c["category"] == "opportunity"]
        self.assertEqual(len(cands), 1)
        self.assertEqual(set(cands[0]["signals"]), {"quote_request", "sample_request", "meeting_interest", "missing_info"})
        self.assertIn("delivery_time", cands[0]["missing_fields"])

    def test_07_meeting_highest_priority_pre_show(self):
        self.mk_signal("meeting_interest", source_message_id="<m1>")
        out = self.push.run("co1", phase="pre_show")
        cands = [c for c in out["candidates"] if c["category"] == "opportunity"]
        self.assertEqual(cands[0]["priority"], "highest")

    def test_08_delivered_silent(self):
        self.sig.record_delivery_signal("delivered", "re_1", "re_1", company_id="co1", campaign_id="camp1")
        out = self.push.run("co1")
        self.assertEqual([c for c in out["candidates"] if c["category"] == "opportunity"], [])

    def test_09_single_bounced_not_realtime(self):
        # 因 2026-09-14「退信分流」变更：单封退信不再静默，改为每封主动推
        # 「原因 + 下一步动作」的 realtime 候选（方法名沿用历史命名）。
        self.sig.record_delivery_signal("bounced", "re_1", "re_1", company_id="co1", campaign_id="camp1", detail="Permanent")
        out = self.push.run("co1")
        bounce = [c for c in out["candidates"] if c["signals"] == ["bounced"]]
        self.assertEqual(len(bounce), 1)
        self.assertEqual(bounce[0]["category"], "bounce")
        self.assertEqual(bounce[0]["delivery_mode"], "realtime")

    def test_10_no_reply_due_morning(self):
        self.mk_signal("no_reply_due", source_message_id="<out-1>")
        out = self.push.run("co1")
        due = [c for c in out["candidates"] if c["category"] == "followup"]
        self.assertEqual(len(due), 1)
        self.assertEqual(due[0]["delivery_mode"], "morning")

    def test_11_replay_no_duplicate_candidate(self):
        self.mk_signal("quote_request", source_message_id="<m1>")
        self.push.run("co1")
        self.push.run("co1")
        cands = [c for c in self.push.list_candidates("co1") if c["category"] == "opportunity"]
        self.assertEqual(len(cands), 1)

    def test_12_resolved_signal_not_pushed(self):
        sid = self.mk_signal("quote_request", source_message_id="<m1>")
        self.sig.resolve_signal(sid, "handled")
        out = self.push.run("co1")
        self.assertEqual([c for c in out["candidates"] if c["category"] == "opportunity"], [])

    def test_13_no_open_id_still_works(self):
        # 不涉及 open_id，仅凭 company_id/signal 完成决策
        self.mk_signal("quote_request", source_message_id="<m1>")
        out = self.push.run("co1")
        self.assertTrue(out["count"] >= 1)
        self.assertNotIn("open_id", json.dumps(out["candidates"]))


if __name__ == "__main__":
    unittest.main()
