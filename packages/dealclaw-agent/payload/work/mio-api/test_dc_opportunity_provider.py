#!/usr/bin/env python3
"""test_dc_opportunity_provider.py — OpportunityProvider + 分层编排测试（标准库 unittest）

覆盖需求：
  - 规则 1：买家回复 / 逾期 next_step / 报价·样品承诺 → 客户级 action
  - 规则 2：每个 action 引用 opportunity + interaction/signal 证据
  - 规则 3：suggested 信号不能生成高优先级 confirmed action
  - 规则 4：lost / 停止触达 / 退订 / paused / won 不生成发送建议
  - 规则 5：fit_grade=A 单独不生成最高优先级 action
  - 规则 6：与 EmailProvider 重复时客户级 action 优先，买家从批量跟进中扣除
  - 规则 7：无商机证据时保留 EmailProvider 批量行动
  - 端到端：68 家待跟进 → 3 家有证据 → 3 客户级 action + 65 批量；Top3 = 有证据客户
  - 晚报：followup_sent / quote_sent / sample_sent 真实事件核销（含部分核销）
  - 跨企业隔离 + 无商机数据

运行：cd work/mio-api && python3 test_dc_opportunity_provider.py
"""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_daily_brief import BriefContext  # noqa: E402
from dc_opportunity_provider import (  # noqa: E402
    OpportunityProvider, layer_batch_followup, collect_evidence, _candidate, _customer_id,
)
from dc_daily_pipeline import run_morning_brief, run_evening_brief  # noqa: E402


COMPANY = "152600996207"


def iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def make_context(report_type="morning", company=COMPANY):
    return BriefContext(
        tenant="meorient", company=company, report_type=report_type,
        date="2026-09-10", tz="Asia/Shanghai",
        as_of="2026-09-10T08:00:00+08:00",
        window_start="2026-09-10T00:00:00+08:00",
        window_end="2026-09-10T23:59:59+08:00",
    )


def make_outbound(provider_status, resend_id, buyer_email, days_ago=3.0, touch_number=0, **extra):
    rec = {
        "direction": "outbound", "provider_status": provider_status,
        "recipients": [buyer_email], "resend_id": resend_id,
        "sent_at": iso_days_ago(days_ago), "created_at": iso_days_ago(days_ago),
        "touch_number": touch_number, "company_id": COMPANY,
        "campaign_id": "brazil-expo", "subject": "巴西展邀请",
    }
    rec.update(extra)
    return rec


class FakeEmailStore:
    def __init__(self, outbounds, inbounds=None):
        self._out, self._in = outbounds, inbounds or []

    def list_outbound_records(self, company_id=None):
        return self._out

    def list_inbound_records(self, company_id=None):
        return self._in


class FakeOppStore:
    """按 company_id 隔离的商机 memory（leads + interactions）。"""

    def __init__(self, by_company=None):
        self._by = by_company or {}

    def list_opportunities(self, company_id):
        return self._by.get(company_id, {}).get("leads", [])

    def list_interactions(self, company_id):
        return self._by.get(company_id, {}).get("interactions", [])


def make_lead(cdp, company, contact="", stage="", grade="", status="active",
              policy="active", next_action="", due="", **extra):
    lead = {
        "company": company, "company_cdp_id": cdp, "website": f"{cdp}.example",
        "contact": contact, "stage": stage, "match_grade": grade,
        "opportunity_status": status, "contact_policy": policy,
        "next_action": next_action, "due": due,
    }
    lead.update(extra)
    return lead


def sig(stype, value="x", evidence_text="原文证据", origin="agent_extracted"):
    return {"type": stype, "value": value, "evidence_text": evidence_text, "origin": origin}


def interaction(iid, cid, direction="outbound", occurred="2026-09-09T10:00:00+08:00",
                signals=None):
    it = {"interaction_id": iid, "customer_id": cid, "channel": "email",
          "direction": direction, "occurred_at": occurred, "subject": "Re: 巴西展"}
    if signals is not None:
        it["signals"] = signals
    return it


def tuda_68_outbounds():
    return [make_outbound("delivered", f"re_{i}", f"buyer{i}@x.com", days_ago=3.0)
            for i in range(68)]


