#!/usr/bin/env python3
"""dc_session_distill 测试：四路分流、幂等、隔离（全部离线，写临时目录）。"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dc_rules  # noqa: E402
import dc_session_distill as sd  # noqa: E402


class DistillTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        os.environ["OPENCLAW_WORKSPACE_DIR"] = self.tmp.name
        self.cid = "c1"
        self.oid = "ou_test"
        (self.root / "data" / "memory" / self.cid).mkdir(parents=True)

        # 隔离 rules.md：真实实现走 dc_rules 的模块相对路径，测试必须把它也指向临时目录，
        # 否则会污染真实仓库（2026-09-17 踩过：测试写进了 memory/company/<id>/rules.md）
        import dc_rules
        self._orig_rules_memory_dir = dc_rules.MEMORY_DIR
        dc_rules.MEMORY_DIR = self.root / "memory"
        self.rules_dir = self.root / "memory" / "company" / self.cid

    def tearDown(self):
        dc_rules.MEMORY_DIR = self._orig_rules_memory_dir
        os.environ.pop("OPENCLAW_WORKSPACE_DIR", None)
        self.tmp.cleanup()

    def facts(self):
        return [
            {"kind": "company_fact", "data": {"products": ["stand up pouch"], "target_markets": ["BR"]}},
            {"kind": "long_term_rule", "text": "东南亚只做印尼、越南"},
            {"kind": "business_reflection", "what": "偏好先给数量再给明细", "type": "preference"},
            {"kind": "user_profile", "text": "习惯早上看日报"},
        ]


class TestRoute(DistillTestCase):
    def test_1_dry_run_writes_nothing(self):
        sd.route(self.facts(), company_id=self.cid, open_id=self.oid, dry_run=True)
        self.assertFalse((self.root / "memory" / "people" / f"{self.oid}.md").exists())
        self.assertFalse((self.rules_dir / "rules.md").exists())
        self.assertFalse((self.root / "memory" / "projects" / "dealclaw" / "reflections.jsonl").exists())

    def test_2_route_writes_all_four_stores(self):
        sd.route(self.facts(), company_id=self.cid, open_id=self.oid, dry_run=False)
        # ① 企业事实 → profile
        kb = json.loads((self.root / "data" / "memory" / self.cid / "kb.json").read_text(encoding="utf-8"))
        self.assertEqual(kb["profile"]["products"], ["stand up pouch"])
        self.assertEqual(kb["profile"]["target_markets"], ["BR"])
        # ② 长期规则 → rules.md
        self.assertIn("东南亚只做印尼、越南", (self.rules_dir / "rules.md").read_text(encoding="utf-8"))
        # ③ 业务反思 → reflections.jsonl
        refl = (self.root / "memory" / "projects" / "dealclaw" / "reflections.jsonl").read_text(encoding="utf-8")
        self.assertIn("偏好先给数量再给明细", refl)
        self.assertEqual(json.loads(refl.strip())["type"], "preference")
        # ④ 用户卡 → people/<open_id>.md
        self.assertIn("习惯早上看日报",
                      (self.root / "memory" / "people" / f"{self.oid}.md").read_text(encoding="utf-8"))

    def test_3_idempotent(self):
        sd.route(self.facts(), company_id=self.cid, open_id=self.oid, dry_run=False)
        r = sd.route(self.facts(), company_id=self.cid, open_id=self.oid, dry_run=False)
        self.assertEqual(len((self.rules_dir / "rules.md").read_text(encoding="utf-8").strip().splitlines()), 1)
        self.assertEqual(len((self.root / "memory" / "projects" / "dealclaw" / "reflections.jsonl")
                             .read_text(encoding="utf-8").strip().splitlines()), 1)
        self.assertEqual(len((self.root / "memory" / "people" / f"{self.oid}.md")
                             .read_text(encoding="utf-8").strip().splitlines()), 1)
        self.assertEqual(r["by_kind"]["long_term_rule"][0]["status"], "duplicate")
        self.assertEqual(r["by_kind"]["user_profile"][0]["status"], "duplicate")

    def test_4_unknown_kind_not_dropped_silently(self):
        r = sd.route([{"kind": "nonsense", "text": "x"}], company_id=self.cid, dry_run=False)
        self.assertEqual(len(r["unknown"]), 1)

    def test_5_empty_input_is_safe(self):
        r = sd.route([], company_id=self.cid, open_id=self.oid, dry_run=False)
        self.assertTrue(r["ok"])
        self.assertEqual(r["written"], 0)

    def test_6_user_profile_without_open_id_skipped(self):
        r = sd.route([{"kind": "user_profile", "text": "x"}], company_id=self.cid, dry_run=False)
        self.assertEqual(r["by_kind"]["user_profile"][0]["status"], "skipped")

    def test_7_company_facts_merge_not_overwrite(self):
        sd.route([{"kind": "company_fact", "data": {"usp": "第一版"}}], company_id=self.cid, dry_run=False)
        sd.route([{"kind": "company_fact", "data": {"usp": "第二版"}}], company_id=self.cid, dry_run=False)
        kb = json.loads((self.root / "data" / "memory" / self.cid / "kb.json").read_text(encoding="utf-8"))
        self.assertEqual(kb["profile"]["usp"], "第一版", "标量不得被覆盖")

    def test_10_company_fact_lands_in_memory_canonical(self):
        """canonical 记录在 memory/company/<id>/facts.md（人可读、格式固定）。"""
        sd.route([{"kind": "company_fact", "data": {"products": ["stand up pouch"]}}],
                 company_id=self.cid, dry_run=False)
        f = self.root / "memory" / "company" / self.cid / "facts.md"
        self.assertTrue(f.exists(), "企业事实必须落 memory（agent 可读可查）")
        text = f.read_text(encoding="utf-8")
        self.assertIn("| 字段 | 值 | 来源 | 时间 |", text, "格式必须固定")
        self.assertIn("| 产品线 | stand up pouch |", text)
        # 二次写入同值 → 不重复加行
        sd.route([{"kind": "company_fact", "data": {"products": ["stand up pouch"]}}],
                 company_id=self.cid, dry_run=False)
        self.assertEqual(f.read_text(encoding="utf-8").count("stand up pouch"), 1)

    def test_11_same_value_repeat_not_recorded_as_conflict(self):
        sd.route([{"kind": "company_fact", "data": {"usp": "同一句"}}], company_id=self.cid, dry_run=False)
        sd.route([{"kind": "company_fact", "data": {"usp": "同一句"}}], company_id=self.cid, dry_run=False)
        kb = json.loads((self.root / "data" / "memory" / self.cid / "kb.json").read_text(encoding="utf-8"))
        self.assertNotIn("_skipped_updates", kb["profile"], "同值重复不算冲突")


class TestSweep(DistillTestCase):
    def test_8_sweep_harvests_existing_material(self):
        (self.root / "data" / "memory" / self.cid / "notes.md").write_text(
            "我们主营: packaging bag。通过 CE，成立于 2005 年。市场 Brazil。", encoding="utf-8")
        r = sd.sweep(self.cid, dry_run=False)
        self.assertTrue(r["profile"]["wrote"])
        kb = json.loads((self.root / "data" / "memory" / self.cid / "kb.json").read_text(encoding="utf-8"))
        self.assertIn("packaging bag", kb["profile"]["products"])
        self.assertEqual(kb["profile"]["founded"], "2005")

    def test_9_sweep_no_material_is_noop(self):
        r = sd.sweep(self.cid, dry_run=False)
        self.assertFalse(r["profile"]["wrote"])


if __name__ == "__main__":
    unittest.main()
