#!/usr/bin/env python3
"""test_inbound_fact_persist.py — 入站回信必须落事实层（handle_inbound_event）。

回归点：Resend 入站（webhook 实时 / dc-cron-resend-poll 每 5 分钟轮询，两条链路
共用 `handle_inbound_event`）此前只生成信号/通知/草稿，**不写 EmailStore** →
早晚报「实际回复」数不到、买家案卷查不到原文。

覆盖：
  ① 绑定成功 → 事实层新增一条 inbound 记录（字段与 imap_sync.py 对齐）
  ② 同一 message_id 重复处理幂等（仍只有一条）
  ③ 绑定失败（无匹配 outbound）→ 不写事实层、status=unmatched

运行：
  cd work/mio-api && python3 -m unittest tests.test_inbound_fact_persist -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

AGENT_EMAIL = "thia@mail.dealclaw.io"
COMPANY = "testco"


class InboundFactPersistTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-inbound-fact-")
        os.environ["DC_DATA_DIR"] = self.tmp
        from dc_email_controller import dc_webhook_handler as h

        h._store = None
        h._store_db_path = None
        self.h = h
        self.store = h.get_store()
        self.store.insert_message({
            "direction": "outbound",
            "account_id": "ema_t1",
            "message_id": "<out1@dealclaw.io>",
            "smtp_message_id": "<out1@dealclaw.io>",
            "company_id": COMPANY,
            "campaign_id": "camp-1",
            "lead_id": "L1",
            "contact_id": "C1",
            "thread_id": "T1",
            "subject": "Hello from DealClaw",
            "status": "sent",
        })
        self._orig_account_for_to = h._account_for_to
        h._account_for_to = lambda to_email: {
            "account_id": "ema_t1",
            "email_address": (to_email or "").lower(),
            "enterprise_id": COMPANY,
        }

    def tearDown(self):
        self.h._account_for_to = self._orig_account_for_to
        os.environ.pop("DC_DATA_DIR", None)

    def _fake_fetch(self, email_id):
        return {
            "message_id": "<in1@buyer.example>",
            "in_reply_to": "<out1@dealclaw.io>",
            "from": "buyer@example.com",
            "to": [AGENT_EMAIL],
            "subject": "Re: Hello from DealClaw",
            "text": "ok收到，明天来",
            "headers": [],
        }

    def _inbound_event(self):
        return {
            "email_id": "rid-1",
            "from": "buyer@example.com",
            "to": [AGENT_EMAIL],
            "subject": "Re: Hello from DealClaw",
        }

    def test_inbound_reply_is_persisted(self):
        r = self.h.handle_inbound_event(self._inbound_event(), fetch=self._fake_fetch)
        self.assertEqual(r.get("status"), "bound", r)
        recs = self.store.list_inbound_records(COMPANY)
        self.assertEqual(len(recs), 1, recs)
        rec = recs[0]
        self.assertEqual(rec.get("record_type") or rec.get("direction"), "inbound")
        self.assertEqual(rec.get("message_id"), "<in1@buyer.example>")
        self.assertEqual(rec.get("in_reply_to"), "<out1@dealclaw.io>")
        self.assertEqual(rec.get("lead_id"), "L1")
        self.assertEqual(rec.get("contact_id"), "C1")
        self.assertIn("明天来", rec.get("text") or "")

    def test_repeat_is_idempotent(self):
        self.h.handle_inbound_event(self._inbound_event(), fetch=self._fake_fetch)
        self.h.handle_inbound_event(self._inbound_event(), fetch=self._fake_fetch)
        self.assertEqual(len(self.store.list_inbound_records(COMPANY)), 1)

    def test_unmatched_does_not_write(self):
        def fetch(_email_id):
            return {
                "message_id": "<in9@nowhere.example>",
                "from": "nobody@example.com",
                "to": [AGENT_EMAIL],
                "subject": "hi",
                "text": "hi",
                "headers": [],
            }

        r = self.h.handle_inbound_event(
            {"email_id": "rid-9", "from": "nobody@example.com", "to": [AGENT_EMAIL], "subject": "hi"},
            fetch=fetch,
        )
        self.assertEqual(r.get("status"), "unmatched", r)
        self.assertEqual(self.store.list_inbound_records(COMPANY), [])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
