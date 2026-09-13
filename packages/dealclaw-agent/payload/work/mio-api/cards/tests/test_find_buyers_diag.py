#!/usr/bin/env python3
"""find-buyers 诊断埋点测试（观测层，不改变交付行为）。

验的是：阶段耗时能记、用量缺就记 null（不编）、候选只落假名、
flush 之后 aggregate() 能算出分页分数分布。
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

CARDS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CARDS))

import find_buyers_diag as diag  # noqa: E402


class StageTimingTests(unittest.TestCase):
    def test_stage_context_manager_records_ms(self):
        with tempfile.TemporaryDirectory() as td:
            d = diag.JobDiagnostics("fb_x", "t1", "oc_1", jobs_log=Path(td) / "j.jsonl",
                                    candidates_log=Path(td) / "c.jsonl")
            with d.stage("search"):
                pass
            self.assertIn("search", d.stages)
            self.assertEqual(d.stages["search"]["count"], 1)
            self.assertIsNotNone(d.stages["search"]["last_ms"])

    def test_summary_keeps_all_stage_slots(self):
        with tempfile.TemporaryDirectory() as td:
            d = diag.JobDiagnostics("fb_x", jobs_log=Path(td) / "j.jsonl")
            d.record_stage("pool", 12.5)
            s = d.summary()
            self.assertEqual(set(diag.STAGES) - set(s["stages"]), set())  # 六个阶段都在
            self.assertEqual(s["stages"]["pool"]["total_ms"], 12.5)

    def test_bad_duration_is_ignored(self):
        with tempfile.TemporaryDirectory() as td:
            d = diag.JobDiagnostics("fb_x", jobs_log=Path(td) / "j.jsonl")
            d.record_stage("qualify", None)
            d.record_stage("qualify", "abc")
            self.assertEqual(d.stages["qualify"]["count"], 0)


class LlmUsageTests(unittest.TestCase):
    def test_unknown_usage_is_null_not_fabricated(self):
        with tempfile.TemporaryDirectory() as td:
            d = diag.JobDiagnostics("fb_x", jobs_log=Path(td) / "j.jsonl")
            d.record_llm("qualify", calls=None, input_tokens=None, output_tokens=None)
            slot = d.summary()["llm"]["qualify"]
            self.assertFalse(slot["calls_known"])
            self.assertFalse(slot["tokens_known"])
            self.assertEqual(slot["calls"], 0)          # 未累加，但 known=False 标明未知
            self.assertEqual(slot["input_tokens"], 0)

    def test_known_usage_accumulates(self):
        with tempfile.TemporaryDirectory() as td:
            d = diag.JobDiagnostics("fb_x", jobs_log=Path(td) / "j.jsonl")
            d.record_llm("qualify", calls=2, input_tokens=1000, output_tokens=200)
            d.record_llm("qualify", calls=3, input_tokens=500, output_tokens=100)
            slot = d.summary()["llm"]["qualify"]
            self.assertTrue(slot["tokens_known"])
            self.assertEqual(slot["calls"], 5)
            self.assertEqual(slot["input_tokens"], 1500)
            self.assertEqual(slot["output_tokens"], 300)


class CandidateSanitizationTests(unittest.TestCase):
    def test_no_company_name_is_written(self):
        with tempfile.TemporaryDirectory() as td:
            jobs, cands = Path(td) / "j.jsonl", Path(td) / "c.jsonl"
            d = diag.JobDiagnostics("fb_x", "t1", "oc_1", jobs_log=jobs, candidates_log=cands)
            d.add_candidate("PACIFIC TRANSMISSION CO", page=1, position=3, score=88.5,
                            qualified=True, excluded_reason="", delivered=True)
            d.add_candidate("ACME TRADING", page=1, position=4, score=61,
                            qualified=False, excluded_reason="同行/自产自用", delivered=False)
            d.flush()
            blob = cands.read_text(encoding="utf-8")
            self.assertNotIn("PACIFIC", blob)
            self.assertNotIn("ACME", blob)
            self.assertIn("buyer_", blob)

    def test_pseudonym_is_stable(self):
        with tempfile.TemporaryDirectory() as td:
            d = diag.JobDiagnostics("fb_x", jobs_log=Path(td) / "j.jsonl")
            a = d.add_candidate("SAME CO", page=1, position=1)["candidate_id"]
            b = d.add_candidate("SAME CO", page=2, position=9)["candidate_id"]
            self.assertEqual(a, b)

    def test_missing_score_stays_null(self):
        with tempfile.TemporaryDirectory() as td:
            d = diag.JobDiagnostics("fb_x", jobs_log=Path(td) / "j.jsonl")
            row = d.add_candidate("NO SCORE CO", page=1, position=1, score=None)
            self.assertIsNone(row["score"])
            self.assertEqual(d.summary()["candidates"]["unscored"], 1)


class FlushAndAggregateTests(unittest.TestCase):
    def _write_jobs(self, td, n=3):
        jobs, cands = Path(td) / "j.jsonl", Path(td) / "c.jsonl"
        for i in range(n):
            d = diag.JobDiagnostics(f"fb_{i}", "t1", "oc_1", jobs_log=jobs, candidates_log=cands)
            d.record_stage("search", 1000 + i * 100)
            d.record_stage("pool", 500)
            d.record_llm("qualify", calls=4, input_tokens=20000, output_tokens=3000)
            for pos, score in enumerate([4.0, 3.5, 3.1, 3.0, 2.0], start=1):
                d.add_candidate(f"CO{i}-{pos}", page=1, position=pos, score=score,
                                qualified=score >= 3.0, delivered=score >= 3.1)
            for pos, score in enumerate([3.2, 2.5, 1.0], start=1):
                d.add_candidate(f"P2CO{i}-{pos}", page=2, position=pos, score=score,
                                qualified=False, excluded_reason="相关性不足")
            d.flush()
        return jobs, cands

    def test_flush_writes_one_line_per_job_and_candidate(self):
        with tempfile.TemporaryDirectory() as td:
            jobs, cands = self._write_jobs(td, n=2)
            self.assertEqual(len(jobs.read_text(encoding="utf-8").strip().splitlines()), 2)
            self.assertEqual(len(cands.read_text(encoding="utf-8").strip().splitlines()), 16)

    def test_aggregate_per_page_distribution(self):
        with tempfile.TemporaryDirectory() as td:
            jobs, _ = self._write_jobs(td, n=3)
            agg = diag.aggregate(jobs, last_n=10)
            self.assertEqual(agg["jobs"], 3)
            self.assertEqual(agg["stage_ms"]["search"]["p50"], 1100.0)   # 1000/1100/1200 → 中位数
            self.assertEqual(agg["tokens_total"]["qualify"]["p50"], 23000.0)
            p1, p2 = agg["per_page_scores"]["1"], agg["per_page_scores"]["2"]
            self.assertEqual(p1["scored"], 15)
            self.assertEqual(p1["ge_3_5"], 6)     # 每任务 4.0/3.5 = 2
            self.assertEqual(p1["ge_3_1"], 9)     # + 3.1
            self.assertEqual(p1["ge_3_0"], 12)    # + 3.0
            self.assertEqual(p2["scored"], 9)
            self.assertEqual(p2["ge_3_0"], 3)     # 每任务 3.2
            self.assertEqual(agg["delivered"]["p50"], 3.0)

    def test_flush_is_silent_on_bad_path(self):
        d = diag.JobDiagnostics("fb_x", jobs_log=Path("/proc/definitely/not/writable.jsonl"))
        d.add_candidate("X CO", page=1, position=1, score=80)
        d.flush()  # 不抛异常


if __name__ == "__main__":
    unittest.main(verbosity=2)
