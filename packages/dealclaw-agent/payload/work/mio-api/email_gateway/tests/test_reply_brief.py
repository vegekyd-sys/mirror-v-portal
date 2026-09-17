"""回信解读与下一步建议的组装测试（通知不能只是“有新回信”）。"""

import sys
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway import reply_brief as rb  # noqa: E402


class InterpretTests(unittest.TestCase):
    def test_quote_request_maps_to_price_interpretation(self):
        info = rb.interpret_signals([{"signal_type": "quote_request", "evidence": "asking for price list"}])
        self.assertIn("问价格", info["intent"])
        self.assertTrue(info["actions"])
        self.assertIn("asking for price list", info["evidence"])

    def test_sample_request_has_shipping_actions(self):
        info = rb.interpret_signals([{"signal_type": "sample_request"}])
        self.assertTrue(any("寄样" in a or "样品" in a for a in info["actions"]))

    def test_meeting_interest_mentions_timezone(self):
        info = rb.interpret_signals([{"signal_type": "meeting_interest"}])
        self.assertTrue(any("时区" in a for a in info["actions"]))

    def test_multiple_signals_merge_without_duplicates(self):
        info = rb.interpret_signals([{"signal_type": "quote_request"},
                                     {"signal_type": "sample_request"},
                                     {"signal_type": "quote_request"}])
        self.assertEqual(len(info["actions"]), len(set(info["actions"])))
        self.assertIn("买家在问价格", info["intent"])
        self.assertIn("买家想要样品", info["intent"])

    def test_no_signals_gives_conservative_interpretation(self):
        info = rb.interpret_signals([])
        self.assertIn("暂未看出明确意向", info["intent"])
        self.assertTrue(info["actions"])

    def test_unknown_signal_type_still_produces_actions(self):
        info = rb.interpret_signals([{"signal_type": "weird_new_type"}])
        self.assertTrue(info["actions"])

    def test_evidence_capped_at_three(self):
        sigs = [{"signal_type": "quote_request", "evidence": f"e{i}"} for i in range(6)]
        info = rb.interpret_signals(sigs)
        self.assertLessEqual(len(info["evidence"]), 3)


class ComposeTests(unittest.TestCase):
    def test_brief_contains_interpretation_and_actions(self):
        text = rb.compose_brief(
            sender="buyer@x.com",
            subject="Re: chairs",
            received_at="2026-09-15T03:00:00Z",
            signals=[{"signal_type": "quote_request", "evidence": "need FOB price"}],
        )
        self.assertIn("解读：", text)
        self.assertIn("建议下一步：", text)
        self.assertIn("1.", text)
        self.assertIn("buyer@x.com", text)
        self.assertIn("need FOB price", text)

    def test_brief_without_signals_is_still_useful(self):
        text = rb.compose_brief(sender="x@y.com", subject="hi", signals=[])
        self.assertIn("解读：", text)
        self.assertIn("建议下一步：", text)

    def test_excerpt_is_included_when_provided(self):
        text = rb.compose_brief(sender="a@b.com", subject="s", excerpt="Could you send your catalog?")
        self.assertIn("原文摘录", text)
        self.assertIn("Could you send your catalog?", text)


if __name__ == "__main__":
    unittest.main()
