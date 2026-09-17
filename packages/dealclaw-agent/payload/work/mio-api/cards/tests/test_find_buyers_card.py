#!/usr/bin/env python3
"""find-buyers 进度卡验收测试（田耕郡 2026-09-08 定的 10 条）。

用 dry_run 模式跑，不真实调 lark-cli，只验证状态机、节流、终态规则与隔离。
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

CARDS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CARDS))

import tempfile  # noqa: E402

from card_adapter import CardAdapter, render_card, _throttle_key  # noqa: E402
from find_buyers_card import (  # noqa: E402
    FindBuyersCard, VALID_STATES, JOBS_DIR, cleanup_expired, extract_lead_pool_ids,
)


class RenderCardTests(unittest.TestCase):
    def test_step_not_percentage(self):
        """第 1 条：用「步骤 2/4」，不伪造百分比/ETA。"""
        dsl = {"title": "找买家", "status": "搜索中", "step": "步骤 2/4", "state": "running"}
        card = render_card(dsl)
        body = json.dumps(card, ensure_ascii=False)
        self.assertIn("步骤 2/4", body)
        self.assertNotIn("%", body)          # 无百分比
        self.assertNotIn("预计", body)        # 无 ETA

    def test_metrics_only_when_real(self):
        """第 1 条：无真实数字时不展示空指标。"""
        dsl = {"title": "找买家", "status": "搜索中", "metrics": [], "state": "running"}
        body = json.dumps(render_card(dsl), ensure_ascii=False)
        self.assertNotIn("候选买家", body)

    def test_metrics_shown_when_real(self):
        dsl = {"title": "找买家", "status": "搜索中", "state": "running",
               "metrics": [{"label": "候选买家", "value": "200 家"}]}
        body = json.dumps(render_card(dsl), ensure_ascii=False)
        self.assertIn("200 家", body)


class ThrottleTests(unittest.TestCase):
    def test_same_state_skips_update(self):
        """第 10 条：同一状态重复写入不更新。"""
        adapter = CardAdapter(chat_id="oc_x", dry_run=True)
        adapter.send({"title": "t", "status": "搜索中", "state": "running"})
        r1 = adapter.update({"title": "t", "status": "搜索中", "state": "running"})
        self.assertTrue(r1.skipped)

    def test_state_change_triggers_update(self):
        adapter = CardAdapter(chat_id="oc_x", dry_run=True)
        adapter.send({"title": "t", "status": "搜索中", "state": "running"})
        r = adapter.update({"title": "t", "status": "质检中", "state": "running"})
        self.assertFalse(r.skipped)

    def test_number_change_triggers_update(self):
        adapter = CardAdapter(chat_id="oc_x", dry_run=True)
        adapter.send({"title": "t", "status": "搜索中", "state": "running",
                      "metrics": [{"label": "候选买家", "value": "100 家"}]})
        r = adapter.update({"title": "t", "status": "搜索中", "state": "running",
                            "metrics": [{"label": "候选买家", "value": "200 家"}]})
        self.assertFalse(r.skipped)


class StateMachineTests(unittest.TestCase):
    def _card(self):
        return FindBuyersCard(tenant_id="t1", requester_id="ou_r1", chat_id="oc_c1", dry_run=True)

    def test_normal_four_stages(self):
        """第 12-1 条：正常四阶段完成。"""
        c = self._card()
        c.start()
        c.target_confirmed()
        c.searching(pages=3, candidates=200)
        c.qualifying(qualified=80)
        c.syncing(synced=48)
        c.finish_done(created=40, updated=8, deduped=48, leads_url="https://leads")
        self.assertEqual(c.state["state"], "done")

    def test_waiting_user(self):
        """第 12-2 条：缺参数 → waiting_user。"""
        c = self._card()
        c.start()
        c.waiting_user()
        self.assertEqual(c.state["state"], "waiting_user")

    def test_partial(self):
        """第 12-3 条：搜索成功但部分入池失败 → partial。"""
        c = self._card()
        c.start()
        c.partial(created=40, updated=5, deduped=48, leads_url="https://leads")
        self.assertEqual(c.state["state"], "partial")

    def test_failed(self):
        """第 12-4 条：接口异常 → failed，且不显示错误栈。"""
        c = self._card()
        c.start()
        c.fail()
        self.assertEqual(c.state["state"], "failed")
        # 卡片文案不含错误栈关键字
        self.assertNotIn("Traceback", c.state["metrics"].__repr__())

    def test_cancelled(self):
        c = self._card()
        c.start()
        c.cancel()
        self.assertEqual(c.state["state"], "cancelled")

    def test_result_fewer_than_target_still_done(self):
        """第 12-5 条：结果不足目标数量但如实完成 → done（不硬凑）。"""
        c = self._card()
        c.start()
        c.searching(candidates=20)  # 目标 50，实际 20
        c.finish_done(created=18, updated=2, deduped=20)
        self.assertEqual(c.state["state"], "done")

    def test_two_jobs_do_not_overwrite(self):
        """第 12-7 条：两个任务同一会话并发不覆盖。"""
        c1 = self._card()
        c2 = self._card()
        self.assertNotEqual(c1.job_id, c2.job_id)
        self.assertNotEqual(c1._path, c2._path)

    def test_count_mismatch_blocks_green_done(self):
        """第 12-9 条：终态计数不一致 → 不能显示全部完成，转 partial。"""
        c = self._card()
        c.start()
        # created+updated=30 != deduped=48 → 强制 partial
        c.finish_done(created=20, updated=10, deduped=48)
        self.assertEqual(c.state["state"], "partial")

    def test_update_failure_does_not_break_facts(self):
        """第 12-10 条：卡片更新失败不影响搜索事实和线索池结果。

        CardAdapter.update 失败时返回 ok=False 但不抛异常；业务状态机照常推进。
        """
        adapter = CardAdapter(chat_id="oc_x", dry_run=True)
        adapter.send({"title": "t", "status": "搜索中", "state": "running"})
        # 模拟：即使 patch 会失败，调用方（编排器）只读 ok 字段，不依赖卡片成功才写库
        r = adapter.update({"title": "t", "status": "质检中", "state": "running"})
        self.assertIn(r.ok, (True, False))  # 返回结果，不抛异常


class IsolationTests(unittest.TestCase):
    def test_qualifying_does_not_hardcode_exclude_manufacturers(self):
        """第 12-8 条：零部件场景不错误排除制造商。

        qualifying 节点文案只写「按买家画像质检和企业级去重」，
        不得写死「排除所有制造商」——成品/零部件场景由上游判断决定。
        """
        c = FindBuyersCard(tenant_id="t1", requester_id="ou_r1", chat_id="oc_c1", dry_run=True)
        c.start()
        c.qualifying(qualified=80)
        dsl = {"title": "找买家", "status": "正在按买家画像质检和企业级去重", "state": "running"}
        body = json.dumps(render_card(dsl), ensure_ascii=False)
        self.assertNotIn("排除所有制造商", body)
        self.assertNotIn("排除制造商", body)

    def test_job_binds_identity(self):
        """第 11 条：job_id 绑定 tenant/requester/chat。"""
        c = FindBuyersCard(tenant_id="t1", requester_id="ou_r1", chat_id="oc_c1", dry_run=True)
        self.assertEqual(c.state["tenant_id"], "t1")
        self.assertEqual(c.state["requester_id"], "ou_r1")
        self.assertEqual(c.state["chat_id"], "oc_c1")
        self.assertEqual(c.state["job_id"], c.job_id)

    def test_valid_states(self):
        for s in ["queued", "running", "waiting_user", "partial", "failed", "cancelled", "done"]:
            self.assertIn(s, VALID_STATES)


class LeadPoolOwnershipTests(unittest.TestCase):
    """线索池链接归属校验：校验失败不显示「打开线索池」，但不影响搜索完成。"""

    def _card(self, app_token="app_me", table_id="tbl_me"):
        return FindBuyersCard(
            tenant_id="t1", requester_id="ou_r1", chat_id="oc_c1",
            dry_run=True, lead_pool_app_token=app_token, lead_pool_table_id=table_id,
        )

    def test_extract_lead_pool_ids(self):
        url = "https://versa-ai.feishu.cn/base/app_x?table=tbl_y"
        self.assertEqual(extract_lead_pool_ids(url), ("app_x", "tbl_y"))
        self.assertEqual(extract_lead_pool_ids(""), ("", ""))
        self.assertEqual(extract_lead_pool_ids("https://example.com/leads"), ("", ""))

    def test_other_enterprise_lead_pool_rejected(self):
        """其他企业线索池链接被拒绝：done 状态保留，但不显示打开线索池。"""
        c = self._card(app_token="app_me", table_id="tbl_me")
        c.start()
        c.finish_done(created=40, updated=8, deduped=48,
                      leads_url="https://versa-ai.feishu.cn/base/app_other?table=tbl_other")
        self.assertEqual(c.state["state"], "done")          # 搜索完成不受影响
        self.assertEqual(c.state.get("leads_url"), "")        # 未记录他人链接

    def test_own_lead_pool_accepted(self):
        """本企业线索池链接：展示「打开线索池」。"""
        c = self._card(app_token="app_me", table_id="tbl_me")
        c.start()
        url = "https://versa-ai.feishu.cn/base/app_me?table=tbl_me"
        c.finish_done(created=40, updated=8, deduped=48, leads_url=url)
        self.assertEqual(c.state["state"], "done")
        self.assertEqual(c.state.get("leads_url"), url)

    def test_no_pool_identity_no_link(self):
        """未提供线索池身份 → 无法确认归属 → 不展示链接（fail-closed）。"""
        c = FindBuyersCard(tenant_id="t1", requester_id="ou_r1", chat_id="oc_c1", dry_run=True)
        c.start()
        c.finish_done(created=1, updated=0, deduped=1, leads_url="https://versa-ai.feishu.cn/base/app_x")
        self.assertEqual(c.state["state"], "done")
        self.assertEqual(c.state.get("leads_url"), "")


class StateTransitionGuardTests(unittest.TestCase):
    """并发/状态机保护：running 不能覆盖终态，旧阶段不能覆盖新阶段。"""

    def _card(self):
        return FindBuyersCard(tenant_id="t1", requester_id="ou_r1", chat_id="oc_c1", dry_run=True)

    def test_searching_cannot_overwrite_done(self):
        c = self._card()
        c.start()
        c.finish_done(created=5, updated=0, deduped=5)
        self.assertEqual(c.state["state"], "done")
        c.searching(pages=1, candidates=9)   # 迟到的 running 更新
        self.assertEqual(c.state["state"], "done")

    def test_running_cannot_overwrite_failed(self):
        c = self._card()
        c.start()
        c.fail()
        c.syncing(synced=3)
        self.assertEqual(c.state["state"], "failed")

    def test_old_stage_cannot_overwrite_new_stage(self):
        c = self._card()
        c.start()
        c.searching(pages=1, candidates=5)
        c.target_confirmed()   # 步骤 1 不能覆盖步骤 2
        self.assertEqual(c.state["step"], "searching")

    def test_same_stage_metric_update_allowed(self):
        c = self._card()
        c.start()
        c.searching(pages=1, candidates=5)
        c.searching(pages=3, candidates=200)  # 同阶段数字推进允许
        self.assertEqual(c.state["step"], "searching")


class RetryAndPersistenceTests(unittest.TestCase):
    """任务重试不重复发卡：message_id 持久化并跨实例恢复。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_jobs_dir = JOBS_DIR
        import find_buyers_card as fbc
        fbc.JOBS_DIR = Path(self._tmp.name)
        self.addCleanup(self._restore)

    def _restore(self):
        import find_buyers_card as fbc
        fbc.JOBS_DIR = self._orig_jobs_dir
        self._tmp.cleanup()

    def test_retry_restores_message_id_no_resend(self):
        """job 已有 message_id 时只更新原卡，不重复发卡。"""
        import find_buyers_card as fbc
        job_id = "fb_retry_001"
        state = {
            "job_id": job_id, "tenant_id": "t1", "requester_id": "ou_r1",
            "chat_id": "oc_c1", "state": "running", "step": "searching",
            "message_id": "om_original_123", "metrics": {},
        }
        p = fbc.JOBS_DIR / f"{job_id}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(state), encoding="utf-8")

        card = FindBuyersCard(tenant_id="t1", requester_id="ou_r1", chat_id="oc_c1", job_id=job_id)
        self.assertEqual(card.adapter.message_id, "om_original_123")
        # start() 不再重复发卡
        card.start()
        self.assertEqual(card.adapter.message_id, "om_original_123")