# ── 规则 1：三类证据各自生成客户级 action ─────────────────
class TestTriggers(unittest.TestCase):
    def _store(self):
        leads = [
            make_lead("C001", "Reply Co", "Maria|buyer0@x.com|", stage="已回复", grade="B"),
            make_lead("C002", "Overdue Co", "buyer1@x.com", stage="需求明确", grade="B",
                      next_action="发送报价", due=iso_days_ago(1)),
            make_lead("C003", "Quote Co", "buyer2@x.com", stage="报价中", grade="B"),
        ]
        interact = [
            interaction("it_r", "C001", direction="inbound"),
            interaction("it_o", "C002", direction="outbound"),
            interaction("it_q", "C003", direction="outbound",
                        signals=[sig("quote_request", "询价", "please quote")]),
        ]
        return FakeOppStore({COMPANY: {"leads": leads, "interactions": interact}})

    def test_buyer_reply_action(self):
        res = OpportunityProvider(store=self._store()).collect(make_context())
        arts = {a.detail["customer_id"]: a for a in res.items if a.kind == "action"}
        self.assertEqual(arts["C001"].priority, "buyer_reply")
        self.assertEqual(arts["C001"].completion_rule.type, "followup_sent")

    def test_overdue_next_step_action(self):
        res = OpportunityProvider(store=self._store()).collect(make_context())
        arts = {a.detail["customer_id"]: a for a in res.items if a.kind == "action"}
        self.assertEqual(arts["C002"].priority, "overdue")
        # 规则 2：引用 opportunity + interaction/next_step 证据
        srcs = {e.source for e in arts["C002"].evidence_refs}
        self.assertIn("opportunity", srcs)
        self.assertIn("opportunity_next_step", srcs)

    def test_quote_commitment_action(self):
        res = OpportunityProvider(store=self._store()).collect(make_context())
        arts = {a.detail["customer_id"]: a for a in res.items if a.kind == "action"}
        self.assertEqual(arts["C003"].priority, "commitment")
        self.assertEqual(arts["C003"].action_key and arts["C003"].completion_rule.type,
                         "quote_sent")

    def test_sample_commitment_action(self):
        store = FakeOppStore({COMPANY: {
            "leads": [make_lead("C009", "Sample Co", "buyer9@x.com", stage="需求明确")],
            "interactions": [interaction("it_s", "C009", direction="outbound",
                                         signals=[sig("sample_request", "样品", "send sample")])],
        }})
        res = OpportunityProvider(store=store).collect(make_context())
        art = next(a for a in res.items if a.kind == "action")
        self.assertEqual(art.completion_rule.type, "sample_sent")

    def test_all_actions_have_opportunity_and_signal_evidence(self):
        res = OpportunityProvider(store=self._store()).collect(make_context())
        for a in res.items:
            if a.kind != "action":
                continue
            srcs = {e.source for e in a.evidence_refs}
            self.assertIn("opportunity", srcs, a.title)
            self.assertTrue(srcs & {"interaction", "signal", "opportunity_next_step"}, a.title)


# ── 规则 3：证据等级（suggested 不能升级为高优先级） ────────
class TestEvidenceLevel(unittest.TestCase):
    def test_suggested_signal_no_action(self):
        store = FakeOppStore({COMPANY: {
            "leads": [make_lead("C010", "Suggested Co", "buyer10@x.com", grade="A")],
            "interactions": [interaction("it_sg", "C010", direction="outbound",
                                         signals=[sig("quote_request", "询价", evidence_text="")])],
        }})
        res = OpportunityProvider(store=store).collect(make_context())
        self.assertEqual([a for a in res.items if a.kind == "action"], [])

    def test_confirmed_beats_suggested(self):
        ev_suggested = {"replies": [], "commitments": [],
                        "suggested": [(interaction("x", "c"), "quote_request")],
                        "support": [], "overdue": False,
                        "next_step": {"action": "", "due": ""}, "latest": None}
        self.assertIsNone(_candidate(ev_suggested))
        ev_confirmed = dict(ev_suggested, commitments=[(interaction("x", "c"), "quote_request")])
        self.assertIsNotNone(_candidate(ev_confirmed))


