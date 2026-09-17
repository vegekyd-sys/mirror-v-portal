#!/usr/bin/env python3
"""test_email_metrics_by_recipients.py — 发送/送达/退信口径按「收件人数」计。

回归点：一封邮件发给 N 个买家邮箱 = N，而不是 1 条记录。
（旧口径 `sent` = outbound 记录条数，会让批量发送的漏斗数字偏小。）

运行：cd work/mio-api && python3 -m unittest tests.test_email_metrics_by_recipients -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from email_metrics.legacy import legacy_metrics  # noqa: E402

TS = "2026-09-14T02:00:00+00:00"


def outbound(recipients, status, mid):
    return {
        "direction": "outbound",
        "account_id": "ema_test",
        "recipients": recipients,
        "provider_status": status,
        "sent_at": TS,
        "created_at": TS,
        "message_id": mid,
        "local_message_id": mid,
    }


class RecipientCountTest(unittest.TestCase):
    def test_counts_by_recipient_not_by_record(self):
        records = [
            outbound(["a@x.com", "b@x.com", "c@x.com"], "delivered", "m1"),
            outbound(["d@x.com"], "bounced", "m2"),
        ]
        m = legacy_metrics(records, [])
        self.assertEqual(m["sent"], 4, "2 条记录共 4 个收件人 → sent 应为 4")
        self.assertEqual(m["delivered"], 3)
        self.assertEqual(m["bounced"], 1)

    def test_unparsable_recipients_count_as_one(self):
        m = legacy_metrics([outbound([], "accepted", "m3")], [])
        self.assertEqual(m["sent"], 1)
        self.assertEqual(m["pending"], 1)


if __name__ == "__main__":
    unittest.main()
