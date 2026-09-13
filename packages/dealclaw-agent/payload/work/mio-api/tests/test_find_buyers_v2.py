#!/usr/bin/env python3
"""find_buyers_v2 测试：确定性前置、三模式、联系方式后置、脱敏与 replay。"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import random
import sys
import tempfile
import unittest
from pathlib import Path

MIO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIO))

from find_buyers_v2 import (  # noqa: E402
    contact_plan, dedupe, estimate_tokens, field_issues, matches_exhibition,
    model_summary, normalize_record, redact_for_fixture, run_legacy, run_shadow, run_v2,
)
from find_buyers_v2.replay import load_fixture, render_markdown, replay  # noqa: E402

FIXTURE = MIO / "tests" / "fixtures" / "find_buyers" / "synthetic_3pages.json"


def _pages(*records, page=1):
    return [{"page": page, "records": list(records)}]


class NormalizeTests(unittest.TestCase):
    def test_keys_match_legacy_normalizers(self):
        import dc_ls_store
        rec = {"companyName": "Pacific Transmission Co., Ltd.", "companyWebsite": "https://www.PacificTransmission.com/en?x=1"}
        n = normalize_record(rec)
        self.assertEqual(n["key_domain"], dc_ls_store.normalize_domain(rec["companyWebsite"]))
        self.assertEqual(n["key_company"], dc_ls_store.normalize_company_name(rec["companyName"]))

    def test_field_issues_are_flagged_not_dropped(self):
        n = normalize_record({"companyName": "X TRADING"})
        self.assertIn("缺买家类型", field_issues(n))
        self.assertIn("缺匹配产品", field_issues(n))
        self.assertIn("缺国家", field_issues(n))

    def test_score_missing_is_none_not_zero(self):
        self.assertIsNone(normalize_record({"companyName": "A"}).get("score"))
        self.assertEqual(normalize_record({"companyName": "A", "AI匹配分": "88"}).get("score"), 88.0)


class ExhibitionTests(unittest.TestCase):
    def test_mismatch_filtered_with_reason(self):
        recs = [{"companyName": "MATCH CO", "companyWebsite": "m.com", "preExhibitionIds": ["111"], "AI匹配分": 80},
                {"companyName": "OTHER CO", "companyWebsite": "o.com", "preExhibitionIds": ["222"], "AI匹配分": 90}]
        out = run_v2(_pages(*recs), deliver_limit=10, target_exhibition_ids=["111"])
        delivered = [n["company"] for n in out["delivered"]]
        self.assertEqual(delivered, ["MATCH CO"])
        self.assertEqual([e["excluded_reason"] for e in out["excluded"]], ["展会ID不匹配"])

    def test_no_target_means_no_filtering(self):
        recs = [{"companyName": "A", "companyWebsite": "a.com", "preExhibitionIds": ["9"]}]
        self.assertTrue(matches_exhibition(normalize_record(recs[0]), []))


class DedupeTests(unittest.TestCase):
    def setUp(self):
        self.recs = [
            {"companyName": "PACIFIC TRANSMISSION", "companyWebsite": "pacifictransmission.com", "AI匹配分": 88, "country": "MY"},
            {"companyName": "PACIFIC TRANSMISSION", "companyWebsite": "http://www.pacifictransmission.com/en", "AI匹配分": 90, "country": "MY"},
            {"companyName": "KENNAMETAL SUPPLY", "companyWebsite": "kennametal-dist.com", "AI匹配分": 79},
            {"companyName": "KENNAMETAL SUPPLY", "companyWebsite": "kennametal-trading.de", "AI匹配分": 72},
        ]

    def test_keeps_highest_score_per_key(self):
        norms = [normalize_record(r) for r in self.recs]
        kept, dropped = dedupe(norms)
        self.assertEqual(len(kept), 2)
        self.assertEqual({n["score"] for n in kept}, {90.0, 79.0})
        self.assertEqual(len(dropped), 2)

    def test_order_independent(self):
        norms = [normalize_record(r) for r in self.recs]
        random.Random(7).shuffle(norms)
        kept, _ = dedupe(norms)
        # 2 组：pacifictransmission.com（同域名）+ KENNAMETAL（同名不同域名也算重复）
        self.assertEqual(len(kept), 2)


class ModeTests(unittest.TestCase):
    def test_shadow_has_zero_side_effects(self):
        fixture = load_fixture(FIXTURE)
        before = set(os.listdir("."))
        out = run_shadow(fixture["pages"], deliver_limit=10,
                         target_exhibition_ids=fixture["meta"]["target_exhibition_ids"])
        after = set(os.listdir("."))
        self.assertEqual(before, after)           # 没写任何文件
        self.assertEqual(out["mode"], "shadow")
        self.assertIn("diff", out)
        self.assertNotIn("leads_url", json.dumps(out["v2"]))   # 不发卡/不入池

    def test_v2_excludes_more_than_legacy_on_fixture(self):
        fixture = load_fixture(FIXTURE)
        targets = fixture["meta"]["target_exhibition_ids"]
        legacy = run_legacy(fixture["pages"], deliver_limit=10)
        v2 = run_v2(fixture["pages"], deliver_limit=10, target_exhibition_ids=targets)
        self.assertEqual(legacy["delivered_count"], 10)
        self.assertGreaterEqual(len(v2["excluded"]), 2)                     # 重复 + 展会不匹配
        reasons = {e["excluded_reason"] for e in v2["excluded"]}
        self.assertIn("重复(同域名/同名)", reasons)
        self.assertIn("展会ID不匹配", reasons)
        self.assertLess(v2["model_input_tokens"], estimate_tokens(
            [r for p in fixture["pages"] for r in p["records"]]))           # 摘要确实更小

    def test_semantic_judge_hook_is_used(self):
        recs = [{"companyName": "A", "companyWebsite": "a.com", "companyProfile": "manufacturer", "AI匹配分": 90},
                {"companyName": "B", "companyWebsite": "b.com", "companyProfile": "importer", "AI匹配分": 80}]
        out = run_v2(_pages(*recs), deliver_limit=10, semantic_judge=lambda rows: [False, True])
        self.assertEqual([n["company"] for n in out["delivered"]], ["B"])
        self.assertTrue(any(e["excluded_reason"] == "模型语义剔除" for e in out["excluded"]))


class ContactPlanTests(unittest.TestCase):
    def test_skipped_when_not_requested(self):
        plan = contact_plan([{"company": "A"}], need_contact=False)
        self.assertTrue(plan["skipped"])
        self.assertEqual(plan["batches"], [])

    def test_twenty_pool_in_batches_of_five(self):
        ranked = [{"company": f"C{i}"} for i in range(35)]
        plan = contact_plan(ranked, need_contact=True)
        self.assertFalse(plan["skipped"])
        self.assertEqual(plan["pool"], 20)
        self.assertEqual(plan["batch_size"], 5)
        self.assertEqual(plan["batches"], 4)


class SummarizeTests(unittest.TestCase):
    def test_model_summary_keeps_semantic_signals_drops_contacts(self):
        norms = [normalize_record({
            "companyName": "ACME", "companyWebsite": "acme.com", "country": "US",
            "companyProfile": "Importer of belts", "purchaseTags": ["belts"],
            "companyAttributes": "进口商", "staffSizeLevel": "51-200",
            "preExhibitionIds": ["111"], "email": "a@acme.com", "phone": "+1",
        })]
        rows = model_summary(norms)
        blob = json.dumps(rows, ensure_ascii=False)
        self.assertIn("Importer of belts", blob)
        self.assertIn("进口商", blob)
        self.assertNotIn("a@acme.com", blob)
        self.assertNotIn("+1", blob)
        self.assertGreater(estimate_tokens(rows), 0)

    def test_redact_whitelists_fields_and_pseudonymizes(self):
        norms = [normalize_record({
            "companyName": "ACME TRADING", "companyWebsite": "acme.com", "country": "US",
            "companyProfile": "Importer of belts", "purchaseTags": ["belts"],
            "companyAttributes": "进口商", "staffSizeLevel": "51-200",
            "preExhibitionIds": ["111"], "AI匹配分": 87,
        })]
        rows = redact_for_fixture(norms)
        row = rows[0]
        self.assertTrue(row["candidate_id"].startswith("buyer_"))
        blob = json.dumps(row, ensure_ascii=False)
        self.assertNotIn("ACME", blob)
        self.assertNotIn("acme.com", blob)
        for keep in ("profile", "products", "buyer_type", "size", "exhibitions"):
            self.assertIn(keep, row)

    def test_pseudonym_is_local_hmac_not_plain_hash(self):
        from cards.find_buyers_diag import candidate_id
        salt = (os.environ.get("DC_DIAGNOSTIC_SALT") or "dealclaw-diag-v1").encode("utf-8")
        expected = hmac.new(salt, b"buyer:ACME", hashlib.sha256).hexdigest()[:12]
        self.assertEqual(candidate_id("ACME"), f"buyer_{expected}")
        self.assertNotEqual(candidate_id("ACME"), "buyer_" + hashlib.sha256(b"ACME").hexdigest()[:12])


class ReplayTests(unittest.TestCase):
    def test_replay_report_is_deterministic_and_markdown_renders(self):
        fixture = load_fixture(FIXTURE)
        r1 = replay(fixture, fixture_path=str(FIXTURE))
        r2 = replay(load_fixture(FIXTURE), fixture_path=str(FIXTURE))
        self.assertEqual(json.dumps(r1, ensure_ascii=False, sort_keys=True),
                         json.dumps(r2, ensure_ascii=False, sort_keys=True))
        md = render_markdown(r1)
        self.assertIn("交付对比", md)
        self.assertIn("模型输入（摘要化）", md)
        self.assertEqual(r1["diff"]["v2_count"], 10)

    def test_replay_requires_valid_fixture(self):
        with tempfile.TemporaryDirectory() as td:
            bad = Path(td) / "bad.json"
            bad.write_text(json.dumps({"pages": "nope"}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_fixture(bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
