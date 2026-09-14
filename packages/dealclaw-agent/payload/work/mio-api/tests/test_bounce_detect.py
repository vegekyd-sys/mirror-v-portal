#!/usr/bin/env python3
"""test_bounce_detect.py — IMAP 退信（NDR）识别 / 解析 / 分类。

回归点：个人邮箱 SMTP 直发默认 delivered，退信必须能被识别出来，
且不能把退信当买家回复。

运行：cd work/mio-api && python3 -m unittest tests.test_bounce_detect -v
"""
from __future__ import annotations

import sys
import unittest
from email import message_from_string
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dc_bounce_detect import (  # noqa: E402
    body_text,
    classify_bounce,
    extract_bounced_recipient,
    is_bounce,
)

HARD_NDR = """From: MAILER-DAEMON@qq.com
To: thia@mail.dealclaw.io
Subject: Undeliverable: hello
Content-Type: multipart/report; report-type=delivery-status; boundary="B"

--B
Content-Type: text/plain; charset=utf-8

Your message could not be delivered.
The recipient address does not exist.
Final-Recipient: rfc822; buyer@nowhere.example
--B
Content-Type: message/delivery-status

Final-Recipient: rfc822; buyer@nowhere.example
Action: failed
Status: 5.1.1
--B--
"""

NORMAL_REPLY = """From: buyer@example.com
To: thia@mail.dealclaw.io
Subject: Re: quick question
Content-Type: text/plain; charset=utf-8

Yes, please send the catalog.
"""


def parse(raw: str):
    return message_from_string(raw)


class BounceDetectTest(unittest.TestCase):
    def test_detects_multipart_report_ndr(self):
        msg = parse(HARD_NDR)
        self.assertTrue(is_bounce(msg, "MAILER-DAEMON@qq.com", "Undeliverable: hello"))

    def test_subject_hint_only(self):
        msg = parse(NORMAL_REPLY)
        self.assertTrue(is_bounce(msg, "someone@x.com", "退信：投递失败"))
        self.assertTrue(is_bounce(msg, "someone@x.com", "Mail Delivery Failed"))

    def test_normal_reply_is_not_bounce(self):
        msg = parse(NORMAL_REPLY)
        self.assertFalse(is_bounce(msg, "buyer@example.com", "Re: quick question"))

    def test_classify(self):
        self.assertEqual(classify_bounce("550 user unknown"), "hard")
        self.assertEqual(classify_bounce("mailbox full, over quota"), "soft")
        self.assertEqual(classify_bounce("content rejected due to spam"), "content")
        self.assertEqual(classify_bounce("nothing recognizable"), "unknown")

    def test_extract_recipient_from_body(self):
        self.assertEqual(extract_bounced_recipient(parse(HARD_NDR)), "buyer@nowhere.example")

    def test_extract_recipient_prefers_x_failed_recipients(self):
        msg = parse(HARD_NDR)
        msg["X-Failed-Recipients"] = "real-buyer@example.com, other@example.com"
        self.assertEqual(extract_bounced_recipient(msg), "real-buyer@example.com")

    def test_extract_recipient_skips_mailer_daemon(self):
        raw = """From: mailer-daemon@qq.com
To: thia@mail.dealclaw.io
Subject: 退信
Content-Type: text/plain; charset=utf-8

mailer-daemon@qq.com
"""
        self.assertEqual(extract_bounced_recipient(parse(raw)), "")

    def test_body_text_prefers_plain(self):
        raw = """From: a@b.com
Content-Type: multipart/alternative; boundary="X"

--X
Content-Type: text/plain

PLAIN-BODY
--X
Content-Type: text/html

<b>HTML-BODY</b>
--X--
"""
        self.assertIn("PLAIN-BODY", body_text(parse(raw)))
        self.assertNotIn("HTML-BODY", body_text(parse(raw)))


if __name__ == "__main__":
    unittest.main()
