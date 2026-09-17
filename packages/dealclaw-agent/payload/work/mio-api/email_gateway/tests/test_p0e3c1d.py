"""P0-E3C.1d canonical fact key + 并发去重 — 测试。"""

import importlib
import json
import multiprocessing
import os
import sys
import tempfile
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))


def _mp_claim(data_dir, key, queue):
    from dc_email_controller import dc_email_ingest
    os.environ["DC_DATA_DIR"] = data_dir
    importlib.reload(dc_email_ingest)
    queue.put(dc_email_ingest._claim_canonical(key))


class CanonicalKeyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        from dc_email_controller import dc_email_ingest
        importlib.reload(dc_email_ingest)
        self.ingest = dc_email_ingest

    def tearDown(self):
        self.tmp.cleanup()

    def test_01_canonical_key(self):
        self.assertEqual(self.ingest.canonical_key("email.received", {"email_id": "r1"}), "received:r1")
        self.assertEqual(self.ingest.canonical_key("email.delivered", {"email_id": "s1"}), "delivery:s1:delivered")

    def test_02_duplicate_fact(self):
        # 同一 email_id，不同 svix_id → 第二个 duplicate_fact
        # 口径变更：canonical 只在业务处理成功（handled）时标 processed；未匹配 outbound 的
        # 投递事实会留 failed 供重试（claim 返回 reclaimed_failed），故补一条对应 outbound。
        from email_gateway.store import EmailStore
        EmailStore(self.data_dir).insert_message({
            "account_id": "ema_x", "direction": "outbound", "message_id": "<o1@x.com>",
            "sender": "proxy@mail.dealclaw.io", "recipients": ["buyer@example.net"],
            "subject": "Hi", "status": "sent", "resend_id": "s1",
            "company_id": "co1", "provider_status": "accepted",
        })
        ev1 = {"event_type": "email.delivered", "svix_id": "w1", "payload": {"email_id": "s1"}}
        ev2 = {"event_type": "email.delivered", "svix_id": "p1", "payload": {"email_id": "s1"}}
        r1 = self.ingest.ingest_resend_event(ev1)
        r2 = self.ingest.ingest_resend_event(ev2)
        self.assertTrue(r2.get("duplicate_fact"))

    def test_03_multiprocess_claim(self):
        q = multiprocessing.Queue()
        p1 = multiprocessing.Process(target=_mp_claim, args=(str(self.data_dir), "received:r1", q))
        p2 = multiprocessing.Process(target=_mp_claim, args=(str(self.data_dir), "received:r1", q))
        p1.start(); p2.start(); p1.join(); p2.join()
        a = q.get(); b = q.get()
        self.assertEqual(sorted([a, b]), [False, True])  # 恰好一个获胜


if __name__ == "__main__":
    unittest.main()
