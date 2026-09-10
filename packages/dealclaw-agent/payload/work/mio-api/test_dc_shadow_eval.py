#!/usr/bin/env python3
"""test_dc_shadow_eval.py — 影子评估与压缩 harness 测试（标准库 unittest）

覆盖需求 6/7/8/9：
  - 7 个场景（邮件/回复/展前/展中/展后/无任务/数据异常）都能构造 snapshot 并出样本
  - 汇总：Guard 拦截率 / fallback 比例 / Token·延迟 / 场景覆盖
  - 匿名并排 review：A/B 随机且与 key 一致
  - 敏感信息扫描：识别 API Key / 请求头 / 未脱敏 PII；允许合成邮箱

运行：cd work/mio-api && python3 test_dc_shadow_eval.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_shadow_eval import (  # noqa: E402
    SCENARIOS, build_snapshot, collect_samples, write_review, summarize, scan_artifacts,
)
from dc_llm_advisor import MockLLMClient, LLMAdvisor, LLMAdvisorError, ERROR_TIMEOUT  # noqa: E402

GOOD = json.dumps({"advices": [{
    "advice_key": "llm_1", "claim": "优先跟进有证据客户", "confidence": "medium",
    "confidence_reason": "r", "assumptions": [], "counter_evidence": [], "limitations": [],
    "recommendation": "先跟进", "evidence_refs": [], "action_refs": [], "fact_refs": []}]},
    ensure_ascii=False)


class TestScenarios(unittest.TestCase):
    def test_all_scenarios_build(self):
        for name in SCENARIOS:
            snap, plan = build_snapshot(name, day=0)
            self.assertTrue(hasattr(snap, "candidates"), name)
            self.assertIsInstance(plan.get("actions"), list, name)

    def test_scenarios_cover_expected_kinds(self):
        # 无任务场景候选为空；数据异常场景应带数据质量风险
        snap, plan = build_snapshot("no_task", 0)
        self.assertEqual(len(snap.candidates), 0)
        snap2, plan2 = build_snapshot("data_anomaly", 0)
        cats = {c["category"] for c in plan2.get("context", []) if c["kind"] == "risk"}
        self.assertIn("data_quality", cats)


class TestCollectAndSummarize(unittest.TestCase):
    def test_collect_samples(self):
        tmp = Path(tempfile.mkdtemp(prefix="dc-shadow-"))
        samples = collect_samples(["email", "no_task"], days=1,
                                  advisor=LLMAdvisor(MockLLMClient(GOOD)), out_dir=tmp)
        self.assertEqual(len(samples), 2)
        self.assertTrue(all("llm" in s and "template" in s for s in samples))

    def test_summarize_ratios(self):
        tmp = Path(tempfile.mkdtemp(prefix="dc-shadow-"))
        samples = collect_samples(["email"], days=2,
                                  advisor=LLMAdvisor(MockLLMClient(exc=LLMAdvisorError(ERROR_TIMEOUT, "x"))),
                                  out_dir=tmp)
        s = summarize(samples)
        self.assertEqual(s["samples"], 2)
        self.assertEqual(s["fallback_ratio"], 1.0)
        self.assertIn(ERROR_TIMEOUT, s["fallback_reasons"])
        self.assertIn("by_scenario", s)

    def test_summarize_ok_path(self):
        tmp = Path(tempfile.mkdtemp(prefix="dc-shadow-"))
        samples = collect_samples(["email", "reply"], days=1,
                                  advisor=LLMAdvisor(MockLLMClient(GOOD)), out_dir=tmp)
        s = summarize(samples)
        self.assertGreaterEqual(s["llm_ok"], 1)
        self.assertLessEqual(s["max_advices_ok"], 3)


class TestAnonymousReview(unittest.TestCase):
    def test_review_anonymized_and_key_consistent(self):
        tmp = Path(tempfile.mkdtemp(prefix="dc-shadow-"))
        samples = collect_samples(["email"], days=1,
                                  advisor=LLMAdvisor(MockLLMClient(GOOD)), out_dir=tmp)
        key = write_review(tmp, samples, seed=1)
        self.assertTrue((tmp / "review.md").exists())
        self.assertTrue((tmp / "review-key.json").exists())
        for v in key.values():
            self.assertEqual({v["A"], v["B"]}, {"template", "llm"})


class TestSecretScan(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="dc-scan-"))

    def test_detects_secret_and_pii(self):
        (self._tmp / "leak.md").write_text(
            "key sk-abcdefghijklmnopqrstuvwx\nAuthorization: Bearer abcdef123456\n"
            "real.person@gmail.com\n", encoding="utf-8")
        r = scan_artifacts(self._tmp)
        self.assertFalse(r["secret_clean"])
        self.assertFalse(r["pii_clean"])
        kinds = {f["kind"] for f in r["secret_findings"]}
        self.assertIn("api_key", kinds)
        self.assertIn("auth_header", kinds)

    def test_clean_dir_with_synthetic_emails(self):
        (self._tmp / "ok.json").write_text(
            json.dumps({"target": "buyer0@x.com", "note": "synthetic test data"},
                       ensure_ascii=False), encoding="utf-8")
        r = scan_artifacts(self._tmp)
        self.assertTrue(r["secret_clean"])
        self.assertTrue(r["pii_clean"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