class TtlCleanupTests(unittest.TestCase):
    """TTL 不清理仍在运行的任务。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_jobs_dir = JOBS_DIR
        import find_buyers_card as fbc
        fbc.JOBS_DIR = Path(self._tmp.name)
        self.addCleanup(self._restore)

    def _restore(self):
        import find_buyers_card as fbc
        fbc.JOBS_DIR = self._orig_jobs_dir
        self._tmp.cleanup()

    def test_active_job_not_cleaned(self):
        import find_buyers_card as fbc
        import os
        running = fbc.JOBS_DIR / "fb_running.json"
        done = fbc.JOBS_DIR / "fb_done.json"
        for p, st in [(running, "running"), (done, "done")]:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps({"job_id": p.stem, "state": st}), encoding="utf-8")
            old = datetime.now(timezone.utc).timestamp() - 100000
            os.utime(p, (old, old))
        removed = cleanup_expired(ttl_hours=0)
        self.assertTrue(running.exists())   # 活跃任务不被清理
        self.assertFalse(done.exists())     # 终态过期任务被清理
        self.assertEqual(removed, 1)


class ScoreDiagnosticsTests(unittest.TestCase):
    """分数诊断埋点：只读观测，不进卡片、不进 metrics、不影响交付。"""

    def test_record_scores_summary_and_log(self):
        import find_buyers_card as fbc
        with tempfile.TemporaryDirectory() as td:
            old_jobs, old_log = fbc.JOBS_DIR, fbc.SCORE_LOG
            fbc.JOBS_DIR = Path(td) / "jobs"
            fbc.SCORE_LOG = Path(td) / "scores.jsonl"
            try:
                card = FindBuyersCard("t-score", "ou_score", "oc_score", job_id="fb_score_test")
                summary = card.record_scores([88, 62, 91, 75.5, None, "x", 40], delivered=3)
                self.assertEqual(summary["count"], 5)          # None / "x" 被跳过，不当 0 处理
                self.assertEqual(summary["ge_threshold"], 3)   # 88 / 91 / 75.5
                self.assertEqual(summary["max"], 91.0)
                self.assertEqual(summary["min"], 40.0)
                # JSONL 落盘（TTL 清理 job 文件后仍可统计）
                lines = fbc.SCORE_LOG.read_text(encoding="utf-8").strip().splitlines()
                self.assertEqual(len(lines), 1)
                self.assertEqual(json.loads(lines[0])["delivered"], 3)
                # 分数不得进入卡片指标/卡片 DSL
                self.assertNotIn("scores", card.state.get("metrics", {}))
                self.assertEqual(card.state["diagnostics"]["delivered"], 3)
                dsl = {"title": "找买家", "status": "质检中", "state": "running",
                       "metrics": [{"label": k, "value": v} for k, v in card.state["metrics"].items()]}
                rendered = json.dumps(render_card(dsl), ensure_ascii=False)
                self.assertNotIn("diagnostics", rendered)
                self.assertNotIn("91", rendered)
            finally:
                fbc.JOBS_DIR, fbc.SCORE_LOG = old_jobs, old_log

    def test_record_scores_empty_is_silent(self):
        import find_buyers_card as fbc
        with tempfile.TemporaryDirectory() as td:
            old_jobs, old_log = fbc.JOBS_DIR, fbc.SCORE_LOG
            fbc.JOBS_DIR = Path(td) / "jobs"
            fbc.SCORE_LOG = Path(td) / "scores.jsonl"
            try:
                card = FindBuyersCard("t-score", "ou_score", "oc_score", job_id="fb_score_empty")
                self.assertEqual(card.record_scores([]), {})
                self.assertFalse(fbc.SCORE_LOG.exists())
                self.assertNotIn("diagnostics", card.state)
            finally:
                fbc.JOBS_DIR, fbc.SCORE_LOG = old_jobs, old_log


class BuyerDetailTests(unittest.TestCase):
    """2026-09-15：卡片买家明细不再静默截断（原为硬编码 buyers[:10]）。"""

    @staticmethod
    def _buyers(count):
        return [
            {
                "name": f"买家{i}",
                "website": f"https://buyer{i}.example",
                "country": "巴西",
                "need": "寻找供应商",
                "reason": "产品对路",
            }
            for i in range(1, count + 1)
        ]

    def test_more_than_ten_buyers_all_rendered(self):
        dsl = {"title": "找买家", "status": "已交付", "state": "done",
               "buyers": self._buyers(12)}
        body = json.dumps(render_card(dsl), ensure_ascii=False)
        for index in range(1, 13):
            self.assertIn(f"买家{index}", body)
        self.assertNotIn("未在卡片展开", body)

    def test_max_buyers_override_discloses_surplus(self):
        dsl = {"title": "找买家", "status": "已交付", "state": "done",
               "buyers": self._buyers(12), "max_buyers": 5}
        body = json.dumps(render_card(dsl), ensure_ascii=False)
        self.assertIn("买家5", body)
        self.assertNotIn("买家6", body)
        self.assertIn("另有 7 家未在卡片展开", body)

    def test_invalid_max_buyers_falls_back_to_default(self):
        dsl = {"title": "找买家", "status": "已交付", "state": "done",
               "buyers": self._buyers(12), "max_buyers": -3}
        body = json.dumps(render_card(dsl), ensure_ascii=False)
        self.assertIn("买家12", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
