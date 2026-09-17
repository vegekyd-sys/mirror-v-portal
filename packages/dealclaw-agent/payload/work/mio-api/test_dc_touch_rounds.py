#!/usr/bin/env python3
"""test_dc_touch_rounds.py — 多轮个性化触达轮次引擎测试（Mio 2026-09-17 需求）

覆盖：
  A. 参数：轮次上限 / T1-T2 节奏 / 角度配置 / 分层映射
  B. 轮次推进：R1→R2→R3 到期判定、分层节奏差异、touch_number=0 归一、轮次上限
  C. 停止条件：回复即停（含自动回复/拒绝）、退信/投诉、线索池不触达/商机关闭、未送达不推进
  D. 幂等：同买家同轮只生成一次；与 dc_followup 共用幂等键，两条路径不重复
  E. 每轮内容不同：R2/R3 角度与正文不同；只生成 pending_confirmation、不发送
  F. 早晚报 todo 区块：早报 + 晚报真函数渲染、数量大时汇总不刷屏
  G. no_reply_due → 「第 N 轮到期」：evidence 带轮次/分层，且按轮次区分
  H. 线索池投影：只写现有字段名、不覆盖枚举字段

运行：cd work/mio-api && python3 test_dc_touch_rounds.py
"""
import importlib
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

_MIO = Path(__file__).resolve().parent
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

CO = "co_rounds"