# ── 规则 4：停止触达 / lost / 退订 ─────────────────────────
class TestStopTouch(unittest.TestCase):
    def _collect(self, lead):
        store = FakeOppStore({COMPANY: {
            "leads": [lead],
            "interactions": [interaction("it_1", _customer_id(lead), direction="inbound")],
        }})
        return OpportunityProvider(store=store).collect(make_context())

    def test_do_not_contact_no_action(self):
        res = self._collect(make_lead("C011", "DNC Co", "buyer11@x.com", policy="do_not_contact"))
        self.assertEqual([a for a in res.items if a.kind == "action"], [])

    def test_lost_no_action(self):
        res = self._collect(make_lead("C012", "Lost Co", "buyer12@x.com", status="lost"))
        self.assertEqual([a for a in res.items if a.kind == "action"], [])

    def test_unsubscribed_no_action(self):
        res = self._collect(make_lead("C013", "Unsub Co", "buyer13@x.com", unsubscribed=True))
        self.assertEqual([a for a in res.items if a.kind == "action"], [])

    def test_paused_and_won_no_action(self):
        self.assertEqual(
            [a for a in self._collect(make_lead("C014", "P Co", status="paused")).items
             if a.kind == "action"], [])
        self.assertEqual(
            [a for a in self._collect(make_lead("C015", "W Co", status="won")).items
             if a.kind == "action"], [])

    def test_excluded_count_in_result(self):
        res = self._collect(make_lead("C016", "L Co", status="lost"))
        result = next(i for i in res.items if i.kind == "result")
        self.assertEqual(result.detail["excluded"], 1)


# ── 规则 5：fit_grade=A 单独不判最高优先级 ─────────────────
class TestFitGradeA(unittest.TestCase):
    def test_grade_a_alone_no_action(self):
        store = FakeOppStore({COMPANY: {
            "leads": [make_lead("C020", "A Only", "buyer20@x.com", grade="A", stage="待触达")],
            "interactions": [],
        }})
        res = OpportunityProvider(store=store).collect(make_context())
        self.assertEqual([a for a in res.items if a.kind == "action"], [])

    def test_grade_a_plus_behavior_generates_action(self):
        store = FakeOppStore({COMPANY: {
            "leads": [make_lead("C021", "A Reply", "buyer21@x.com", grade="A", stage="已回复")],
            "interactions": [interaction("it_a", "C021", direction="inbound")],
        }})
        res = OpportunityProvider(store=store).collect(make_context())
        art = next(a for a in res.items if a.kind == "action")
        self.assertEqual(art.priority, "buyer_reply")


# ── 规则 6：分层去重（客户级优先，批量扣除） ───────────────
class TestLayeringDedup(unittest.TestCase):
    def test_deduct_matched_emails(self):
        outbounds = tuda_68_outbounds()
        email_store = FakeEmailStore(outbounds)
        opp_store = FakeOppStore({COMPANY: {
            "leads": [make_lead("C001", "Reply Co", "buyer0@x.com", stage="已回复")],
            "interactions": [interaction("it_r", "C001", direction="inbound")],
        }})
        ctx = make_context()
        from dc_email_provider import EmailProvider
        email_items = EmailProvider(store=email_store).collect(ctx).items
        opp_items = OpportunityProvider(store=opp_store).collect(ctx).items
        opp_actions = [i for i in opp_items if i.kind == "action"]
        self.assertEqual(len(opp_actions), 1)
        layered, info = layer_batch_followup(ctx, email_items, opp_actions)
        batch = next(i for i in layered
                     if i.kind == "action" and i.detail.get("layered_out") is not None)
        self.assertEqual(info["remaining_count"], 67)
        self.assertEqual(info["deducted_emails"], ["buyer0@x.com"])
        self.assertEqual(batch.detail["overdue_count"], 67)

    def test_no_opp_actions_keeps_batch(self):
        ctx = make_context()
        from dc_email_provider import EmailProvider
        email_items = EmailProvider(store=FakeEmailStore(tuda_68_outbounds())).collect(ctx).items
        layered, info = layer_batch_followup(ctx, email_items, [])
        batch = next(i for i in layered if i.kind == "action")
        self.assertTrue(batch.detail["pending_layering"])
        self.assertEqual(batch.detail["overdue_count"], 68)
        self.assertFalse(info["batch_layered"])


