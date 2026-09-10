#!/usr/bin/env python3
"""test_dc_email_provider.py — EmailProvider + 最小编排 + 模板 Advisor 测试（标准库 unittest）

覆盖：
  - EmailProvider 从 EmailStore 读数据，输出 result/action/risk/insight 四类 BriefItem
  - 第 8 条：区分「仍在回复观察期」和「超过等待期仍无回复」，观察期内不下结论
  - 早报 top3 + plan.json 持久化；晚报依据真实 inbound reply 事件核销 + review.json
  - 模板 Advisor（不接真实 LLM）
  - 端到端验收：途达 69 发送 / 68 送达 / 1 退信

运行：cd work/mio-api && python3 test_dc_email_provider.py
"""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_daily_brief import BriefContext  # noqa: E402
from dc_email_provider import EmailProvider, run_morning_brief, run_evening_brief, template_advise  # noqa: E402
from dc_daily_advisor import build_snapshot  # noqa: E402


TUDA = "152600996207"


def iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def make_outbound(provider_status, resend_id, buyer_email, days_ago=3.0, touch_number=0):
    return {
        "direction": "outbound",
        "provider_status": provider_status,
        "recipients": [buyer_email],
        "resend_id": resend_id,
        "sent_at": iso_days_ago(days_ago),
        "created_at": iso_days_ago(days_ago),
        "touch_number": touch_number,
        "company_id": TUDA,
        "campaign_id": "brazil-expo",
        "subject": "巴西展邀请",
    }


def make_context(report_type="morning"):
    return BriefContext(
        tenant="meorient", company=TUDA, report_type=report_type,
        date="2026-09-10", tz="Asia/Shanghai",
        as_of="2026-09-10T08:00:00+08:00",
        window_start="2026-09-10T00:00:00+08:00",
        window_end="2026-09-10T23:59:59+08:00",
    )


def make_store(outbounds, inbounds=None):
    store = MagicMock()
    store.list_outbound_records.return_value = outbounds
    store.list_inbound_records.return_value = inbounds or []
    return store


class TestEmailProviderKinds(unittest.TestCase):
    def _tuda_outbounds(self):
        """69 发送：68 delivered（3 天前，超过等待期）+ 1 bounced。"""
        out = []
        for i in range(68):
            out.append(make_outbound("delivered", f"re_{i}", f"buyer{i}@x.com", days_ago=3.0))
        out.append(make_outbound("bounced", "re_bounce", "bruno@naturalfitness.com.br", days_ago=3.0))
        return out

    def test_outputs_four_kinds(self):
        provider = EmailProvider(store=make_store(self._tuda_outbounds()))
        result = provider.collect(make_context())
        kinds = {it.kind for it in result.items}
        self.assertTrue({"result", "action", "risk", "insight"} <= kinds)

    def test_result_metrics(self):
        provider = EmailProvider(store=make_store(self._tuda_outbounds()))
        result = provider.collect(make_context())
        res = next(it for it in result.items if it.kind == "result")
        self.assertEqual(res.detail["sent"], 69)
        self.assertEqual(res.detail["delivered"], 68)
        self.assertEqual(res.detail["bounced"], 1)
        self.assertEqual(res.detail["replied"], 0)

    def test_risk_for_bounced(self):
        provider = EmailProvider(store=make_store(self._tuda_outbounds()))
        result = provider.collect(make_context())
        risks = [it for it in result.items if it.kind == "risk"]
        self.assertEqual(len(risks), 1)
        self.assertIn("bruno@naturalfitness.com.br", risks[0].title)