def _days_ago(n: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        os.environ.pop("MIO_CDP_SUPPLIER_ID", None)   # 不让宿主环境串租户
        os.environ.pop("DC_FOLLOWUP_DUE_DAYS", None)  # 不设则走分层节奏
        os.environ["DC_DAILY_INBOUND_SELFHEAL"] = "0"  # 日报用例不做出网自愈

        import dc_memory_data
        self._mem_mod = dc_memory_data
        self._orig_mem_dir = dc_memory_data.MEMORY_DATA_DIR
        dc_memory_data.MEMORY_DATA_DIR = Path(self.tmp.name) / "memory"

        from email_gateway.store import EmailStore
        self.store = EmailStore(self.data_dir)

        self.tr = importlib.reload(importlib.import_module("dc_touch_rounds"))
        import dc_daily_report
        importlib.reload(dc_daily_report)
        self.dr = dc_daily_report
        import dc_email_controller.dc_followup as followup
        self.followup = importlib.reload(followup)
        import dc_email_controller.dc_reply_draft as rd
        self.rd = importlib.reload(rd)

    def tearDown(self):
        self._mem_mod.MEMORY_DATA_DIR = self._orig_mem_dir
        self.tmp.cleanup()

    # ── fixtures ──────────────────────────────────────────
    def outbound(self, resend_id, touch=1, provider_status="delivered",
                 recipients=("buyer@x.com",), sent_at=None, contact_id="ct1",
                 campaign_id="camp1", lead_id="lead1", subject="Hi"):
        self.store.insert_message({
            "account_id": "ema_x", "direction": "outbound",
            "message_id": f"<{resend_id}@x.com>", "sender": "thia@mail.dealclaw.io",
            "recipients": list(recipients), "subject": subject, "status": "sent",
            "resend_id": resend_id, "company_id": CO,
            "campaign_id": campaign_id, "lead_id": lead_id, "contact_id": contact_id,
            "provider_status": provider_status, "touch_number": touch,
            "sent_at": sent_at or _days_ago(4),
        })

    def inbound(self, thread_id, contact_id="ct1", received_at=None, text="Thanks, noted."):
        self.store.insert_message({
            "account_id": "ema_x", "direction": "inbound",
            "message_id": f"<ib-{thread_id}@x.com>", "sender": "buyer@x.com",
            "recipients": ["thia@mail.dealclaw.io"], "subject": "Re: Hi",
            "status": "received", "company_id": CO, "text": text,
            "binding_status": "bound", "thread_id": thread_id, "contact_id": contact_id,
            "received_at": received_at or _days_ago(1),
        })

    def leads(self, *rows):
        """写线索池归集（memory leads.json），走真实 read_leads 读路径。"""
        return [{"company": c, "website": d, "followup_priority": p, "stage": s}
                for c, d, p, s in rows]


class ParameterTests(_Base):
    def test_01_cadence_and_max_rounds(self):
        self.assertEqual(self.tr.MAX_ROUNDS, 3)
        self.assertEqual(self.tr.gap_days("T1", 1), 3)
        self.assertEqual(self.tr.gap_days("T1", 2), 5)
        self.assertEqual(self.tr.gap_days("T2", 1), 7)
        self.assertEqual(self.tr.gap_days("T2", 2), 10)
        self.assertIsNone(self.tr.gap_days(None, 1))       # 未定分层 → 兜底节奏
        self.assertIsNone(self.tr.gap_days("T2", 3))       # 超出配置 → 兜底

    def test_02_tier_mapping_uses_existing_field(self):
        # T1/T2 是内部代号：映射到线索池现有「跟进优先级」，不新增字段名
        self.assertEqual(self.tr.priority_to_tier("优先跟进"), "T1")
        self.assertEqual(self.tr.priority_to_tier("普通跟进"), "T2")
        self.assertEqual(self.tr.priority_to_tier("长期培育"), "T2")
        self.assertIsNone(self.tr.priority_to_tier(""))

    def test_03_angles_differ_per_round(self):
        labels = [self.tr.angle_for_round(i)["label"] for i in (1, 2, 3)]
        self.assertEqual(len(set(labels)), 3)
        self.assertIn("价值强化", labels[1])
        self.assertIn("机会型", labels[2])
        bodies = [self.tr.round_email_body(i) for i in (1, 2, 3)]
        self.assertEqual(len(set(bodies)), 3)              # 每轮内容不同

    def test_04_cadence_env_override(self):
        os.environ["DC_TOUCH_T1_GAP_R1_R2"] = "2"
        try:
            reloaded = importlib.reload(self.tr)
            self.assertEqual(reloaded.gap_days("T1", 1), 2)
        finally:
            os.environ.pop("DC_TOUCH_T1_GAP_R1_R2", None)
            importlib.reload(self.tr)


class QueueAdvanceTests(_Base):
    def _queue(self, leads=None):
        return self.tr.build_touch_queue(CO, store=self.store, leads=leads)

    def test_10_t1_due_after_3_days(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(len(q["due_rows"]), 1)
        row = q["due_rows"][0]
        self.assertEqual(row["current_round"], 1)
        self.assertEqual(row["next_round"], 2)
        self.assertEqual(row["tier"], "T1")
        self.assertEqual(row["tier_source"], "lead_pool_priority")
        self.assertEqual(row["gap_days"], 3)
        self.assertIn("一键生成 R2 草稿", row["action_hint"])
        self.assertEqual(row["angle_label"], self.tr.angle_label(2))

    def test_11_t1_not_due_before_3_days(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(2))
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(q["due_rows"], [])
        self.assertEqual(len(q["rows"]), 1)                 # 仍在序列里，只是未到期
        self.assertEqual(q["waiting_line"], "R1 1 家")

    def test_12_t2_slower_cadence(self):
        # 同样 R1 后 4 天：T1 已到期，T2 还没到（7 天）
        self.outbound("re_1", touch=1, recipients=("buyer@x.com",), sent_at=_days_ago(4))
        q = self._queue(self.leads(("Acme", "x.com", "普通跟进", "已触达")))
        self.assertEqual(q["due_rows"], [])
        self.assertEqual(q["rows"][0]["tier"], "T2")
        self.assertEqual(q["rows"][0]["gap_days"], 7)
        q2 = self.tr.build_touch_queue(
            CO, store=self.store, leads=self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(len(q2["due_rows"]), 1)            # 分层生节奏差异

    def test_13_t2_due_after_7_days(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(8))
        q = self._queue(self.leads(("Acme", "x.com", "普通跟进", "已触达")))
        self.assertEqual(len(q["due_rows"]), 1)
        self.assertEqual(q["due_rows"][0]["gap_days"], 7)

    def test_14_r2_to_r3_uses_5_days_for_t1(self):
        self.outbound("re_1", touch=2, sent_at=_days_ago(6))
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(len(q["due_rows"]), 1)
        row = q["due_rows"][0]
        self.assertEqual(row["current_round"], 2)
        self.assertEqual(row["next_round"], 3)
        self.assertEqual(row["gap_days"], 5)
        self.assertIn("机会型", row["angle_label"])

    def test_15_touch_zero_counts_as_r1(self):
        # smtp_send 的首触默认 touch_number=0：必须算 R1，next 是 R2（不能重复发 R1）
        self.outbound("re_1", touch=0, sent_at=_days_ago(4))
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(q["due_rows"][0]["current_round"], 1)
        self.assertEqual(q["due_rows"][0]["next_round"], 2)

    def test_16_max_rounds_stops_sequence(self):
        self.outbound("re_3", touch=3, sent_at=_days_ago(30))
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(q["due_rows"], [])                     # 不再产生下一轮动作
        self.assertEqual(q["stopped"], [])                     # 不是硬门槛
        self.assertEqual(q["rows"][0]["stop_reason"], self.tr.STOP_MAX_ROUNDS)
        self.assertTrue(q["rows"][0]["sequence_end"])
        self.assertEqual(q["waiting_line"], "R3 1 家")         # 仍算等待回复中（R3）
        self.assertEqual(self.tr.lead_pool_patch(q["rows"][0])["下一步动作"],
                         "已触达 3 轮（序列完成，等回复 / 转策略复盘）")

    def test_17_unknown_tier_uses_legacy_cadence(self):
        # 线索池查不到该买家 → 兜底节奏（保持既有线上行为不变），并在依据里标明
        self.outbound("re_1", touch=1, sent_at=_days_ago(3))
        q = self._queue([])
        self.assertEqual(q["due_rows"][0]["tier"], "未定")
        self.assertEqual(q["due_rows"][0]["tier_source"], "no_lead_record")
        self.assertEqual(q["due_rows"][0]["due_policy"], "legacy_default")

    def test_18_buyer_aggregated_once(self):
        # 同一买家多轮事实 → 只产出一条队列行（同买家同一轮只发一次）
        self.outbound("re_1", touch=1, sent_at=_days_ago(10))
        self.outbound("re_2", touch=2, sent_at=_days_ago(6))
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(len(q["rows"]), 1)
        self.assertEqual(q["rows"][0]["current_round"], 2)

    def test_19_undelivered_not_advanced(self):
        self.outbound("re_1", touch=1, provider_status="sent", sent_at=_days_ago(10))
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(q["due_rows"], [])
        self.assertEqual(q["rows"][0]["stop_reason"], self.tr.STOP_UNDELIVERED)
        self.assertTrue(q["rows"][0]["delivery_pending"])
        self.assertIn("待送达", self.tr.lead_pool_patch(q["rows"][0])["下一步动作"])


class StopConditionTests(_Base):
    def _queue(self, leads=None):
        return self.tr.build_touch_queue(CO, store=self.store, leads=leads)

    def test_20_real_reply_stops(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(10))
        self.inbound("<re_1@x.com>", text="Please send your catalogue.")
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(q["due_rows"], [])
        self.assertEqual(q["stopped"][0]["stop_reason"], self.tr.STOP_REPLIED)

    def test_21_auto_reply_stops(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(10))
        self.inbound("<re_1@x.com>", text="I am out of office until Monday.")
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(q["stopped"][0]["stop_reason"], self.tr.STOP_AUTO_REPLY)

    def test_22_rejection_stops(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(10))
        self.inbound("<re_1@x.com>", text="Not interested, please unsubscribe.")
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(q["stopped"][0]["stop_reason"], self.tr.STOP_REJECTED)

    def test_23_bounced_and_complained_stop(self):
        self.outbound("re_b", touch=1, provider_status="bounced",
                      recipients=("hard@x.com",), sent_at=_days_ago(10))
        self.outbound("re_c", touch=1, provider_status="complained",
                      recipients=("angry@x.com",), sent_at=_days_ago(10))
        q = self.tr.build_touch_queue(CO, store=self.store, leads=[])
        reasons = sorted(s["stop_reason"] for s in q["stopped"])
        self.assertEqual(reasons, [self.tr.STOP_BOUNCED, self.tr.STOP_COMPLAINED])
        self.assertEqual(q["due_rows"], [])

    def test_24_lead_pool_do_not_contact_stops(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(10))
        q = self._queue(self.leads(("Acme", "x.com", "优先跟进", "停止触达")))
        self.assertEqual(q["stopped"][0]["stop_reason"], self.tr.STOP_DO_NOT_CONTACT)

    def test_25_opportunity_closed_stops(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(10))
        lead = {"company": "Acme", "website": "x.com", "followup_priority": "优先跟进",
                "stage": "已触达", "opportunity_status": "won"}
        q = self._queue([lead])
        self.assertEqual(q["stopped"][0]["stop_reason"], self.tr.STOP_OPP_CLOSED)

    def test_26_hard_stop_summary_line(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(10))
        self.inbound("<re_1@x.com>", text="Please send pricing.")
        q = self.tr.build_touch_queue(CO, store=self.store, leads=[])
        self.assertIn("已回复（转人工）", self.tr.stopped_summary(q))

    def test_28_leadstore_blocked_buyer_stops(self):
        # 与 dc_followup 同一拦截名单：LeadStore 标了拒绝 → 序列也停
        import importlib
        ls_mod = importlib.reload(importlib.import_module("dc_ls_store"))
        ls_mod.LeadStore().save_lead({"company_name": "Rejected Co", "domain": "x.com",
                                      "enterprise": CO, "user_open_id": "ou_1",
                                      "status": "不是我的买家", "iq_stage": -1})
        self.outbound("re_1", touch=1, sent_at=_days_ago(10))
        q = self.tr.build_touch_queue(CO, store=self.store, leads=[])
        self.assertEqual(q["due_rows"], [])
        self.assertEqual(q["stopped"][0]["stop_reason"], self.tr.STOP_REJECTED)

    def test_27_reply_after_round2_stops_whole_sequence(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(20))
        self.outbound("re_2", touch=2, sent_at=_days_ago(10))
        self.inbound("<re_1@x.com>", text="Sorry for the delay — please quote 500 pcs.")
        q = self.tr.build_touch_queue(CO, store=self.store, leads=[])
        self.assertEqual(q["rows"], [])
        self.assertEqual(q["stopped"][0]["stop_reason"], self.tr.STOP_REPLIED)


class DraftRoundTests(_Base):
    def _leads(self):
        return self.leads(("Acme", "x.com", "优先跟进", "已触达"))

    def test_30_generates_round2_draft_pending_only(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        r = self.tr.generate_round_drafts(CO, store=self.store, leads=self._leads())
        self.assertEqual(r["generated"], 1)
        drafts = self.rd.list_drafts(company_id=CO)
        self.assertEqual(len(drafts), 1)
        d = drafts[0]
        self.assertEqual(d["touch_number"], 2)
        self.assertEqual(d["category"], "followup")
        self.assertEqual(d["status"], "pending_confirmation")   # 只生成等确认
        self.assertEqual(d["round_tier"], "T1")
        self.assertEqual(d["round_angle"], "value_reinforce")
        self.assertEqual(d["sent_at"], "")                      # 绝不自动发送

    def test_31_idempotent_same_buyer_same_round(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        self.tr.generate_round_drafts(CO, store=self.store, leads=self._leads())
        r2 = self.tr.generate_round_drafts(CO, store=self.store, leads=self._leads())
        self.assertEqual(r2["generated"], 0)
        self.assertEqual(r2["skipped"], 1)
        self.assertEqual(len(self.rd.list_drafts(company_id=CO)), 1)

    def test_32_tier_and_round_filter(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        r = self.tr.generate_round_drafts(CO, tier="T2", store=self.store, leads=self._leads())
        self.assertEqual(r["generated"], 0)
        r = self.tr.generate_round_drafts(CO, tier="T1", round_number=3, store=self.store,
                                          leads=self._leads())
        self.assertEqual(r["generated"], 0)

    def test_33_dry_run_writes_nothing(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        r = self.tr.generate_round_drafts(CO, store=self.store, leads=self._leads(), dry_run=True)
        self.assertEqual(r["generated"], 1)
        self.assertEqual(self.rd.list_drafts(company_id=CO), [])

    def test_34_shared_idempotency_with_followup_cycle(self):
        # 两条路径共用同一幂等键 → 同一买家同一轮不会生成两份草稿
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        self.tr.generate_round_drafts(CO, store=self.store, leads=self._leads())
        self.followup.run_followup_cycle(CO)
        self.assertEqual(len(self.rd.list_drafts(company_id=CO)), 1)
        self.assertEqual(self.followup.run_followup_cycle(CO)["generated"], 0)

    def test_35_round_texts_differ(self):
        self.assertNotEqual(self.tr.round_email_body(2), self.tr.round_email_body(3))
        self.assertIn("sample", self.tr.round_email_body(3).lower())
        self.assertIn("certified", self.tr.round_email_body(2).lower())


class FollowupCycleTierTests(_Base):
    """既有跟进链（dc_followup）读到同一套分层节奏。"""

    def test_40_t1_due_t2_not_due(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        leads = self.leads(("Acme", "x.com", "优先跟进", "已触达"))
        import dc_memory_data
        dc_memory_data._write_json(CO, "leads.json", leads)
        cands = self.followup.list_followup_candidates(CO)
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0]["tier"], "T1")
        self.assertEqual(cands[0]["next_touch"], 2)

    def test_41_unknown_tier_keeps_legacy_2_days(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(3))
        cands = self.followup.list_followup_candidates(CO)
        self.assertEqual(len(cands), 1)                     # 兜底 2 天，线上行为不变
        self.assertEqual(cands[0]["due_policy"], "legacy_default")

    def test_42_explicit_env_due_days_wins(self):
        os.environ["DC_FOLLOWUP_DUE_DAYS"] = "10"
        try:
            self.outbound("re_1", touch=1, sent_at=_days_ago(4))
            import dc_memory_data
            dc_memory_data._write_json(CO, "leads.json",
                                       self.leads(("Acme", "x.com", "优先跟进", "已触达")))
            cands = self.followup.list_followup_candidates(CO)
            self.assertEqual(cands, [])                     # 运维显式设置优先于分层节奏
        finally:
            os.environ.pop("DC_FOLLOWUP_DUE_DAYS", None)


class ReportSectionTests(_Base):
    def _queue_with(self, *args, **kwargs):
        return self.tr.build_touch_queue(CO, store=self.store, leads=kwargs.pop("leads", None))

    def test_50_morning_block_rendered(self):
        self.outbound("re_1", touch=1, recipients=("a@aaa.com",), sent_at=_days_ago(4))
        self.outbound("re_2", touch=1, recipients=("b@bbb.com",), sent_at=_days_ago(8))
        leads = self.leads(("Aaa Co", "aaa.com", "优先跟进", "已触达"),
                           ("Bbb Co", "bbb.com", "普通跟进", "已触达"))
        q = self.tr.build_touch_queue(CO, store=self.store, leads=leads)
        text = self.tr.render_touch_rounds_section(q, slot="morning")
        self.assertIn("■ 多轮触达（今天）", text)
        self.assertIn("T1 1 家该做第 2 轮：Aaa Co", text)
        self.assertIn("一键生成 R2 草稿", text)
        self.assertIn("等待回复中：无", text)               # 两家都到期 → 无在途等待

    def test_51_evening_block_has_tomorrow_preview(self):
        # 明日到期（T1 R1 两天前发 → 3 天间隔 → 明天到期）+ 另一家今日已到期
        self.outbound("re_1", touch=1, recipients=("a@aaa.com",), sent_at=_days_ago(2))
        self.outbound("re_2", touch=1, recipients=("b@bbb.com",), sent_at=_days_ago(8))
        leads = self.leads(("Aaa Co", "aaa.com", "优先跟进", "已触达"),
                           ("Bbb Co", "bbb.com", "普通跟进", "已触达"))
        q = self.tr.build_touch_queue(CO, store=self.store, leads=leads)
        text = self.tr.render_touch_rounds_section(q, slot="evening")
        self.assertIn("■ 多轮触达（今日核销 / 明日预告）", text)
        self.assertIn("明日到期：T1 1 家", text)
        self.assertIn("T2 1 家该做第 2 轮", text)
        self.assertIn("等待回复中：R1 1 家", text)

    def test_57_tomorrow_line_excludes_far_future(self):
        # 今天刚发的 T1（3 天后才到期）不应被算作「明日到期」
        self.outbound("re_1", touch=1, recipients=("a@aaa.com",), sent_at=_days_ago(0))
        q = self.tr.build_touch_queue(CO, store=self.store,
                                      leads=self.leads(("Aaa Co", "aaa.com", "优先跟进", "已触达")))
        text = self.tr.render_touch_rounds_section(q, slot="evening")
        self.assertNotIn("明日到期", text)
        self.assertIn("等待回复中：R1 1 家", text)

    def test_52_empty_queue_still_renders_counts(self):
        q = self.tr.build_touch_queue(CO, store=self.store, leads=[])
        text = self.tr.render_touch_rounds_section(q, slot="morning")
        self.assertIn("■ 多轮触达（今天）", text)
        self.assertIn("今日无到期轮次", text)

    def test_53_large_volume_summarized(self):
        for i in range(8):
            self.outbound(f"re_{i}", touch=1, recipients=(f"b{i}@aaa.com",),
                          sent_at=_days_ago(9))
        leads = self.leads(("Aaa Co", "aaa.com", "优先跟进", "已触达"))
        q = self.tr.build_touch_queue(CO, store=self.store, leads=leads)
        text = self.tr.render_touch_rounds_section(q, slot="morning", limit=3)
        self.assertIn("T1 8 家该做第 2 轮", text)
        self.assertNotIn("b0@aaa.com", text)               # 不逐条展开、不刷屏
        self.assertIn("超过 6 家不逐一展开", text)

    def test_56_waiting_counts_exclude_today_actions(self):
        # 今日该做的行不计入「等待回复中」（否则两边重复计数）；R3 已走完仍算等待
        self.outbound("re_1", touch=1, recipients=("a@aaa.com",), sent_at=_days_ago(4))
        self.outbound("re_2", touch=1, recipients=("b@bbb.com",), sent_at=_days_ago(1))
        self.outbound("re_3", touch=3, recipients=("c@ccc.com",), sent_at=_days_ago(30))
        leads = self.leads(("Aaa Co", "aaa.com", "优先跟进", "已触达"),
                           ("Bbb Co", "bbb.com", "优先跟进", "已触达"),
                           ("Ccc Co", "ccc.com", "普通跟进", "已触达"))
        q = self.tr.build_touch_queue(CO, store=self.store, leads=leads)
        self.assertEqual(q["totals"]["due"], 1)
        self.assertEqual(q["waiting_line"], "R1 1 家 · R3 1 家")
        text = self.tr.render_touch_rounds_section(q, slot="morning")
        self.assertIn("等待回复中：R1 1 家 · R3 1 家", text)
        self.assertNotIn("已停止触达", text)                # 到顶不是门槛，不报停止

    def test_54_daily_report_includes_block(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        m = self.dr.build_morning_report(CO)
        self.assertIn("■ 多轮触达（今天）", m["text"])
        self.assertEqual(m["touch_round_due_count"], 1)
        e = self.dr.build_evening_report(CO)
        self.assertIn("■ 多轮触达", e["text"])
        self.assertEqual(e["touch_round_waiting_line"], "无")   # 该行已到期→不计入等待

    def test_55_report_survives_queue_error(self):
        orig = self.dr.collect_touch_round_queue

        def boom(*a, **k):
            raise RuntimeError("boom")

        self.dr.collect_touch_round_queue = boom
        try:
            text = self.dr._format_morning(CO, {}, [], [], {}, touch_queue=None)
            self.assertNotIn("多轮触达", text)              # 队列炸了不影响旧文案
        finally:
            self.dr.collect_touch_round_queue = orig


class RoundDueSignalTests(_Base):
    def setUp(self):
        super().setUp()
        self.sig = importlib.reload(importlib.import_module(
            "dc_email_controller.dc_email_signals"))

    def test_60_signal_carries_round_semantics(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        produced = self.tr.evaluate_round_due(
            CO, store=self.store, leads=self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(len(produced), 1)
        ev = produced[0]["evidence"]
        self.assertEqual(produced[0]["signal_type"], "no_reply_due")
        self.assertEqual(ev["round_number"], 1)
        self.assertEqual(ev["next_touch"], 2)
        self.assertEqual(ev["tier"], "T1")
        self.assertIn("tier:", ev["cadence_policy"])

    def test_61_not_due_yet_no_signal(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(1))
        produced = self.tr.evaluate_round_due(
            CO, store=self.store, leads=self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(produced, [])

    def test_62_per_round_signals_are_distinct(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(20))
        self.outbound("re_2", touch=2, sent_at=_days_ago(6))
        produced = self.tr.evaluate_round_due(
            CO, store=self.store, leads=self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        rounds = sorted(s["evidence"]["round_number"] for s in produced)
        self.assertEqual(rounds, [1, 2])                    # 每轮各一条，不被旧口径合并

    def test_63_replied_buyer_gets_no_signal(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        self.inbound("<re_1@x.com>", text="Please quote 100 pcs.")
        produced = self.tr.evaluate_round_due(
            CO, store=self.store, leads=self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.assertEqual(produced, [])


class LeadPoolProjectionTests(_Base):
    def test_70_patch_uses_existing_fields_only(self):
        row = {"next_round": 2, "angle_label": self.tr.angle_label(2),
               "due_date": "2026-09-20", "last_sent_at": _days_ago(4)}
        patch = self.tr.lead_pool_patch(row)
        self.assertEqual(sorted(patch), ["下一步动作", "截止时间", "最近联系时间"])
        self.assertIn("第 2 轮触达", patch["下一步动作"])
        self.assertIn("价值强化", patch["下一步动作"])
        self.assertEqual(patch["截止时间"], "2026-09-20")
        # 不覆盖枚举字段（contact_policy / opportunity_status 由 dc_priority 读）
        self.assertNotIn("联系策略", patch)
        self.assertNotIn("商机状态", patch)

    def test_71_stopped_row_marks_stop(self):
        patch = self.tr.lead_pool_patch({"stop_reason": self.tr.STOP_REPLIED,
                                         "stop_label": "已回复（转人工）",
                                         "last_sent_at": _days_ago(4)})
        self.assertIn("停止触达", patch["下一步动作"])
        self.assertEqual(patch["截止时间"], "")

    def test_72_apply_round_fields_writes_leads_json(self):
        import dc_memory_data
        dc_memory_data._write_json(CO, "leads.json", self.leads(("Acme", "x.com", "优先跟进", "已触达")))
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        r = self.tr.apply_round_fields_to_leads(CO)
        self.assertEqual(r["patched"], 1)
        leads = dc_memory_data.read_leads(CO)
        self.assertIn("第 2 轮触达", leads[0]["下一步动作"])
        self.assertTrue(leads[0]["截止时间"])
        self.assertTrue(leads[0]["最近联系时间"])

    def test_73_push_defaults_to_dry_run(self):
        self.outbound("re_1", touch=1, sent_at=_days_ago(4))
        r = self.tr.push_round_fields_to_pool(CO)
        self.assertTrue(r.get("dry_run"))
        self.assertEqual(r.get("status"), "error")          # 无线索池也不会写线上


if __name__ == "__main__":
    unittest.main(verbosity=2)