# ── 端到端：68 → 3 有证据 + 65 批量；Top3 = 有证据客户 ──────
class TestEndToEnd(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="dc-opp-e2e-"))
        self.email_store = FakeEmailStore(tuda_68_outbounds())
        self.opp_store = FakeOppStore({COMPANY: {
            "leads": [
                make_lead("C001", "Reply Co", "buyer0@x.com", stage="已回复", grade="B"),
                make_lead("C002", "Overdue Co", "buyer1@x.com", stage="需求明确", grade="B",
                          next_action="发送报价", due=iso_days_ago(1)),
                make_lead("C003", "Quote Co", "buyer2@x.com", stage="报价中", grade="B"),
            ],
            "interactions": [
                interaction("it_r", "C001", direction="inbound"),
                interaction("it_o", "C002", direction="outbound"),
                interaction("it_q", "C003", direction="outbound",
                            signals=[sig("quote_request", "询价", "please quote")]),
            ],
        }})

    def test_morning_three_customer_actions_plus_65_batch(self):
        r = run_morning_brief(make_context("morning"), self._tmp,
                              email_store=self.email_store, opp_store=self.opp_store)
        plan = r["plan"]
        opp_actions = [a for a in plan["actions"] if a["source"] == "opportunity"]
        batch = [a for a in plan["actions"] if a["source"] == "email"]
        self.assertEqual(len(opp_actions), 3)
        self.assertEqual(len(batch), 1)
        self.assertEqual(batch[0]["detail"]["overdue_count"], 65)
        self.assertIn("待分层批量跟进", batch[0]["title"])
        # 汇总：3 有证据 + 1 批量
        self.assertEqual(r["layering"]["remaining_count"], 65)
        self.assertEqual(set(r["layering"]["deducted_emails"]),
                         {"buyer0@x.com", "buyer1@x.com", "buyer2@x.com"})

    def test_top3_are_evidence_backed_not_read_order(self):
        r = run_morning_brief(make_context("morning"), self._tmp,
                              email_store=self.email_store, opp_store=self.opp_store)
        plan = r["plan"]
        top_keys = plan["top_n_action_keys"]
        self.assertEqual(len(top_keys), 3)
        by_key = {a["action_key"]: a for a in plan["actions"]}
        self.assertTrue(all(by_key[k]["source"] == "opportunity" for k in top_keys))
        # 批量项不在 Top3
        batch_key = [a["action_key"] for a in plan["actions"] if a["source"] == "email"][0]
        self.assertNotIn(batch_key, top_keys)
        # 优先级：逾期 > 买家回复 > 承诺
        self.assertEqual([by_key[k]["priority"] for k in top_keys],
                         ["overdue", "buyer_reply", "commitment"])

    def test_plan_and_review_written(self):
        run_morning_brief(make_context("morning"), self._tmp,
                          email_store=self.email_store, opp_store=self.opp_store)
        d = self._tmp / "meorient" / COMPANY / "2026-09-10"
        self.assertTrue((d / "plan.json").exists())
        r = run_evening_brief(make_context("evening"), self._tmp, email_store=self.email_store)
        self.assertTrue((d / "review.json").exists())
        self.assertIsNotNone(r["review"])

    def test_evening_nothing_sent_unresolved(self):
        run_morning_brief(make_context("morning"), self._tmp,
                          email_store=self.email_store, opp_store=self.opp_store)
        r = run_evening_brief(make_context("evening"), self._tmp, email_store=self.email_store)
        statuses = {rv["status"] for rv in r["review"]["reviews"]}
        self.assertEqual(statuses, {"unresolved"})