class TestObservationWindow(unittest.TestCase):
    """第 8 条：区分「仍在回复观察期」和「超过等待期仍无回复」。"""

    def test_overdue_generates_action(self):
        # sent 3 天前（超过 FOLLOWUP_DUE_DAYS=2）→ 生成跟进 action
        outbounds = [make_outbound("delivered", "re_1", "a@x.com", days_ago=3.0)]
        provider = EmailProvider(store=make_store(outbounds))
        result = provider.collect(make_context())
        actions = [it for it in result.items if it.kind == "action"]
        self.assertEqual(len(actions), 1)

    def test_observation_window_no_action(self):
        # sent 今天（仍在观察期）→ 不下结论，不生成 action
        outbounds = [make_outbound("delivered", "re_1", "a@x.com", days_ago=0.1)]
        provider = EmailProvider(store=make_store(outbounds))
        result = provider.collect(make_context())
        actions = [it for it in result.items if it.kind == "action"]
        self.assertEqual(actions, [])

    def test_replied_no_action(self):
        # 已回复 → 不生成 action
        outbounds = [make_outbound("delivered", "re_1", "a@x.com", days_ago=3.0)]
        inbounds = [{"direction": "inbound", "resend_id": "re_1", "created_at": iso_days_ago(1)}]
        provider = EmailProvider(store=make_store(outbounds, inbounds))
        result = provider.collect(make_context())
        actions = [it for it in result.items if it.kind == "action"]
        self.assertEqual(actions, [])


class TestOrchestrationEndToEnd(unittest.TestCase):
    """端到端：途达 69/68/1 → 早报 top3 + plan.json → 晚报核销 + review.json。"""

    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="dc-brief-e2e-"))
        out = []
        for i in range(68):
            out.append(make_outbound("delivered", f"re_{i}", f"buyer{i}@x.com", days_ago=3.0))
        out.append(make_outbound("bounced", "re_bounce", "bruno@naturalfitness.com.br", days_ago=3.0))
        self._store = make_store(out)

    def test_morning_top3_plan(self):
        r = run_morning_brief(make_context("morning"), self._tmp, store=self._store)
        plan = r["plan"]
        self.assertEqual(len(plan["actions"]), 3)  # top3
        self.assertEqual(plan["revision"], 1)
        plan_path = self._tmp / "meorient" / TUDA / "2026-09-10" / "plan.json"
        self.assertTrue(plan_path.exists())

    def test_evening_review_unresolved(self):
        run_morning_brief(make_context("morning"), self._tmp, store=self._store)
        r = run_evening_brief(make_context("evening"), self._tmp, store=self._store)
        review = r["review"]
        # 无 inbound 回复 → 3 项 action 全部 unresolved
        self.assertEqual(len(review["reviews"]), 3)
        self.assertTrue(all(x["status"] == "unresolved" for x in review["reviews"]))
        review_path = self._tmp / "meorient" / TUDA / "2026-09-10" / "review.json"
        self.assertTrue(review_path.exists())

    def test_evening_review_done_on_reply(self):
        # 先跑早报拿到 top3 action，再模拟其中一个买家回复
        run_morning_brief(make_context("morning"), self._tmp, store=self._store)
        plan_path = self._tmp / "meorient" / TUDA / "2026-09-10" / "plan.json"
        import json
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        first = plan["actions"][0]
        rid = first["completion_rule"]["params"]["resend_id"]
        store = make_store(self._store.list_outbound_records.return_value,
                           [{"direction": "inbound", "resend_id": rid,
                             "created_at": iso_days_ago(0)}])
        r = run_evening_brief(make_context("evening"), self._tmp, store=store)
        statuses = [x["status"] for x in r["review"]["reviews"]]
        self.assertEqual(statuses.count("done"), 1)
        self.assertEqual(statuses.count("unresolved"), 2)


class TestTemplateAdvisor(unittest.TestCase):
    def test_template_advise_from_actions(self):
        outbounds = [make_outbound("delivered", "re_1", "a@x.com", days_ago=3.0)]
        provider = EmailProvider(store=make_store(outbounds))
        result = provider.collect(make_context())
        actions = [it for it in result.items if it.kind == "action"]
        snap = build_snapshot(tenant="meorient", company=TUDA, report_type="morning",
                              date="2026-09-10", tz="Asia/Shanghai",
                              as_of="2026-09-10T08:00:00+08:00", candidates=tuple(actions))
        advices = template_advise(snap)
        self.assertEqual(len(advices), 1)
        self.assertEqual(advices[0].confidence, "medium")
        self.assertTrue(advices[0].claim)
        self.assertEqual(len(advices[0].proposed_actions), 1)
        self.assertFalse(advices[0].proposed_actions[0].authorized)  # 默认未授权


if __name__ == "__main__":
    unittest.main(verbosity=2)
