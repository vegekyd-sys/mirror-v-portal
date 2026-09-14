#!/usr/bin/env python3
"""test_bounce_store_writeback.py — IMAP 退信回写事实层（store.mark_bounced_by_contact）。

回归点：退信必须把「账号+收件人」对应的最近一封 outbound 标成 bounced；
已是终态（bounced/complained/failed）的不再改写；匹配不到就返回 False。

运行：cd work/mio-api && python3 -m unittest tests.test_bounce_store_writeback -v
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from email_gateway.store import EmailStore, utc_now  # noqa: E402

ACC = "ema_bounce_test"
BUYER = "buyer@nowhere.example"


class BounceWritebackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-bounce-")
        self.store = EmailStore(self.tmp)
        now = utc_now()
        self.store.insert_message({
            "account_id": ACC,
            "direction": "outbound",
            "message_id": "local_bounce_1",
            "local_message_id": "local_bounce_1",
            "sender": "thia@mail.dealclaw.io",
            "recipients": [BUYER],
            "subject": "hello",
            "company_id": "testco",
            "provider_status": "delivered",
            "sent_at": now,
            "created_at": now,
        })

    def test_marks_bounced(self):
        self.assertTrue(self.store.mark_bounced_by_contact(ACC, BUYER, "hard"))
        recs = self.store.find_outbounds_by_contact(ACC, BUYER)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["provider_status"], "bounced")
        self.assertIn("[hard]", recs[0].get("failure_reason", ""))

    def test_terminal_status_not_overwritten(self):
        self.store.mark_bounced_by_contact(ACC, BUYER, "hard")
        self.assertFalse(self.store.mark_bounced_by_contact(ACC, BUYER, "soft"))

    def test_no_match_returns_false(self):
        self.assertFalse(self.store.mark_bounced_by_contact(ACC, "nobody@x.com", "hard"))


if __name__ == "__main__":
    unittest.main()