# ── 晚报：真实事件核销 ─────────────────────────────────────
class TestReconciliation(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="dc-opp-recon-"))

    def test_partial_reconciliation(self):
        originals = [make_outbound("delivered", f"re_{i}", f"b{i}@x.com", days_ago=3.0)
                     for i in range(6)]
        run_morning_brief(make_context("morning"), self._tmp,
                          email_store=FakeEmailStore(originals),
                          opp_store=FakeOppStore({}))
        followups = [make_outbound("delivered", f"fu_{i}", f"b{i}@x.com",
                                   days_ago=0, touch_number=1) for i in range(4)]
        r = run_evening_brief(make_context("evening"), self._tmp,
                              email_store=FakeEmailStore(originals + followups))
        self.assertEqual(r["review"]["reviews"][0]["status"], "partial")

    def test_quote_sent_event_completes(self):
        self.email_store = FakeEmailStore([make_outbound("delivered", "re_0", "buyer2@x.com")])
        self.opp_store = FakeOppStore({COMPANY: {
            "leads": [make_lead("C003", "Quote Co", "buyer2@x.com", stage="报价中")],
            "interactions": [interaction("it_q", "C003", direction="outbound",
                                         signals=[sig("quote_request", "询价", "please quote")])],
        }})
        r = run_morning_brief(make_context("morning"), self._tmp,
                              email_store=self.email_store, opp_store=self.opp_store)
        quote_actions = [a for a in r["plan"]["actions"] if a["source"] == "opportunity"]
        self.assertEqual(len(quote_actions), 1)
        # 晚报：真实 quote 发送事件
        events = [{"action_key": quote_actions[0]["action_key"], "kind": "quote_sent",
                   "target_id": "buyer2@x.com", "event_id": "q1",
                   "occurred_at": iso_days_ago(0)}]
        rev = run_evening_brief(make_context("evening"), self._tmp,
                                email_store=self.email_store, events=events)
        status = {rv["action_key"]: rv["status"] for rv in rev["review"]["reviews"]}
        self.assertEqual(status[quote_actions[0]["action_key"]], "done")

    def test_sample_sent_event_completes(self):
        self.email_store = FakeEmailStore([make_outbound("delivered", "re_0", "buyer9@x.com")])
        self.opp_store = FakeOppStore({COMPANY: {
            "leads": [make_lead("C009", "Sample Co", "buyer9@x.com", stage="需求明确")],
            "interactions": [interaction("it_s", "C009", direction="outbound",
                                         signals=[sig("sample_request", "样品", "send sample")])],
        }})
        r = run_morning_brief(make_context("morning"), self._tmp,
                              email_store=self.email_store, opp_store=self.opp_store)
        art = [a for a in r["plan"]["actions"] if a["source"] == "opportunity"][0]
        events = [{"action_key": art["action_key"], "kind": "sample_sent",
                   "target_id": "buyer9@x.com", "event_id": "s1",
                   "occurred_at": iso_days_ago(0)}]
        rev = run_evening_brief(make_context("evening"), self._tmp,
                                email_store=self.email_store, events=events)
        status = {rv["action_key"]: rv["status"] for rv in rev["review"]["reviews"]}
        self.assertEqual(status[art["action_key"]], "done")

    def test_followup_sent_marks_batch_done(self):
        originals = [make_outbound("delivered", f"re_{i}", f"b{i}@x.com", days_ago=3.0)
                     for i in range(3)]
        run_morning_brief(make_context("morning"), self._tmp,
                          email_store=FakeEmailStore(originals), opp_store=FakeOppStore({}))
        followups = [make_outbound("delivered", f"fu_{i}", f"b{i}@x.com",
                                   days_ago=0, touch_number=1) for i in range(3)]
        r = run_evening_brief(make_context("evening"), self._tmp,
                              email_store=FakeEmailStore(originals + followups))
        self.assertEqual(r["review"]["reviews"][0]["status"], "done")


# ── 规则 7 / 跨企业隔离 ────────────────────────────────────
class TestNoDataAndIsolation(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="dc-opp-nodata-"))

    def test_no_opportunity_data_keeps_batch(self):
        r = run_morning_brief(make_context("morning"), self._tmp,
                              email_store=FakeEmailStore(tuda_68_outbounds()),
                              opp_store=FakeOppStore({}))
        plan = r["plan"]
        opp_actions = [a for a in plan["actions"] if a["source"] == "opportunity"]
        batch = next(a for a in plan["actions"] if a["source"] == "email")
        self.assertEqual(opp_actions, [])
        self.assertEqual(batch["detail"]["overdue_count"], 68)
        self.assertFalse(r["layering"]["batch_layered"])

    def test_cross_company_isolated(self):
        other = FakeOppStore({
            "OTHER_CO": {"leads": [make_lead("X1", "Other Co", "buyer0@x.com", stage="已回复")],
                         "interactions": [interaction("it_x", "X1", direction="inbound")]},
            COMPANY: {"leads": [], "interactions": []},
        })
        r = run_morning_brief(make_context("morning"), self._tmp,
                              email_store=FakeEmailStore(tuda_68_outbounds()),
                              opp_store=other)
        opp_actions = [a for a in r["plan"]["actions"] if a["source"] == "opportunity"]
        self.assertEqual(opp_actions, [])  # 其他企业的商机证据不得串入

    def test_provider_error_wrapped(self):
        class Boom:
            def list_opportunities(self, company_id):
                raise RuntimeError("boom")

            def list_interactions(self, company_id):
                return []

        res = OpportunityProvider(store=Boom()).collect(make_context())
        self.assertEqual(res.items, [])
        self.assertTrue(any("RuntimeError" in e for e in res.errors))


if __name__ == "__main__":
    unittest.main(verbosity=2)
