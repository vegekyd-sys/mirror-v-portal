#!/usr/bin/env python3
"""早晚报「回信采购意图」段回归测试 —— 2026-09-16 田耕郡口径。

客户口径：早晚报要**推理**并列出两类回信，两类都不能省：
  ■ 有明确采购意图（基于信号 quote_request / sample_request / meeting_interest / missing_info，
    引用命中的信号与关键词作为判断理由）
  ■ 已回信但未识别出采购意图（给原文摘要，提示需人工判断）

覆盖：
  C1 纯函数分类：有报价信号 → 有意图；带关键词 → 理由里能引用出来
  C2 纯函数分类：零信号回信 → 未识别出采购意图（不得丢）
  C3 只有非采购类信号（missing_info 之外）→ 归入未识别
  C4 渲染：两类标题与计数**无条件出现**（空也写「无」）
  C5 渲染：超量封顶时给出「另有 N 封未展开」，不静默截断
  C6 采集：从真实事实层（EmailStore）+ 信号层按 message_id 关联
  C7 报告接入：早晚报正文里出现该段（morning 与 evening 都有）

运行：cd work/mio-api && python3 -m unittest tests.test_reply_intent_brief -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[1]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

COMPANY = "testco"
QUOTE_TEXT = "Please send your best price and MOQ for 500 units."
PLAIN_TEXT = "Thanks, I will revert if needed."
CONFIRM_TEXT = "Yes, we will be back at the show and stop by your booth."


def _signals(text: str, mid: str):
    from dc_email_controller.dc_email_signals import classify_reply_signals
    return classify_reply_signals(text, source_message_id=mid, company_id=COMPANY,
                                  campaign_id="c1")


class ClassifyPure(unittest.TestCase):
    """C1–C3：纯函数判定（不读数据、不发消息）。"""

    def setUp(self):
        from dc_daily_brief import classify_reply_purchase_intent
        self.classify = classify_reply_purchase_intent

    def _row(self, mid, text, signals=None):
        return {"message_id": mid, "sender": "b@x.com", "sender_name": "Buyer",
                "company_name": "Buyer Co", "subject": "RE: fans", "excerpt": text,
                "received_at": "2026-09-16T03:00:00+00:00",
                "signals": signals if signals is not None else _signals(text, mid)}

    def test_c1_quote_reply_has_intent_with_keyword_reason(self):
        out = self.classify([self._row("<q@b>", QUOTE_TEXT)])
        self.assertEqual(out["counts"]["with_intent"], 1)
        self.assertEqual(out["counts"]["without_intent"], 0)
        row = out["with_intent"][0]
        self.assertEqual(row["signals"], ["quote_request"])
        self.assertIn("询价/报价请求", row["reason"])
        self.assertIn("price", row["reason"], "理由必须引用命中的关键词")

    def test_c1b_meeting_reply_has_intent(self):
        out = self.classify([self._row("<m@b>", CONFIRM_TEXT)])
        self.assertEqual(out["counts"]["with_intent"], 1)
        self.assertEqual(out["with_intent"][0]["signals"], ["meeting_interest"])

    def test_c2_zero_signal_reply_is_listed_as_unrecognized(self):
        out = self.classify([self._row("<p@b>", PLAIN_TEXT)])
        self.assertEqual(out["counts"]["with_intent"], 0)
        self.assertEqual(out["counts"]["without_intent"], 1)
        row = out["without_intent"][0]
        self.assertEqual(row["signals"], [])
        self.assertIn("未命中", row["reason"])
        self.assertIn("Thanks", row["excerpt"])

    def test_c3_non_purchase_signal_goes_to_unrecognized(self):
        out = self.classify([self._row("<d@b>", "delivered ok", signals=[
            {"signal_type": "delivered", "evidence": {}}])])
        self.assertEqual(out["counts"]["without_intent"], 1)
        self.assertIn("非采购类信号", out["without_intent"][0]["reason"])

    def test_c3b_missing_info_counts_as_intent(self):
        out = self.classify([self._row("<mi@b>", "when can you deliver?", signals=[
            {"signal_type": "missing_info", "evidence": {"missing_fields": ["delivery_time"]}}])])
        self.assertEqual(out["counts"]["with_intent"], 1)
        self.assertIn("delivery_time", out["with_intent"][0]["reason"])

    def test_c3c_dirty_rows_do_not_break(self):
        out = self.classify([None, "junk", {"message_id": "x"}, {"signals": "nope"}])
        self.assertEqual(out["counts"]["total"], 2)
        self.assertEqual(out["counts"]["without_intent"], 2)


class RenderSection(unittest.TestCase):
    """C4–C5：两类清单谁都不能少；超量要说明。"""

    def setUp(self):
        from dc_daily_brief import classify_reply_purchase_intent, render_reply_intent_section
        self.classify, self.render = classify_reply_purchase_intent, render_reply_intent_section

    def test_c4_both_headings_always_present(self):
        empty = self.render(self.classify([]))
        self.assertIn("有明确采购意图（0 封）", empty)
        self.assertIn("已回信但未识别出采购意图（0 封）", empty)

        only_intent = self.render(self.classify([
            {"message_id": "<q@b>", "sender": "a@x.com", "excerpt": QUOTE_TEXT,
             "signals": _signals(QUOTE_TEXT, "<q@b>")}]))
        self.assertIn("有明确采购意图（1 封）", only_intent)
        self.assertIn("已回信但未识别出采购意图（0 封）", only_intent)
        self.assertIn("  · 无", only_intent)

    def test_c4b_unrecognized_list_is_not_omitted(self):
        text = self.render(self.classify([
            {"message_id": "<p@b>", "sender": "p@x.com", "excerpt": PLAIN_TEXT, "signals": []}]))
        self.assertIn("已回信但未识别出采购意图（1 封）", text)
        self.assertIn("需人工判断是否回复", text)
        self.assertIn("原文：", text)

    def test_c5_overflow_is_stated_not_silently_truncated(self):
        rows = [{"message_id": f"<q{i}@b>", "sender": f"b{i}@x.com", "excerpt": QUOTE_TEXT,
                 "signals": _signals(QUOTE_TEXT, f"<q{i}@b>")} for i in range(23)]
        out = self.classify(rows, limit=20)
        text = self.render(out)
        self.assertIn("有明确采购意图（23 封）", text)
        self.assertIn("另有 3 封未展开", text)


class CollectAndWire(unittest.TestCase):
    """C6–C7：真实事实层采集 + 接入早晚报正文。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.environ["DC_DATA_DIR"] = self.tmp.name
        os.environ["MIO_CDP_SUPPLIER_ID"] = COMPANY
        from email_gateway.store import EmailStore
        from dc_email_controller.dc_email_signals import record_signal
        self.store = EmailStore(Path(self.tmp.name))
        for i, (mid, text) in enumerate((("<q@b>", QUOTE_TEXT), ("<p@b>", PLAIN_TEXT))):
            self.store.insert_message({
                "direction": "inbound", "account_id": "ema_t1", "message_id": mid,
                "sender": f"Buyer {i} <b{i}@x.com>", "recipients": ["us@dealclaw.io"],
                "subject": "RE: fans", "text_preview": text, "company_id": COMPANY,
                "received_at": "2026-09-16T02:00:00+00:00",
                "created_at": "2026-09-16T02:00:00+00:00",
            })
        for s in _signals(QUOTE_TEXT, "<q@b>"):
            record_signal(s)

    def test_c6_collect_links_signals_by_message_id(self):
        import dc_daily_report as dr
        rows = dr.collect_reply_intent_rows(COMPANY, hours=48)
        self.assertEqual(len(rows), 2)
        by_mid = {r["message_id"]: r for r in rows}
        self.assertEqual([s["signal_type"] for s in by_mid["<q@b>"]["signals"]],
                         ["quote_request"])
        self.assertEqual(by_mid["<p@b>"]["signals"], [])
        self.assertEqual(by_mid["<q@b>"]["sender"], "b0@x.com", "发件人按地址解析")
        self.assertEqual(by_mid["<q@b>"]["sender_name"], "Buyer 0")

    def test_c6b_window_filters_old_replies(self):
        import dc_daily_report as dr
        self.assertEqual(dr.collect_reply_intent_rows(COMPANY, hours=1), [])

    def test_c7_section_renders_from_real_data(self):
        import dc_daily_report as dr
        text = dr._reply_intent_section(COMPANY, "morning")
        self.assertIn("【回信采购意图】", text)
        self.assertIn("有明确采购意图（1 封）", text)
        self.assertIn("已回信但未识别出采购意图（1 封）", text)

    def test_c7b_both_slots_include_the_section_in_report_text(self):
        from unittest import mock
        import dc_daily_report as dr
        import dc_daily_pipeline as pipeline
        plan = {"actions": [], "context": [], "top_n_action_keys": []}
        with mock.patch.object(pipeline, "run_morning_brief",
                               lambda *a, **k: {"plan": plan}), \
             mock.patch.object(pipeline, "run_evening_brief",
                               lambda *a, **k: {"review": None, "plan": plan}), \
             mock.patch.object(dr, "_exhibition_battle", lambda *a, **k: ""), \
             mock.patch.object(dr, "_today_metrics", lambda *a, **k: ""):
            text = dr._pipeline_brief(COMPANY, "morning")
            self.assertIn("【回信采购意图】", text)
            text_evening = dr._pipeline_brief(COMPANY, "evening")
            self.assertIn("【回信采购意图】", text_evening)


if __name__ == "__main__":
    unittest.main()
