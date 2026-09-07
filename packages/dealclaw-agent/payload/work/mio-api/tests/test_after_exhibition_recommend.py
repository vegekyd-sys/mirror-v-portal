#!/usr/bin/env python3
"""test_after_exhibition_recommend.py — 展后买家推荐单元测试。

覆盖用户规格的 21 个场景：候选门禁 / 线索池边界 / 建联判定 / 四组分流 /
去重 / 排序理由 / scope 统计 / conflicted。
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_after_exhibition_recommend import (  # noqa: E402
    recommend,
    is_connected,
    has_touch,
    is_suppressed,
    is_in_scope,
)

TARGET = "exh_2026_mexico"
IDEAL = {"products": ["outdoor furniture", "hotel furniture"]}


def buyer(**kw):
    base = {
        "companyCdpId": "cdp_001",
        "companyName": "Casa Outdoor",
        "country": "MX",
        "website": "www.casaoutdoor.mx",
        "exhibition_id": TARGET,
        "source": "after-exhibition-recommend",
        "product_tags": ["outdoor furniture"],
        "confirmed_onsite": True,
        "has_contact": True,
    }
    base.update(kw)
    return base


def pool_entry(**kw):
    base = {"companyCdpId": "cdp_001", "companyName": "Casa Outdoor", "website": "www.casaoutdoor.mx"}
    base.update(kw)
    return base


class TestScopeGate(unittest.TestCase):
    def test_1_pool_only_not_recommended(self):
        """只在线索池、不在本届名单 → 不推荐。"""
        r = recommend(TARGET, candidates=[], historical_pool=[pool_entry(companyCdpId="cdp_999", has_reply=True)], ideal_profile=IDEAL)
        all_buyers = r["uncontacted_recommendations"] + r["contacted_but_not_connected"] + r["connected_followups"] + r["suppressed"]
        self.assertNotIn("cdp_999", [b.get("companyCdpId") for b in all_buyers])

    def test_2_previous_exhibition_not_recommended(self):
        """属于往届展会 → 不推荐。"""
        r = recommend(TARGET, candidates=[buyer(companyCdpId="cdp_prev", exhibition_id="exh_2025", source="invitation")], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(r["scope"]["out_of_scope_excluded"], 1)
        self.assertEqual(r["scope"]["current_exhibition_candidates"], 0)

    def test_3_current_and_pool_merged_kept(self):
        """本届名单 + 线索池同时存在 → 合并后保留。"""
        r = recommend(TARGET, candidates=[buyer()], historical_pool=[pool_entry(has_outbound=True)], ideal_profile=IDEAL)
        self.assertEqual(r["scope"]["lead_pool_enriched"], 1)
        # 本届 buyer 在结果里（历史单向 → contacted_but_not_connected）
        self.assertEqual(len(r["contacted_but_not_connected"]), 1)

    def test_4_pool_history_reply_connected(self):
        """历史回复 → connected_followups。"""
        r = recommend(TARGET, candidates=[buyer()], historical_pool=[pool_entry(has_reply=True)], ideal_profile=IDEAL)
        self.assertEqual(len(r["connected_followups"]), 1)

    def test_5_pool_history_oneway_contacted_not_connected(self):
        """历史只有单向邮件 → contacted_but_not_connected。"""
        r = recommend(TARGET, candidates=[buyer()], historical_pool=[pool_entry(has_outbound=True)], ideal_profile=IDEAL)
        self.assertEqual(len(r["contacted_but_not_connected"]), 1)

    def test_6_pool_high_match_not_recommended(self):
        """线索池高匹配买家（不在本届名单）→ 不推荐。"""
        r = recommend(TARGET, candidates=[buyer()], historical_pool=[pool_entry(companyCdpId="cdp_high", has_reply=True)], ideal_profile=IDEAL)
        all_cdps = [b.get("companyCdpId") for b in r["uncontacted_recommendations"] + r["contacted_but_not_connected"] + r["connected_followups"] + r["suppressed"]]
        self.assertNotIn("cdp_high", all_cdps)

    def test_7_statistics_only_current(self):
        """统计数量只算本届候选。"""
        r = recommend(TARGET, candidates=[
            buyer(companyCdpId="c1", website="www.c1.com"),
            buyer(companyCdpId="c2", website="www.c2.com"),
            buyer(companyCdpId="c3", website="www.c3.com", exhibition_id="exh_2025", source="invitation"),
        ], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(r["statistics"]["attended_buyers"], 2)  # 只算本届 2 条
        self.assertEqual(r["scope"]["out_of_scope_excluded"], 1)

    def test_8_missing_target_exhibition_id(self):
        """缺少 target_exhibition_id → 不执行。"""
        r = recommend("", candidates=[buyer()], historical_pool=[], ideal_profile=IDEAL)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "missing_target_exhibition_id")

    def test_9_exhibition_id_conflict(self):
        """来源记录 exhibition_id 冲突 → conflicted。"""
        r = recommend(TARGET, candidates=[buyer(exhibition_conflict=True)], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["conflicted"]), 1)


class TestConnectionJudgement(unittest.TestCase):
    def test_10_invitation_no_meeting_continue(self):
        """邀约但未会面 → 继续推荐（已触达未建联）。"""
        r = recommend(TARGET, candidates=[buyer(has_invitation=True)], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["contacted_but_not_connected"]), 1)

    def test_11_scan_no_followup_continue(self):
        """扫码但无后续 → 继续推荐（扫码不算建联成功）。"""
        r = recommend(TARGET, candidates=[buyer(has_scan=True)], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["contacted_but_not_connected"]), 1)

    def test_12_oneway_email_no_reply_continue(self):
        """单向邮件无回复 → 继续推荐。"""
        r = recommend(TARGET, candidates=[buyer(has_email_out=True)], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["contacted_but_not_connected"]), 1)

    def test_13_onsite_no_substantive_continue(self):
        """到展但无实质沟通 → 未触达推荐。"""
        r = recommend(TARGET, candidates=[buyer(confirmed_onsite=True)], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["uncontacted_recommendations"]), 1)

    def test_14_is_meeting_connected(self):
        """isMeeting=1 → 已建联待推进。"""
        r = recommend(TARGET, candidates=[buyer(isMeeting=1)], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["connected_followups"]), 1)

    def test_15_email_replied_connected(self):
        """邮件 replied/inbound → 已建联待推进。"""
        r = recommend(TARGET, candidates=[buyer(email_replied=True)], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["connected_followups"]), 1)

    def test_16_wa_bidirectional_connected(self):
        """WA 双向 → 已建联待推进。"""
        r = recommend(TARGET, candidates=[buyer(wa_bidirectional=True)], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["connected_followups"]), 1)

    def test_17_meeting_scheduled_not_completed_continue(self):
        """只预约会议但未完成 → 继续推荐。"""
        r = recommend(TARGET, candidates=[buyer(has_invitation=True, has_meeting_interaction=False)], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["contacted_but_not_connected"]), 1)

    def test_18_multi_source_same_company_once(self):
        """多数据源同一公司 → 只出现一次。"""
        r = recommend(TARGET, candidates=[buyer(source="invitation"), buyer(source="scan")], historical_pool=[], ideal_profile=IDEAL)
        total = len(r["uncontacted_recommendations"]) + len(r["contacted_but_not_connected"]) + len(r["connected_followups"])
        self.assertEqual(total, 1)

    def test_19_denied_or_cancelled_suppressed(self):
        """明确拒绝/项目取消 → 不再推荐。"""
        r = recommend(TARGET, candidates=[
            buyer(companyCdpId="c_deny", website="www.deny.com", denied=True),
            buyer(companyCdpId="c_cancel", website="www.cancel.com", cancelled=True),
        ], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["suppressed"]), 2)

    def test_20_connected_with_quote(self):
        """已建联且待报价 → connected_followups。"""
        r = recommend(TARGET, candidates=[buyer(isMeeting=1, 待报价=True)], historical_pool=[], ideal_profile=IDEAL)
        self.assertEqual(len(r["connected_followups"]), 1)
        self.assertEqual(r["connected_followups"][0]["followup_kind"], "待报价")

    def test_21_recommendations_have_reason(self):
        """每条推荐都有证据化理由。"""
        r = recommend(TARGET, candidates=[buyer(), buyer(companyCdpId="c2", has_scan=True)], historical_pool=[], ideal_profile=IDEAL)
        for b in r["uncontacted_recommendations"] + r["contacted_but_not_connected"]:
            self.assertTrue(b.get("reason"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
