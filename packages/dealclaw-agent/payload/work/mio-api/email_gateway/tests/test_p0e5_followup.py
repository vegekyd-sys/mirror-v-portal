"""P0-E5 展会邮件增长闭环 — 多轮跟进 + 早晚报 测试。"""

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway.store import EmailStore
from dc_email_controller.dc_followup import (
    list_followup_candidates, run_followup_cycle, FOLLOWUP_MAX_ROUNDS,
)
from dc_email_controller.dc_reply_draft import list_drafts
from dc_daily_report import build_morning_report, build_evening_report


def _days_ago(n):
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()


class P0E5GrowthLoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        self.store = EmailStore(self.data_dir)
        os.environ["DC_DATA_DIR"] = str(self.data_dir)

    def tearDown(self):
        self.tmp.cleanup()

    def _outbound(self, resend_id, touch=1, provider_status="delivered",
                  recipients=("buyer@x.com",), sent_at=None, contact_id="ct1",
                  campaign_id="camp1", lead_id="lead1"):
        self.store.insert_message({
            "account_id": "ema_x", "direction": "outbound",
            "message_id": f"<{resend_id}@x.com>", "sender": "thia@mail.dealclaw.io",
            "recipients": list(recipients), "subject": "Hi", "status": "sent",
            "resend_id": resend_id, "company_id": "testco",
            "campaign_id": campaign_id, "lead_id": lead_id, "contact_id": contact_id,
            "provider_status": provider_status, "touch_number": touch,
            "sent_at": sent_at or _days_ago(3),
        })

    def _inbound_bound(self, thread_id, contact_id="ct1", received_at=None):
        self.store.insert_message({
            "account_id": "ema_x", "direction": "inbound",
            "message_id": f"<ib-{thread_id}@x.com>", "sender": "buyer@x.com",
            "recipients": ["thia@mail.dealclaw.io"], "subject": "Re: Hi",
            "status": "received", "company_id": "testco",
            "binding_status": "bound", "thread_id": thread_id, "contact_id": contact_id,
            "received_at": received_at or _days_ago(1),
        })

    # ── 跟进候选 ──────────────────────────────────────────
    def test_01_unreplied_delivered_is_candidate_next_touch_2(self):
        self._outbound("re_1", touch=1)
        cands = list_followup_candidates("testco")
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0]["next_touch"], 2)

    def test_02_bounced_not_candidate(self):
        self._outbound("re_1", touch=1, provider_status="bounced")
        self.assertEqual(len(list_followup_candidates("testco")), 0)

    def test_03_replied_not_candidate(self):
        self._outbound("re_1", touch=1)
        self._inbound_bound("<re_1@x.com>")
        self.assertEqual(len(list_followup_candidates("testco")), 0)

    def test_04_third_round_stops(self):
        self._outbound("re_1", touch=3)  # next_touch=4 > 3
        self.assertEqual(len(list_followup_candidates("testco")), 0)

    def test_05_not_due_yet(self):
        self._outbound("re_1", touch=1, sent_at=_days_ago(0))  # 今天，未到期
        self.assertEqual(len(list_followup_candidates("testco")), 0)

    # ── 跟进循环 + 幂等 ─────────────────────────────────
    def test_06_cycle_generates_followup_draft(self):
        self._outbound("re_1", touch=1)
        r = run_followup_cycle("testco")
        self.assertEqual(r["generated"], 1)
        drafts = list_drafts(company_id="testco", status="pending_confirmation")
        self.assertEqual(len(drafts), 1)
        self.assertEqual(drafts[0]["touch_number"], 2)
        self.assertEqual(drafts[0]["category"], "followup")

    def test_07_cycle_idempotent(self):
        self._outbound("re_1", touch=1)
        run_followup_cycle("testco")
        r2 = run_followup_cycle("testco")
        self.assertEqual(r2["generated"], 0)  # 幂等，不重复生成
        self.assertEqual(len(list_drafts(company_id="testco")), 1)

    def test_08_second_round_touch_3(self):
        self._outbound("re_1", touch=2)
        r = run_followup_cycle("testco")
        self.assertEqual(r["generated"], 1)
        drafts = list_drafts(company_id="testco", status="pending_confirmation")
        self.assertEqual(drafts[0]["touch_number"], 3)

    # ── 早晚报 ────────────────────────────────────────────
    def test_09_morning_report_metrics(self):
        self._outbound("re_1", touch=1, provider_status="delivered")
        self._outbound("re_2", touch=1, provider_status="bounced")
        r = build_morning_report("testco")
        self.assertEqual(r["metrics"]["sent"], 2)
        self.assertEqual(r["metrics"]["delivered"], 1)
        self.assertEqual(r["metrics"]["bounced"], 1)
        # 新版早报文本不再带「早报」标题（Daily Brief 新格式），改为校验 slot 与新版汇总行
        self.assertEqual(r["slot"], "morning")
        self.assertIn("待跟进", r["text"])

    def test_10_evening_report_metrics(self):
        # 晚报「今日」按企业业务时区当日计（2026-09-12 修「今日」取日 bug）：
        # 今日发出的计 1 封，3 天前发出的不计入。
        self._outbound("re_1", touch=1, sent_at=datetime.now(timezone.utc).isoformat())
        self._outbound("re_2", touch=1, sent_at=_days_ago(3))
        r = build_evening_report("testco")
        self.assertEqual(r["metrics"]["sent"], 1)
        self.assertEqual(r["slot"], "evening")
        self.assertIn("待跟进", r["text"])

    def test_11_rejected_buyer_not_followup_candidate(self):
        import importlib
        import dc_ls_store
        importlib.reload(dc_ls_store)
        ls = dc_ls_store.LeadStore()
        # 买家已拒绝（iq_stage=-1 + status=不是我的买家）
        ls.save_lead({"company_name": "Rejected Co", "domain": "x.com",
                      "enterprise": "testco", "user_open_id": "ou_1",
                      "status": "不是我的买家", "iq_stage": -1})
        self._outbound("re_1", touch=1, provider_status="delivered")
        cands = list_followup_candidates("testco")
        self.assertEqual(len(cands), 0)  # 拒绝买家不再跟进

    def test_12_normal_buyer_still_candidate(self):
        import importlib
        import dc_ls_store
        importlib.reload(dc_ls_store)
        ls = dc_ls_store.LeadStore()
        ls.save_lead({"company_name": "Good Co", "domain": "x.com",
                      "enterprise": "testco", "user_open_id": "ou_1",
                      "status": "我的买家", "iq_stage": 1})
        self._outbound("re_1", touch=1, provider_status="delivered")
        cands = list_followup_candidates("testco")
        self.assertEqual(len(cands), 1)  # 正常买家仍跟进


if __name__ == "__main__":
    unittest.main()
