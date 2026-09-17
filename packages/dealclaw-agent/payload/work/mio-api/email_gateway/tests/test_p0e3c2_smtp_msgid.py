"""P0-E3C.2 — smtp_message_id 回填 / 匹配 / 清理 专门测试。

覆盖：
1. SMTP 发送后回查真实 Message-ID
2. 回查失败不伪造 smtp_message_id
3. 重复回填幂等
4. delivered 状态事件携带 message_id 可以回填
5. Resend poller 携带 message_id 可以回填
6. In-Reply-To 匹配 smtp_message_id
7. References 匹配 smtp_message_id
8. local_message_id 仍然兼容
9. 两个索引都不重复
10. 真实 outbound 不被清理逻辑误删
"""

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
from email_gateway.smtp_send import SmtpSender


class FakeSmtp:
    def __init__(self, *args, **kwargs):
        pass

    def login(self, user, password):
        pass

    def send_message(self, message, to_addrs=None):
        return {}

    def quit(self):
        pass


class P0E3C2SmtpMsgidTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        self.store = EmailStore(self.data_dir)
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        os.environ["TEST_EMAIL_SECRET"] = "k"
        os.environ.pop("RESEND_API_KEY", None)

        from dc_email_controller import dc_webhook_handler
        self.handler = dc_webhook_handler
        self.handler._store = None
        self.handler._store_db_path = None

    def tearDown(self):
        os.environ.pop("TEST_EMAIL_SECRET", None)
        self.tmp.cleanup()

    # ── helpers ──────────────────────────────────────────
    def add_account(self, provider="resend", email="proxy@mail.dealclaw.io", secret_ref="env:TEST_EMAIL_SECRET"):
        return self.store.add_account(
            enterprise_id="co1", owner_open_id="ou_owner_1",
            email_address=email, provider=provider, secret_ref=secret_ref,
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
            "provider_status": overrides.pop("provider_status", "accepted"),
        }
        row.update(overrides)
        self.store.insert_message(row)
        return row

    # ── 1 ────────────────────────────────────────────────
    @patch("email_gateway.smtp_send.time.sleep", return_value=None)
    def test_01_smtp_send_queries_back_real_message_id(self, _sleep):
        account = self.add_account(provider="tencent_exmail", email="smtp@meorient.com")
        sender = SmtpSender(self.store, smtp_ssl_factory=FakeSmtp, secret_resolver=lambda _: "k")
        with patch.object(sender, "_query_smtp_message_id_via_imap",
                          return_value="<real-smtp@meorient.com>"):
            r = sender.send(
                account_id=account["account_id"], confirmed_by="ou_owner_1",
                to=["buyer@example.net"], subject="Hi", text="Body",
                company_id="co1", campaign_id="camp1",
            )
        self.assertTrue(r["ok"])
        ob = self.store.find_outbound_by_reference(account["account_id"], [r["message_id"]])
        self.assertIsNotNone(ob)
        self.assertEqual(ob["smtp_message_id"], "<real-smtp@meorient.com>")

    # ── 2 ────────────────────────────────────────────────
    @patch("email_gateway.smtp_send.time.sleep", return_value=None)
    def test_02_query_failure_does_not_fake_smtp_message_id(self, _sleep):
        account = self.add_account(provider="tencent_exmail", email="smtp@meorient.com")
        sender = SmtpSender(self.store, smtp_ssl_factory=FakeSmtp, secret_resolver=lambda _: "k")
        with patch.object(sender, "_query_smtp_message_id_via_imap", return_value=""):
            r = sender.send(
                account_id=account["account_id"], confirmed_by="ou_owner_1",
                to=["buyer@example.net"], subject="Hi", text="Body",
                company_id="co1", campaign_id="camp1",
            )
        ob = self.store.find_outbound_by_reference(account["account_id"], [r["message_id"]])
        self.assertEqual(ob["smtp_message_id"], "")            # 不冒充
        self.assertEqual(ob["local_message_id"], r["message_id"])  # local 仍是 make_msgid

    # ── 3 ────────────────────────────────────────────────
    def test_03_repeated_backfill_idempotent(self):
        account = self.add_account(provider="resend")
        self.insert_outbound(account_id=account["account_id"], resend_id="re_1")
        self.assertTrue(self.store.backfill_smtp_message_id("re_1", "<smtp-1@example.com>"))
        self.assertFalse(self.store.backfill_smtp_message_id("re_1", "<smtp-1@example.com>"))

    # ── 4 ────────────────────────────────────────────────
    def test_04_delivered_event_backfills_message_id(self):
        account = self.add_account(provider="resend")
        self.insert_outbound(account_id=account["account_id"], resend_id="re_1",
                             provider_status="accepted")
        from dc_email_controller.dc_webhook_handler import handle_status_event
        res = handle_status_event(
            "email.delivered", {"email_id": "re_1", "message_id": "<smtp-1@example.com>"})
        self.assertTrue(res.get("matched"))
        ob = self.store.find_outbound_by_resend_id("re_1")
        self.assertEqual(ob["smtp_message_id"], "<smtp-1@example.com>")

    # ── 5 ────────────────────────────────────────────────
    def test_05_resend_poller_carries_message_id(self):
        from dc_email_controller.dc_resend_source import to_status_event
        ev = to_status_event({
            "id": "re_1", "last_event": "delivered",
            "created_at": "2026-08-17T00:00:00Z", "message_id": "<smtp-1@example.com>",
        })
        self.assertEqual(ev["payload"]["message_id"], "<smtp-1@example.com>")

    # ── 6 ────────────────────────────────────────────────
    def test_06_in_reply_to_matches_smtp_message_id(self):
        account = self.add_account(provider="resend")
        self.insert_outbound(account_id=account["account_id"], resend_id="re_1",
                             message_id="<local@example.com>")
        self.store.backfill_smtp_message_id("re_1", "<smtp-1@example.com>")
        ob = self.store.find_outbound_by_reference(account["account_id"], ["<smtp-1@example.com>"])
        self.assertIsNotNone(ob)

    # ── 7 ────────────────────────────────────────────────
    def test_07_references_match_smtp_message_id(self):
        account = self.add_account(provider="resend")
        self.insert_outbound(account_id=account["account_id"], resend_id="re_1",
                             message_id="<local@example.com>")
        self.store.backfill_smtp_message_id("re_1", "<smtp-1@example.com>")
        ob = self.store.find_outbound_by_reference(
            account["account_id"], ["<other@example.com>", "<smtp-1@example.com>"])
        self.assertIsNotNone(ob)

    # ── 8 ────────────────────────────────────────────────
    def test_08_local_message_id_still_compatible(self):
        account = self.add_account(provider="resend")
        self.insert_outbound(account_id=account["account_id"], resend_id="re_1",
                             message_id="<local@example.com>")
        # 不 backfill，直接用 local_message_id 匹配（旧行为兼容）
        ob = self.store.find_outbound_by_reference(account["account_id"], ["<local@example.com>"])
        self.assertIsNotNone(ob)

    # ── 9 ────────────────────────────────────────────────
    def test_09_indexes_not_duplicated(self):
        account = self.add_account(provider="resend")
        # local == smtp 时不应重复建 message-id 索引（find 正常且唯一）
        self.store.insert_message({
            "account_id": account["account_id"], "direction": "outbound",
            "message_id": "<same@example.com>", "smtp_message_id": "<same@example.com>",
            "sender": "proxy@mail.dealclaw.io", "recipients": ["buyer@example.net"],
            "status": "sent", "resend_id": "re_1", "company_id": "co1",
        })
        ob = self.store.find_outbound_by_reference(account["account_id"], ["<same@example.com>"])
        self.assertIsNotNone(ob)
        # distinct local != smtp：两者都可匹配
        self.store.insert_message({
            "account_id": account["account_id"], "direction": "outbound",
            "message_id": "<local2@example.com>", "smtp_message_id": "<smtp2@example.com>",
            "sender": "proxy@mail.dealclaw.io", "recipients": ["buyer2@example.net"],
            "status": "sent", "resend_id": "re_2", "company_id": "co1",
        })
        self.assertIsNotNone(self.store.find_outbound_by_reference(account["account_id"], ["<local2@example.com>"]))
        self.assertIsNotNone(self.store.find_outbound_by_reference(account["account_id"], ["<smtp2@example.com>"]))

    # ── 10 ───────────────────────────────────────────────
    def test_10_cleanup_does_not_delete_real_outbound(self):
        account = self.add_account(provider="resend")
        self.insert_outbound(account_id=account["account_id"], resend_id="real_1",
                             message_id="<real@example.com>")
        self.insert_outbound(account_id=account["account_id"], resend_id="fake_1",
                             message_id="<fake@example.com>")
        res = self.store.remove_outbound("fake_1")
        self.assertTrue(res["removed"])
        # 真实 outbound 仍在
        self.assertIsNotNone(self.store.find_outbound_by_resend_id("real_1"))
        self.assertIsNotNone(self.store.find_outbound_by_reference(account["account_id"], ["<real@example.com>"]))
        # 伪记录已删
        self.assertIsNone(self.store.find_outbound_by_resend_id("fake_1"))
        self.assertIsNone(self.store.find_outbound_by_reference(account["account_id"], ["<fake@example.com>"]))


if __name__ == "__main__":
    unittest.main()
