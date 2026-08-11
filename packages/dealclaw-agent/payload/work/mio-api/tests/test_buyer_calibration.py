#!/usr/bin/env python3
import importlib
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import dc_buyer_state
import dc_customer_import
import dc_feedback
import heartbeat_data
import dc_ls_store
import dealclaw_search


class BuyerCalibrationRegressionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        data = Path(self.tmp.name)

        dc_buyer_state._DATA_DIR = str(data)
        dc_buyer_state._STATE_FILE = str(data / "buyer_profile_states.json")
        dc_ls_store._DATA_DIR = str(data)
        dc_ls_store._LEADS_FILE = str(data / "leads.json")
        dc_ls_store._PREFS_FILE = str(data / "preferences.json")
        dc_feedback.DATA_DIR = data
        dc_feedback.FEEDBACK_FILE = data / "feedback.jsonl"
        dc_feedback.CORRECTIONS_FILE = data / "corrections_applied.jsonl"
        self._heartbeat_upsert = heartbeat_data.upsert_lead_status
        heartbeat_data.upsert_lead_status = lambda **kwargs: None

    def tearDown(self):
        heartbeat_data.upsert_lead_status = self._heartbeat_upsert
        self.tmp.cleanup()

    @staticmethod
    def _store():
        class NoopAudit:
            def log(self, *args, **kwargs):
                return None

        store = dc_ls_store.LeadStore()
        store._audit = NoopAudit()
        return store

    def test_individual_annotations_are_evidence_not_dialogue_rounds(self):
        store = self._store()
        for i in range(2):
            store.save_lead({
                "company_cdp_id": f"CO{i}",
                "company_name": f"Brand {i}",
                "domain": f"brand{i}.example",
                "country": "DE",
                "enterprise": "factory.example",
                "user_open_id": "ou_test",
            })
            self.assertTrue(store.annotate(
                f"CO{i}", "ou_test", "我的买家", enterprise="factory.example"
            ))

        state = dc_buyer_state.BuyerState().get_state("factory.example", "ou_test")
        self.assertEqual(state["current_round"], 0)
        self.assertEqual(state["buyer_profile_status"], "draft")
        self.assertFalse(dc_buyer_state.BuyerState().should_auto_search(
            "factory.example", "ou_test"
        ))
        prefs = store.get_user_preferences("ou_test")
        self.assertEqual(prefs["偏好标签"], {})
        self.assertEqual(len(prefs["偏好候选"]), 2)

    def test_single_negative_is_candidate_not_long_term_exclusion(self):
        store = self._store()
        store.save_lead({
            "company_cdp_id": "CO-US",
            "company_name": "US Distributor",
            "domain": "usdist.example",
            "country": "US",
            "enterprise": "factory.example",
            "user_open_id": "ou_test",
        })
        self.assertTrue(store.annotate(
            "CO-US", "ou_test", "不是我的买家", reason="区域不覆盖",
            enterprise="factory.example",
        ))
        prefs = store.get_user_preferences("ou_test")
        self.assertEqual(prefs["排除国家"], [])
        self.assertEqual(prefs["排除规则"], [])
        self.assertEqual(prefs["排除候选"][0]["type"], "区域不覆盖")

    def test_one_natural_language_reply_is_exactly_one_round_and_builds_plan(self):
        result = dc_feedback.record_buyer_feedback_turn(
            "factory.example",
            "ou_test",
            "我要德国品牌商，不要分销商，产品改成 outdoor lighting",
            {
                "assessment": "correcting",
                "profile_patch": {
                    "country": {"include": ["DE"]},
                    "buyer_type": {
                        "prefer": ["品牌商"],
                        "avoid_current": ["分销商"],
                    },
                    "product": {"prefer": ["outdoor lighting"]},
                },
                "positive_examples": ["A Brand", "B Brand"],
                "negative_examples": ["C Distributor", "D Distributor"],
                "explicit_long_term_rules": [],
            },
        )
        self.assertEqual(result["current_round"], 1)
        self.assertEqual(result["recommended_action"], "rerun_with_updated_profile")
        self.assertFalse(result["confirmed"])
        self.assertFalse(result["should_auto_search"])

        plan = dc_buyer_state.BuyerState().get_search_plan("factory.example", "ou_test")
        self.assertEqual(plan["countries"], ["DE"])
        self.assertEqual(plan["products"], ["outdoor lighting"])
        self.assertEqual(plan["preferred_buyer_types"], ["品牌商"])
        self.assertEqual(plan["avoided_buyer_types"], ["分销商"])

    def test_search_calibration_filters_avoid_and_reranks_preference(self):
        records = [
            {"companyName": "Plain Shop", "companyAttributes": ["零售商"], "companyProfile": "retailer"},
            {"companyName": "Own Brand GmbH", "companyAttributes": ["零售商"], "companyProfile": "brand owner"},
            {"companyName": "Trade GmbH", "companyAttributes": ["分销商"], "companyProfile": "distributor"},
        ]
        kept, report = dealclaw_search.apply_buyer_type_calibration(records, {
            "preferred_buyer_types": ["品牌商"],
            "avoided_buyer_types": ["分销商"],
        })
        self.assertEqual([r["companyName"] for r in kept], ["Own Brand GmbH", "Plain Shop"])
        self.assertEqual(report["avoided_removed"], 1)
        self.assertTrue(report["preferred_reranked"])

    def test_search_plan_mutates_actual_request_arguments(self):
        args = Namespace(
            country="US",
            keyword=None,
            profile_keyword="old product",
            tag_keyword=None,
            company_attributes="2",
        )
        dealclaw_search.apply_calibration_to_args(args, {
            "countries": ["DE"],
            "excluded_countries": ["US"],
            "products": ["outdoor lighting"],
            "company_attributes": [3],
        })
        self.assertEqual(args.country, "DE")
        self.assertEqual(args.profile_keyword, "outdoor lighting")
        self.assertEqual(args.company_attributes, "3")

    def test_excluding_only_requested_country_blocks_broad_fallback(self):
        args = Namespace(
            country="US",
            keyword=None,
            profile_keyword="lighting",
            tag_keyword=None,
            company_attributes=None,
        )
        with self.assertRaises(ValueError):
            dealclaw_search.apply_calibration_to_args(args, {
                "countries": [],
                "excluded_countries": ["US"],
                "products": [],
                "company_attributes": [],
            })

    def test_legacy_annotation_batch_cannot_confirm_or_advance_dialogue_round(self):
        state = dc_buyer_state.BuyerState()
        state.record_review_round("factory.example", "ou_test", 1, 0)
        after = state.record_review_round("factory.example", "ou_test", 1, 0)
        self.assertEqual(after["current_round"], 0)
        self.assertEqual(after["annotation_batch_count"], 2)
        self.assertNotEqual(after["buyer_profile_status"], "confirmed")
        self.assertFalse(state.should_auto_search("factory.example", "ou_test"))

    def test_continue_never_confirms_draft_profile(self):
        state = dc_buyer_state.BuyerState()
        state.continue_current("factory.example", "ou_test")
        after = state.get_state("factory.example", "ou_test")
        self.assertEqual(after["buyer_profile_status"], "draft")
        self.assertFalse(state.should_auto_search("factory.example", "ou_test"))


if __name__ == "__main__":
    unittest.main()
