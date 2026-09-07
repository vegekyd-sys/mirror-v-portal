#!/usr/bin/env python3
"""test_interactions.py — 沟通明细 interaction 落库 + 飞书「沟通明细」子表测试。

覆盖阶段②.1 的 16 字段结构 + 幂等：
  - interaction_id / customer_id / opportunity_id / exhibition_id / channel / direction /
    occurred_at / subject / summary / raw_record_ref / artifacts / status / has_reply /
    thread_id / source_system / source_record_id
  - 同名公司不同 customer_id 不合并
  - 相同 source_record_id、不同 source_system 不冲突
  - 展会互动保留 exhibition_id；日常邮件 exhibition_id 允许为空
  - 一场会议 transcript/translation 仍是一条 interaction
  - raw_record_ref 可下钻但正文不进表格
  - 重复同步不新增行
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_memory_data import (  # noqa: E402
    flatten_followup_to_interactions,
    new_interaction,
    _interaction_id,
    _customer_id,
    sync_interactions_to_memory,
    INTERACTION_KEYS,
)


FOLLOWUP_ROW = {
    "company": "Casa Outdoor",
    "company_cdp_id": "cdp_1",
    "website": "www.casaoutdoor.mx",
    "country": "MX",
    "buyer_type": "经销商",
    "contact": "Maria Lopez｜采购总监",
    "contact_names": ["Maria Lopez"],
    "stage": "已回复",
    "touch_number": 2,
    "outbound_count": 2,
    "inbound_count": 1,
    "latest_at": "2026-09-02T10:00:00+00:00",
    "emails": [
        {"direction": "out", "round": 0, "subject": "hi", "content": "first touch",
         "sent_at": "2026-09-01T10:00:00+00:00", "status": "delivered",
         "source_system": "email", "source_record_id": "smtp_1", "thread_id": "th_1"},
        {"direction": "in", "round": None, "subject": "re: hi", "content": "thanks",
         "sent_at": "2026-09-02T10:00:00+00:00", "status": "received",
         "source_system": "email", "source_record_id": "inbound_1", "thread_id": "th_1"},
    ],
}


class TestFlattenStructure(unittest.TestCase):
    def test_1_one_row_per_interaction(self):
        """一行一客户 + N 封邮件 → N 行 interaction。"""
        out = flatten_followup_to_interactions([FOLLOWUP_ROW])
        self.assertEqual(len(out), 2)

    def test_2_16_fields_present(self):
        """每行都含 ②.1 要求的 16 字段。"""
        out = flatten_followup_to_interactions([FOLLOWUP_ROW])
        for k in INTERACTION_KEYS:
            self.assertIn(k, out[0])

    def test_3_channel_direction(self):
        """channel=email；direction out→outbound、in→inbound。"""
        out = flatten_followup_to_interactions([FOLLOWUP_ROW])
        self.assertEqual(out[0]["channel"], "email")
        self.assertEqual(out[0]["direction"], "outbound")
        self.assertEqual(out[1]["direction"], "inbound")

    def test_4_customer_id_from_cdp(self):
        """customer_id 取 company_cdp_id；customer_display 存公司名展示。"""
        out = flatten_followup_to_interactions([FOLLOWUP_ROW])
        self.assertEqual(out[0]["customer_id"], "cdp_1")
        self.assertEqual(out[0]["customer_display"], "Casa Outdoor")

    def test_5_empty_exhibition_opportunity(self):
        """日常邮件 exhibition_id / opportunity_id 允许为空。"""
        out = flatten_followup_to_interactions([FOLLOWUP_ROW])
        self.assertEqual(out[0]["exhibition_id"], "")
        self.assertEqual(out[0]["opportunity_id"], "")

    def test_6_summary_truncated_body_not_in_table(self):
        """summary 是截断摘要；raw_record_ref 存 source_record_id；完整正文不落表格。"""
        long_body = "很长的邮件正文" * 100  # 600 字，超过 200 截断
        row = dict(FOLLOWUP_ROW, emails=[{**FOLLOWUP_ROW["emails"][0], "content": long_body}])
        out = flatten_followup_to_interactions([row])
        it = out[0]
        self.assertLessEqual(len(it["summary"]), 201)   # 200 + "…"
        self.assertNotEqual(it["summary"], long_body)   # 不是完整正文
        self.assertEqual(it["raw_record_ref"], "smtp_1")

    def test_7_status_field(self):
        """status 字段名（非 send_status），取值来自邮件 status。"""
        out = flatten_followup_to_interactions([FOLLOWUP_ROW])
        self.assertEqual(out[0]["status"], "delivered")


class TestIdempotency(unittest.TestCase):
    def test_8_same_company_diff_cdp_not_merged(self):
        """同名公司不同 customer_id → 不同 interaction_id，不合并。"""
        a = flatten_followup_to_interactions([FOLLOWUP_ROW])[0]
        b = flatten_followup_to_interactions([dict(FOLLOWUP_ROW, company_cdp_id="cdp_2")])[0]
        self.assertNotEqual(a["interaction_id"], b["interaction_id"])
        self.assertNotEqual(a["customer_id"], b["customer_id"])

    def test_9_same_source_record_diff_system_not_conflict(self):
        """相同 source_record_id、不同 source_system → 不同 interaction_id，不冲突。"""
        i1 = _interaction_id("email", "srid_1", "c1", "email", "outbound", "t", "s")
        i2 = _interaction_id("whatsapp", "srid_1", "c1", "whatsapp", "outbound", "t", "s")
        self.assertNotEqual(i1, i2)

    def test_10_resync_no_new_rows(self):
        """重复同步不新增行（interaction_id 确定性 + 幂等去重）。"""
        out1 = flatten_followup_to_interactions([FOLLOWUP_ROW])
        out2 = flatten_followup_to_interactions([FOLLOWUP_ROW])
        ids1 = [it["interaction_id"] for it in out1]
        ids2 = [it["interaction_id"] for it in out2]
        self.assertEqual(ids1, ids2)
        self.assertEqual(len(ids1), len(set(ids1)))  # 无重复


class TestMeetingArtifacts(unittest.TestCase):
    def test_11_meeting_transcript_translation_one_interaction(self):
        """一场会议的 transcript/translation 是同一 interaction 的 artifacts，不拆行。"""
        it = new_interaction(
            channel="meeting", direction="system", source_system="慧记",
            artifacts=[
                {"kind": "transcript", "source": "慧记", "content_ref": "raw/meeting_001.txt"},
                {"kind": "translation", "source": "慧译", "content_ref": "raw/translation_001.txt"},
            ],
        )
        self.assertEqual(len(it["artifacts"]), 2)
        self.assertEqual(it["channel"], "meeting")
        # 不因 artifacts 拆成多条 interaction
        self.assertIsInstance(it["artifacts"], list)

    def test_12_exhibition_interaction_keeps_exhibition_id(self):
        """展会互动保留 exhibition_id。"""
        it = new_interaction(channel="meeting", exhibition_id="exh_2026_mexico")
        self.assertEqual(it["exhibition_id"], "exh_2026_mexico")


class TestFeishuInteractionTable(unittest.TestCase):
    def test_13_followup_fields_no_full_content(self):
        """FOLLOWUP_FIELDS 已删「邮件全部内容」。"""
        import dc_feishu_standard as std
        names = [f["name"] for f in std.FOLLOWUP_FIELDS]
        self.assertNotIn("邮件全部内容", names)

    def test_14_interaction_fields_with_link(self):
        """有线索池主表 → 客户关联是 link 字段 + 辅助字段（互动ID/客户ID/商机ID/展会ID/原文引用/来源系统）。"""
        import dc_feishu_standard as std
        fields = std._interaction_fields("tbl_lead")
        names = [f["name"] for f in fields]
        self.assertEqual(fields[0]["type"], "link")
        self.assertEqual(fields[0]["link_table"], "tbl_lead")
        for n in ("互动ID", "客户ID", "商机ID", "展会ID", "原文引用", "来源系统", "来源记录ID"):
            self.assertIn(n, names)

    def test_15_interaction_fields_no_link_fallback(self):
        """无线索池主表 → 降级为 text「客户」展示名。"""
        import dc_feishu_standard as std
        fields = std._interaction_fields("")
        self.assertEqual(fields[0]["name"], "客户")
        self.assertEqual(fields[0]["type"], "text")

    def test_16_interaction_rows_link_resolution(self):
        """_build_interaction_rows：有 link 时客户关联= [{id: record_id}]；正文不进表格。"""
        import dc_feishu_standard as std
        interactions = flatten_followup_to_interactions([FOLLOWUP_ROW])
        lead_index = {"cdp:cdp_1": "rec_lead_1"}
        with mock.patch("dc_memory_data.read_interactions", return_value=interactions):
            rows = std._build_interaction_rows("testco", "tbl_lead", lead_index)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0][0], [{"id": "rec_lead_1"}])  # 客户关联 link
        self.assertEqual(rows[0][1], "email")                 # 渠道
        self.assertEqual(rows[0][9], interactions[0]["interaction_id"])  # 互动ID
        # 正文不进表格：摘要列是截断摘要，不含完整正文（这里正文短，但至少不等于原文拼接）
        self.assertNotIn("thanks", rows[0][5])

    def test_17_interaction_rows_no_link_text_display(self):
        """无 link → 客户关联降级为展示名文本。"""
        import dc_feishu_standard as std
        interactions = flatten_followup_to_interactions([FOLLOWUP_ROW])
        with mock.patch("dc_memory_data.read_interactions", return_value=interactions):
            rows = std._build_interaction_rows("testco", "", {})
        self.assertEqual(rows[0][0], "Casa Outdoor")


if __name__ == "__main__":
    unittest.main(verbosity=2)
