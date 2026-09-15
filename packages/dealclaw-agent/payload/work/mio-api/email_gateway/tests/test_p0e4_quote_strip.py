"""P0-E4 引文剥离 — 引用里的 meeting 不应生成 meeting_interest。"""

import os
import sys
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from dc_iq_engine import strip_quoted_reply, analyze_only
from dc_email_controller.dc_email_signals import classify_reply_signals


class QuoteStripTests(unittest.TestCase):
    def test_strip_tencent_chinese_quote(self):
        reply = ("I'd like the quotation and a sample.\n\nBR, Tian\n\n"
                 "Thia<thia@mail.dealclaw.io> 在 2026年8月17日 周一 22:10 写道：\n"
                 "Hi, this is a test. Please reply asking for: (1) quotation, (2) sample, (3) meeting.")
        stripped = strip_quoted_reply(reply)
        self.assertNotIn("meeting", stripped)
        self.assertIn("quotation", stripped)

    def test_quoted_meeting_does_not_generate_meeting_interest(self):
        reply = ("I'd like to know the quotation, if I can have a sample, that will be better.\n\n"
                 "BR, Tian\n\n"
                 "Thia<thia@mail.dealclaw.io> 在 2026年8月17日 周一 22:10 写道：\n"
                 "Hi, this is a test. Please reply asking for: (1) quotation, (2) sample, (3) meeting.")
        a = analyze_only(reply)
        sigs = classify_reply_signals(reply, intent=a["intent"],
                                      requested_materials=a["requested_materials"])
        types = [s["signal_type"] for s in sigs]
        self.assertIn("quote_request", types)
        self.assertIn("sample_request", types)
        self.assertNotIn("meeting_interest", types)

    def test_english_on_wrote_quote_stripped(self):
        reply = ("Please send the quote.\n\n"
                 "On Mon, Aug 17, 2026 Thia wrote:\n"
                 "> please reply asking for quotation, sample, meeting.")
        stripped = strip_quoted_reply(reply)
        self.assertNotIn("meeting", stripped)
        self.assertIn("quote", stripped)

    def test_gt_prefix_quote_stripped(self):
        reply = ("I want a sample.\n\n"
                 "> Hi, this is a test.\n"
                 "> Please reply asking for meeting.")
        stripped = strip_quoted_reply(reply)
        self.assertNotIn("meeting", stripped)
        self.assertIn("sample", stripped)


if __name__ == "__main__":
    unittest.main()
