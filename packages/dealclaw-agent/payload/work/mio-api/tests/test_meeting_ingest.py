#!/usr/bin/env python3
"""test_meeting_ingest.py — 会议数据入库 + signals 提取链路端到端测试。

用脱敏 fixture 覆盖：只有慧记 / transcript+translation / 重复同步 / 内容更新 /
evidence 可定位 / 无法定位 / 误挂 transcript / 原文变化 stale / 单一联系方式失效 /
同 customer 多会议 / 不同 opportunity 多会议。
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_meeting_ingest import (  # noqa: E402
    ingest_meeting,
    IngestStore,
    verify_evidence,
    normalize_note_record,
    normalize_translate_record,
    extract_candidate_signals,
)
from dc_opportunity_stage import evaluate_stage  # noqa: E402


NOTE_A = {
    "id": "note_001",
    "text": "买家需要采购约200套户外餐桌椅，请报价。",
    "customerId": "cust_001",
    "opportunityId": "opp_001",
    "createTime": "2026-09-08T10:00:00Z",
}
TRANSLATE_A = {
    "id": "trans_001",
    "text": "Buyer needs about 200 sets of outdoor dining tables, please quote.",
    "customerId": "cust_001",
    "opportunityId": "opp_001",
    "createTime": "2026-09-08T10:00:00Z",
}
NOTE_B = {  # 内容更新：同 id 不同 text
    "id": "note_001",
    "text": "买家需要采购约300套户外餐桌椅，请报价。",
    "customerId": "cust_001",
    "opportunityId": "opp_001",
}


class TestMeetingIngest(unittest.TestCase):
    def test_1_note_only(self):
        r = ingest_meeting(note_records=[NOTE_A], customer_id="cust_001", opportunity_id="opp_001")
        self.assertEqual(len(r["interactions"]), 1)
        self.assertEqual(r["stage"]["proposed_stage"], "商务跟进")
        self.assertEqual(r["stage"]["status"], "confirmed")

    def test_2_transcript_plus_translation(self):
        r = ingest_meeting(note_records=[NOTE_A], translate_records=[TRANSLATE_A], customer_id="cust_001", opportunity_id="opp_001")
        it = r["interactions"][0]
        self.assertTrue(it["transcript_ref"])
        self.assertTrue(it["translation_ref"])
        self.assertEqual(r["stage"]["proposed_stage"], "商务跟进")

    def test_3_duplicate_sync(self):
        store = IngestStore()
        ingest_meeting(note_records=[NOTE_A], store=store, customer_id="cust_001", opportunity_id="opp_001")
        r2 = ingest_meeting(note_records=[NOTE_A], store=store, customer_id="cust_001", opportunity_id="opp_001")
        self.assertTrue(any(w["type"] == "duplicate" for w in r2["warnings"]))

    def test_4_content_update(self):
        store = IngestStore()
        ingest_meeting(note_records=[NOTE_A], store=store, customer_id="cust_001", opportunity_id="opp_001")
        r2 = ingest_meeting(note_records=[NOTE_B], store=store, customer_id="cust_001", opportunity_id="opp_001")
        self.assertTrue(any(w["type"] == "content_changed" for w in r2["warnings"]))

    def test_5_evidence_locatable(self):
        sig = {"type": "product_need", "value": "x", "evidence_text": "需要采购约200套户外餐桌椅", "evidence_source": "transcript"}
        self.assertTrue(verify_evidence(sig, NOTE_A["text"], ""))

    def test_6_evidence_not_locatable(self):
        sig = {"type": "product_need", "value": "x", "evidence_text": "这段文字不在原文里", "evidence_source": "transcript"}
        self.assertFalse(verify_evidence(sig, NOTE_A["text"], ""))

    def test_7_translation_evidence_misattributed_to_transcript(self):
        # evidence_text 是英文（只存在于 translation），却挂 evidence_source=transcript
        sig = {"type": "product_need", "value": "x", "evidence_text": "needs about 200 sets", "evidence_source": "transcript"}
        self.assertFalse(verify_evidence(sig, NOTE_A["text"], TRANSLATE_A["text"]))

    def test_8_original_change_marks_stale(self):
        store = IngestStore()
        r1 = ingest_meeting(note_records=[NOTE_A], store=store, customer_id="cust_001", opportunity_id="opp_001")
        r2 = ingest_meeting(note_records=[NOTE_B], store=store, customer_id="cust_001", opportunity_id="opp_001")
        # 第二次的 signals 里应包含 stale 的旧信号（原文变化后保留版本）
        signals = r2["interactions"][0]["signals"]
        self.assertTrue(any(s.get("status") == "stale" for s in signals))
        self.assertTrue(any(w["type"] == "signals_stale" for w in r2["warnings"]))

    def test_9_contact_invalid_single_channel(self):
        r = evaluate_stage(interactions=[
            {"interaction_id": "i1", "source": "email", "signals": [
                {"type": "contact_invalid", "value": {"channel": "email", "address": "buyer@example.com", "reason": "bounced"}, "origin": "system", "evidence_text": "bounced"}
            ]},
            {"interaction_id": "i2", "source": "whatsapp", "bidirectional": True},
        ])
        self.assertEqual(r["contact_reachability"]["email"], "invalid")
        self.assertNotEqual(r["contact_reachability"]["whatsapp"], "invalid")
        self.assertEqual(r["opportunity_status"], "active")

    def test_10_two_meetings_same_customer(self):
        note1 = {"id": "n1", "text": "需要采购户外桌", "customerId": "cust_001", "opportunityId": "opp_001"}
        note2 = {"id": "n2", "text": "需要采购遮阳棚", "customerId": "cust_001", "opportunityId": "opp_002"}
        r = ingest_meeting(note_records=[note1, note2], customer_id="cust_001")
        self.assertEqual(len(r["interactions"]), 2)  # 同 customer 不同 opportunity → 两个 interaction

    def test_11_two_meetings_different_opportunity(self):
        note1 = {"id": "n1", "text": "需要采购户外桌", "customerId": "cust_001", "opportunityId": "opp_001"}
        note2 = {"id": "n2", "text": "需要采购遮阳棚", "customerId": "cust_002", "opportunityId": "opp_002"}
        r = ingest_meeting(note_records=[note1, note2])
        self.assertEqual(len(r["interactions"]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
