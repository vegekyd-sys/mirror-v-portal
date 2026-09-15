"""回信归属（收件箱 + 人）测试：不依赖 In-Reply-To 也能归属。

背景：实测中 Resend 收信详情接口可能不返回 In-Reply-To 头，只靠精确匹配会
「拉到了却认不出」。因此归属必须分层：收件箱优先，In-Reply-To 仅作精修。
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway import reply_attribution as ra  # noqa: E402


class FakeStore:
    def __init__(self, accounts=None, raise_on_list=False):
        self.accounts = accounts if accounts is not None else [
            {"account_id": "ema_1", "email_address": "bambu-lab@mail.dealclaw.io",
             "owner_open_id": "ou_owner", "enterprise_id": "test-tuozhu"}]
        self.raise_on_list = raise_on_list

    def list_accounts(self, enterprise_id=None):
        if self.raise_on_list:
            raise RuntimeError("store down")
        return self.accounts

    def get_account(self, account_id):
        for a in self.accounts:
            if a["account_id"] == account_id:
                return a
        raise KeyError(account_id)


class MailboxResolutionTests(unittest.TestCase):
    def test_resolves_mailbox_by_recipient(self):
        box = ra.resolve_mailbox(["bambu-lab@mail.dealclaw.io"], store=FakeStore())
        self.assertEqual(box["account_id"], "ema_1")

    def test_handles_display_name_and_case(self):
        box = ra.resolve_mailbox(["DealClaw <BAMBU-LAB@mail.dealclaw.io>"], store=FakeStore())
        self.assertEqual(box["account_id"], "ema_1")

    def test_unknown_recipient_returns_empty(self):
        self.assertEqual(ra.resolve_mailbox(["nobody@x.com"], store=FakeStore()), {})

    def test_store_failure_is_not_fatal(self):
        self.assertEqual(ra.resolve_mailbox(["bambu-lab@mail.dealclaw.io"],
                                            store=FakeStore(raise_on_list=True)), {})


class AttributeTests(unittest.TestCase):
    def test_attributes_by_recipient_without_any_headers(self):
        """关键场景：#5 那样拿不到 In-Reply-To，也必须能对应到收件箱和人。"""
        a = ra.attribute(recipients=["bambu-lab@mail.dealclaw.io"], sender="buyer@x.com",
                         in_reply_to="", store=FakeStore(), facts_dir="/nonexistent")
        self.assertTrue(a["attributed"])
        self.assertEqual(a["method"], ra.METHOD_RECIPIENT)
        self.assertEqual(a["account_id"], "ema_1")
        self.assertEqual(a["mailbox"], "bambu-lab@mail.dealclaw.io")
        self.assertEqual(a["owner_open_id"], "ou_owner")
        self.assertEqual(a["enterprise_id"], "test-tuozhu")

    def test_unattributable_when_mailbox_unknown(self):
        a = ra.attribute(recipients=["ghost@mail.dealclaw.io"], sender="buyer@x.com",
                         store=FakeStore(), facts_dir="/nonexistent")
        self.assertFalse(a["attributed"])
        self.assertEqual(a["method"], ra.METHOD_NONE)

    def test_in_reply_to_upgrades_method_when_index_hits(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            (base / "indexes" / "message-id").mkdir(parents=True)
            (base / "outbound" / "test-tuozhu" / "2026-09").mkdir(parents=True)
            rel = "outbound/test-tuozhu/2026-09/rec.md"
            (base / rel).write_text(
                "# DealClaw Email Record\n\n" + json.dumps({
                    "account_id": "ema_1", "subject": "闭环验证 #5", "smtp_message_id": "<mid@x>"}),
                encoding="utf-8")
            import hashlib
            h = hashlib.sha256(b"<mid@x>").hexdigest()
            (base / "indexes" / "message-id" / f"{h}.md").write_text(
                "# DealClaw Email Index\n\n" + json.dumps({"key_type": "message-id", "record_path": rel}),
                encoding="utf-8")
            a = ra.attribute(recipients=["bambu-lab@mail.dealclaw.io"], sender="buyer@x.com",
                             in_reply_to="<mid@x>", store=FakeStore(), facts_dir=d)
        self.assertTrue(a["attributed"])
        self.assertEqual(a["method"], ra.METHOD_IN_REPLY_TO)
        self.assertEqual(a["thread"]["subject"], "闭环验证 #5")

    def test_missing_index_does_not_break_attribution(self):
        a = ra.attribute(recipients=["bambu-lab@mail.dealclaw.io"], sender="b@x.com",
                         in_reply_to="<not-indexed@x>", store=FakeStore(), facts_dir="/nonexistent")
        self.assertTrue(a["attributed"])
        self.assertEqual(a["method"], ra.METHOD_RECIPIENT)


class RecentThreadFallbackTests(unittest.TestCase):
    def test_recent_outbound_to_sender_used_as_thread_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            (base / "outbound" / "test-tuozhu" / "2026-09").mkdir(parents=True)
            (base / "outbound" / "test-tuozhu" / "2026-09" / "r.md").write_text(
                "# DealClaw Email Record\n\n" + json.dumps({
                    "account_id": "ema_1", "recipients": ["buyer@x.com"], "subject": "开发信" }),
                encoding="utf-8")
            a = ra.attribute(recipients=["bambu-lab@mail.dealclaw.io"], sender="buyer@x.com",
                             store=FakeStore(), facts_dir=d)
        self.assertTrue(a["attributed"])
        self.assertEqual(a["method"], ra.METHOD_RECIPIENT_RECENT)
        self.assertEqual(a["thread"]["subject"], "开发信")


if __name__ == "__main__":
    unittest.main()
