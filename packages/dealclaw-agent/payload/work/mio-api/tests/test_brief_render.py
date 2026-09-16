"""早晚报渲染器 + 多轮触达引擎测试（2026-09-17 田耕郡定稿口径）。

覆盖：
  · 分层映射：线索池「跟进优先级」→ T1/T2（未知按 T2，不激进）
  · 多轮触达：未首触→R1；R1 后按分层间隔→R2；未到期进 waiting；
    已回复/退信/拒绝/自动回复→停止序列；到 3 轮上限→停止
  · 渲染：链接只出现一次、决策 ≤3 条、空块不渲染、晚报有收尾段
  · 卡片：文本 → 飞书卡片结构

跑法：cd <mio-api> && python3 -m unittest tests.test_brief_render
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

_MIO = Path(__file__).resolve().parents[1]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from dc_brief_render import (  # noqa: E402
    MAX_ROUND,
    plan_touch_rounds,
    render_evening,
    render_morning,
    round_gap_days,
    tier_of,
    to_feishu_card,
)

NOW = datetime(2026, 9, 17, 1, 0, tzinfo=timezone.utc)


def rec(**kw):
    base = {"company": "Buyer Co", "priority": "高", "touch_number": 1,
            "last_touch_at": (NOW - timedelta(days=10)).isoformat()}
    base.update(kw)
    return base


class TierMapping(unittest.TestCase):
    def test_priority_maps_to_tier(self):
        self.assertEqual(tier_of("高"), "T1")
        self.assertEqual(tier_of("highest"), "T1")
        self.assertEqual(tier_of("中"), "T2")
        self.assertEqual(tier_of(""), "T2")

    def test_gap_days_by_tier_and_round(self):
        self.assertEqual(round_gap_days("T1", 1), 3)
        self.assertEqual(round_gap_days("T1", 2), 5)
        self.assertEqual(round_gap_days("T2", 1), 7)
        self.assertEqual(round_gap_days("T2", 9), 10)   # 越界取最后一档


class TouchRounds(unittest.TestCase):
    def test_never_touched_is_due_r1_today(self):
        out = plan_touch_rounds([rec(touch_number=0, last_touch_at="")], now=NOW)
        self.assertEqual([d["round"] for d in out["due"]], [1])

    def test_t1_due_after_3_days(self):
        out = plan_touch_rounds([rec(touch_number=1, last_touch_at=(NOW - timedelta(days=3)).isoformat())],
                                now=NOW)
        self.assertEqual(out["due"][0]["round"], 2)
        self.assertEqual(out["due"][0]["tier"], "T1")

    def test_not_due_yet_goes_to_waiting(self):
        out = plan_touch_rounds([rec(touch_number=1, last_touch_at=(NOW - timedelta(days=1)).isoformat())],
                                now=NOW)
        self.assertEqual(out["due"], [])
        self.assertEqual(out["waiting"]["R1"], 1)

    def test_t2_slower_cadence(self):
        """同样 3 天：T1 到期、T2 未到期（节奏差异生效）。"""
        t1 = plan_touch_rounds([rec(priority="高", last_touch_at=(NOW - timedelta(days=3)).isoformat())], now=NOW)
        t2 = plan_touch_rounds([rec(priority="中", last_touch_at=(NOW - timedelta(days=3)).isoformat())], now=NOW)
        self.assertEqual(len(t1["due"]), 1)
        self.assertEqual(len(t2["due"]), 0)

    def test_reply_or_blocked_stops_sequence(self):
        out = plan_touch_rounds([
            rec(company="Replied", replied=True),
            rec(company="Bounced", state="bounced"),
            rec(company="Rejected", state="明确拒绝"),
        ], now=NOW)
        self.assertEqual(out["due"], [])
        self.assertEqual(len(out["stopped"]), 3)

    def test_round_cap_stops(self):
        out = plan_touch_rounds([rec(touch_number=MAX_ROUND)], now=NOW)
        self.assertEqual(out["due"], [])
        self.assertTrue(any("上限" in s["reason"] for s in out["stopped"]))

    def test_missing_last_touch_is_not_guessed(self):
        out = plan_touch_rounds([rec(touch_number=1, last_touch_at="")], now=NOW)
        self.assertEqual(out["due"], [])
        self.assertEqual(out["waiting"]["R1"], 0)

    def test_t1_sorted_before_t2(self):
        out = plan_touch_rounds([
            rec(company="B", priority="中"),
            rec(company="A", priority="高"),
        ], now=NOW)
        self.assertEqual(out["due"][0]["tier"], "T1")


class RenderMorning(unittest.TestCase):
    def _rounds(self):
        return {"due": [{"tier": "T1", "round": 2}, {"tier": "T2", "round": 2}],
                "waiting": {"R1": 12, "R2": 5, "R3": 0}, "stopped": []}

    def test_daily_and_exhibition_headings_differ(self):
        daily = render_morning(kind="daily", date_label="9/17")
        exh = render_morning(kind="exhibition", date_label="9/17", exhibition="China Homelife 墨西哥")
        self.assertIn("日常", daily.splitlines()[0])
        self.assertIn("展会", exh.splitlines()[0])

    def test_link_appears_once_and_decisions_capped(self):
        text = render_morning(kind="daily", decisions=["a", "b", "c", "d"], link="https://x")
        self.assertEqual(text.count("https://x"), 1)
        self.assertNotIn("· d", text, "决策最多 3 条")

    def test_empty_sections_are_skipped(self):
        text = render_morning(kind="daily", done=["做了 A"])
        self.assertIn("我帮你做了", text)
        self.assertNotIn("最近又学会了", text)   # 没数据不渲染
        self.assertNotIn("多轮触达", text)

    def test_rounds_block_renders_tiers_and_waiting(self):
        text = render_morning(kind="daily", rounds=self._rounds())
        self.assertIn("多轮触达（今天）", text)
        self.assertIn("T1 1 家该做第 2 轮", text)
        self.assertIn("等待回复中：R1 12 · R2 5", text)


class RenderEvening(unittest.TestCase):
    def test_evening_has_settlement_sections(self):
        text = render_evening(date_label="9/17", settled=["2 件完成", "1 件未完成"],
                              results=["发送 18 · 送达 16 · 回复 3 · 退信 1"],
                              rounds={"due": [{"tier": "T1"}], "waiting": {"R1": 12, "R2": 5}},
                              first_thing_tomorrow=["T1 先做第 3 轮"], link="https://x")
        for marker in ("收尾", "今日核销", "今日战果", "等待中的盘面", "明日第一件事"):
            self.assertIn(marker, text)
        self.assertEqual(text.count("https://x"), 1)


class Card(unittest.TestCase):
    def test_text_becomes_feishu_card(self):
        card = to_feishu_card("早上好\n\n■ 我帮你做了（近 24h）\n· A", title="早报")
        self.assertEqual(card["header"]["title"]["content"], "早报")
        self.assertGreaterEqual(len(card["elements"]), 2)
        self.assertEqual(card["elements"][0]["tag"], "div")


class AgentInTheLoop(unittest.TestCase):
    """代码兜确定性、agent 定策略：覆盖节奏覆盖 / 决策日志 / 反思回写 / 硬门槛不可绕。"""

    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_cadence_is_default_not_hard_rule(self):
        from dc_brief_render import effective_gap_days  # noqa: PLC0415

        self.assertEqual(effective_gap_days("T1", 1), 3)                      # 默认建议
        self.assertEqual(effective_gap_days("T1", 1, overrides={"T1": 1}), 1)  # 反思可收紧
        for bad in ({"T1": "abc"}, {"T1": 0}, {"T1": -3}):
            self.assertEqual(effective_gap_days("T1", 1, overrides=bad), 3, "非法覆盖必须回落默认")

    def test_decision_plan_keeps_agent_reason(self):
        from dc_brief_render import decide_touch_plan  # noqa: PLC0415

        cands = {"due": [{"buyer": "A", "tier": "T1", "round": 2}],
                 "waiting": {"R1": 3}}
        plan = decide_touch_plan(cands, decisions=[{"buyer": "A", "reason": "上周发了认证，这轮发案例",
                                                    "angle": "案例"}])
        self.assertEqual(plan["plan"][0]["why"], "上周发了认证，这轮发案例")
        self.assertEqual(plan["plan"][0]["angle"], "案例")

    def test_agent_cannot_bypass_hard_gates(self):
        from dc_brief_render import decide_touch_plan  # noqa: PLC0415

        cands = {"due": [{"buyer": "A", "tier": "T1", "round": 2}], "waiting": {}}
        plan = decide_touch_plan(cands, decisions=[{"buyer": "A"}, {"buyer": "已回复的买家"}])
        self.assertEqual(len(plan["plan"]), 1)
        self.assertEqual(len(plan["rejected"]), 1)
        self.assertIn("不在候选", plan["rejected"][0]["reason"])

    def test_section_shows_why_today(self):
        from dc_brief_render import decide_touch_plan, render_touch_plan_section  # noqa: PLC0415

        plan = decide_touch_plan(
            {"due": [{"buyer": "A", "tier": "T1", "round": 2, "reason": "R1 后 3 天未回"}],
             "waiting": {"R1": 12}},
            decisions=[{"buyer": "A", "reason": "对方只关心认证"}])
        text = render_touch_plan_section(plan)
        self.assertIn("多轮触达（今天）", text)
        self.assertIn("T1 1 家该做第 2 轮", text)
        self.assertIn("对方只关心认证", text)      # 为什么今天碰他
        self.assertIn("等待回复中：R1 12", text)

    def test_decision_log_round_trip(self):
        from dc_brief_render import list_decisions, record_decision  # noqa: PLC0415

        record_decision(self.data, {"buyer": "A", "action": "draft_r2"})
        record_decision(self.data, {"buyer": "B", "action": "skip"})
        logs = list_decisions(self.data, limit=10)
        self.assertEqual([x["buyer"] for x in logs], ["A", "B"])
        self.assertTrue(all("ts" in x for x in logs), "必须带时间戳，可回放")

    def test_reflection_writeback_and_guard(self):
        from dc_brief_render import write_reflection  # noqa: PLC0415

        self.assertTrue(write_reflection("巴西当天回复率更高，T1 节奏收紧到 1 天",
                                         round_no=2, angle="案例", outcome="replied",
                                         workspace_root=self.data))
        self.assertFalse(write_reflection("   ", workspace_root=self.data), "空反思不写")
        path = self.data.joinpath("memory", "projects", "dealclaw", "reflections.jsonl")
        self.assertTrue(path.exists())
        import json as _json  # noqa: PLC0415

        entry = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(entry["round"], 2)
        self.assertEqual(entry["source"], "touch_round")
        self.assertIn("what", entry)


if __name__ == "__main__":
    unittest.main()
