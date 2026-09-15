"""P0-E4 — 回复草稿（机会 Push → 草稿 → 用户确认 → 发出回复）验收测试。"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway.store import EmailStore
from dc_email_controller.dc_reply_draft import (
    generate_draft, record_draft, get_draft, list_drafts, update_draft,
    parse_send_intent, apply_edit, confirm_and_send,
)


class P0E4ReplyDraftTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        self.store = EmailStore(self.data_dir)
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        os.environ["TEST_EMAIL_SECRET"] = "k"
        os.environ.pop("RESEND_API_KEY", None)
        os.environ["DC_SIGNAL_PUSH_AUTOMATION_MODE"] = "live"
        os.environ["DC_SIGNAL_PUSH_ALLOWED_COMPANIES"] = "testco"
        os.environ["DC_NOTIFY_SENDER_MODE"] = "feishu"
        os.environ["DC_NOTIFY_SEND_ENABLED"] = "1"
        os.environ["DC_NOTIFY_ALLOWED_COMPANIES"] = "testco"

    def tearDown(self):
        self.tmp.cleanup()

    def add_account(self, provider="resend", email="proxy@mail.dealclaw.io"):
        return self.store.add_account(
            enterprise_id="co1", owner_open_id="ou_owner_1",
            email_address=email, provider=provider, secret_ref="env:TEST_EMAIL_SECRET",
        )

    def insert_outbound(self, **overrides):
        row = {
            "account_id": overrides.pop("account_id", "ema_x"),
            "direction": "outbound",
            "message_id": overrides.pop("message_id", "<out-1@example.com>"),
            "sender": overrides.pop("sender", "proxy@mail.dealclaw.io"),
            "recipients": overrides.pop("recipients", ["buyer@example.net"]),
            "subject": overrides.pop("subject", "Hello"),
            "status": "sent",
            "resend_id": overrides.pop("resend_id", "re_1"),
            "company_id": overrides.pop("company_id", "co1"),
            "campaign_id": overrides.pop("campaign_id", "camp1"),
        }
        row.update(overrides)
        self.store.insert_message(row)
        return row

    def _draft(self, **overrides):
        base = dict(company_id="co1", related_reply_id="<reply-1@x.com>",
                    reply_text="please send quotation sample and meeting",
                    buyer="Marco", buyer_email="buyer@x.com")
        base.update(overrides)
        return generate_draft(**base)

    # ── 1 ────────────────────────────────────────────────
    def test_01_high_intent_reply_generates_pending_draft(self):
        d = self._draft()
        self.assertEqual(d["status"], "pending_confirmation")
        self.assertTrue(record_draft(d))
        self.assertEqual(len(list_drafts(company_id="co1", status="pending_confirmation")), 1)

    # ── 2 ────────────────────────────────────────────────
    def test_02_multiple_signals_one_draft(self):
        d1 = self._draft(related_reply_id="<reply-1@x.com>")
        d2 = self._draft(related_reply_id="<reply-1@x.com>")  # 同回复 → 同 draft_id
        self.assertEqual(d1["draft_id"], d2["draft_id"])
        record_draft(d1)
        self.assertFalse(record_draft(d2))  # 幂等
        self.assertEqual(len(list_drafts(company_id="co1")), 1)

    # ── 3 ────────────────────────────────────────────────
    def test_03_missing_info_written(self):
        d = self._draft(missing_fields=["delivery_time"])
        self.assertIn("delivery_time", d["missing_fields"])

    # ── 4 ────────────────────────────────────────────────
    def test_04_kankan_does_not_send(self):
        self.assertEqual(parse_send_intent("看看"), "none")

    # ── 5 ────────────────────────────────────────────────
    def test_05_jixu_does_not_send(self):
        self.assertEqual(parse_send_intent("继续"), "none")
        self.assertEqual(parse_send_intent("可以"), "none")

    # ── 6 ────────────────────────────────────────────────
    def test_06_send_only_on_explicit_send(self):
        for p in ("发送", "确认回复", "发出去", "可以回", "按这个发"):
            self.assertEqual(parse_send_intent(p), "send", p)

    # ── 7 ────────────────────────────────────────────────
    def test_07_edit_requires_reconfirm(self):
        d = self._draft()
        record_draft(d)
        r = apply_edit(d, "改短一点")
        self.assertNotEqual(r["text"], d["text"])
        self.assertEqual(parse_send_intent("改短一点"), "modify")
        # 状态仍 pending，不自动发送
        self.assertEqual(get_draft(d["draft_id"])["status"], "pending_confirmation")

    # ── 8 ────────────────────────────────────────────────
    def test_08_send_success_writes_outbound_and_touch(self):
        account = self.add_account(provider="resend")
        d = self._draft(company_id="co1", account_id=account["account_id"])
        record_draft(d)
        with patch("email_gateway.smtp_send.resend_send", return_value="re_sent"):
            r = confirm_and_send(d["draft_id"], confirmed_by="ou_owner_1", store=self.store)
        self.assertEqual(r["status"], "sent")
        self.assertEqual(r["touch_number"], 1)
        self.assertEqual(get_draft(d["draft_id"])["status"], "sent")
        self.assertIsNotNone(self.store.find_outbound_by_resend_id("re_sent"))

    # ── 9 ────────────────────────────────────────────────
    def test_09_send_failure_no_fake_sent(self):
        account = self.add_account(provider="resend")
        d = self._draft(company_id="co1", account_id=account["account_id"])
        record_draft(d)
        with patch("email_gateway.smtp_send.resend_send", side_effect=RuntimeError("boom")):
            r = confirm_and_send(d["draft_id"], confirmed_by="ou_owner_1", store=self.store)
        self.assertEqual(r["status"], "failed")
        d2 = get_draft(d["draft_id"])
        self.assertEqual(d2["status"], "failed")
        self.assertIn("boom", d2.get("failure_reason", ""))
        self.assertEqual(d2.get("next_action"), "retry_after_review")

    # ── 10 ───────────────────────────────────────────────
    def test_10_multiple_same_contact_no_auto_bind(self):
        account = self.add_account(provider="resend")
        self.insert_outbound(account_id=account["account_id"], resend_id="re_1", message_id="<out-1@example.com>", recipients=["buyer@x.com"])
        self.insert_outbound(account_id=account["account_id"], resend_id="re_2", message_id="<out-2@example.com>", recipients=["buyer@x.com"])
        from dc_email_controller.dc_webhook_handler import _fallback_match_by_contact
        fb = _fallback_match_by_contact(self.store, account["account_id"], "buyer@x.com", "thia@mail.dealclaw.io")
        self.assertEqual(fb["status"], "ambiguous")
        self.assertTrue(fb["need_user"])
        self.assertEqual(len(fb["candidate_outbound_ids"]), 2)

    # ── 11 ───────────────────────────────────────────────
    def test_11_repeat_confirm_no_duplicate_send(self):
        account = self.add_account(provider="resend")
        d = self._draft(company_id="co1", account_id=account["account_id"])
        record_draft(d)
        with patch("email_gateway.smtp_send.resend_send", return_value="re_sent") as m:
            r1 = confirm_and_send(d["draft_id"], confirmed_by="ou_owner_1", store=self.store)
            r2 = confirm_and_send(d["draft_id"], confirmed_by="ou_owner_1", store=self.store)
        self.assertEqual(r1["status"], "sent")
        self.assertEqual(r2["status"], "skip")  # 已 sent，不重复发送
        self.assertEqual(m.call_count, 1)

    # ── 12 ───────────────────────────────────────────────
    def test_12_testco_live_passes(self):
        from dc_email_controller.dc_signal_push import _push_enabled
        self.assertTrue(_push_enabled("testco")[0])

    # ── 13 ───────────────────────────────────────────────
    def test_13_other_enterprises_stay_off(self):
        from dc_email_controller.dc_signal_push import _push_enabled
        self.assertFalse(_push_enabled("meorient.com")[0])

    # ── 14 ───────────────────────────────────────────────
    def test_14_duplicate_webhook_card_no_local_resend(self):
        from dc_email_controller.dc_email_ingest import claim_canonical, mark_canonical_processed, canonical_key
        ckey = canonical_key("email.received", {"email_id": "rcv-dup-1"})
        self.assertEqual(claim_canonical(ckey), "claimed")
        mark_canonical_processed(ckey)
        # 第二来源（旧 webhook 旁路 / poller）重复 → already_processed，不重复处理
        self.assertEqual(claim_canonical(ckey), "already_processed")

    # ── 15 ───────────────────────────────────────────────
    def test_15_draft_inherits_outbound_touch_number(self):
        account = self.add_account(provider="resend")
        # 模拟 outbound 已触达 2 次 → 草稿继承 touch_number=2，回复发出后 +1 → 3
        d = self._draft(company_id="co1", account_id=account["account_id"], touch_number=2)
        self.assertEqual(d["touch_number"], 2)
        record_draft(d)
        with patch("email_gateway.smtp_send.resend_send", return_value="re_sent"):
            r = confirm_and_send(d["draft_id"], confirmed_by="ou_owner_1", store=self.store)
        self.assertEqual(r["touch_number"], 3)
        self.assertEqual(get_draft(d["draft_id"])["touch_number"], 3)


if __name__ == "__main__":
    unittest.main()
