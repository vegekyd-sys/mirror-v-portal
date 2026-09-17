"""P0-E6 展会邮件营销看板（只读聚合）测试。"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway.store import EmailStore
from dc_email_controller.dc_email_signals import record_signal, stable_signal_id
from dc_growth_dashboard import build_dashboard, build_funnel, format_dashboard, _resolve_lead, detect_dashboard_intent
from dc_daily_report import build_morning_report, build_evening_report


class P0E6DashboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        self.store = EmailStore(self.data_dir)
        os.environ["DC_DATA_DIR"] = str(self.data_dir)

    def tearDown(self):
        self.tmp.cleanup()

    def _outbound(self, resend_id, provider_status="delivered", touch=1, recipients=("buyer@x.com",)):
        self.store.insert_message({
            "account_id": "ema_x", "direction": "outbound",
            "message_id": f"<{resend_id}@x.com>", "sender": "thia@mail.dealclaw.io",
            "recipients": list(recipients), "subject": "Hi", "status": "sent",
            "resend_id": resend_id, "company_id": "testco",
            "campaign_id": "camp1", "lead_id": "lead1", "contact_id": "ct1",
            "provider_status": provider_status, "touch_number": touch,
            "sent_at": "2026-08-15T00:00:00+00:00",
        })

    def _signal(self, signal_type, mid):
        record_signal({
            "signal_id": stable_signal_id(signal_type, "testco", mid, "camp1"),
            "signal_type": signal_type, "company_id": "testco", "campaign_id": "camp1",
            "source_message_id": mid, "thread_id": "th-1", "confidence": 0.9,
            "evidence": {"matched_terms": [signal_type]},
            "occurred_at": "2026-08-16T00:00:00+00:00",
        })

    # ── 1 ────────────────────────────────────────────────
    def test_01_dashboard_complete(self):
        self._outbound("re_1", provider_status="delivered")
        self._signal("quote_request", "msg-1")
        self._signal("sample_request", "msg-1")
        self._signal("meeting_interest", "msg-1")
        d = build_dashboard("testco")
        for k in ("funnel", "followup", "buyers", "strategy"):
            self.assertIn(k, d)
        text = format_dashboard(d)
        self.assertIn("触达漏斗", text)
        self.assertIn("买家状态", text)

    # ── 2 ────────────────────────────────────────────────
    def test_02_funnel_consistent_order(self):
        # 口径变更（P0-E6 看板）：触达漏斗改为「企业数」去重口径，数据源是 memory 权威层
        # （dc_memory_data.read_emails/read_signals/read_leads），不再是 EmailStore + 信号层；
        # 故按新数据源喂 fixture（mock 读取），保留原来的链式断言与 replied 数值意图。
        out_x = {"direction": "out", "recipients": ["buyer@x.com"], "provider_status": "delivered",
                 "resend_id": "re_1", "thread_id": "<out-x>", "local_message_id": "<out-x>"}
        out_y = {"direction": "out", "recipients": ["buyer@y.com"], "provider_status": "bounced",
                 "resend_id": "re_2"}
        sigs = [{"signal_type": "quote_request", "source_message_id": "<out-x>", "thread_id": "<out-x>"},
                {"signal_type": "sample_request", "source_message_id": "<out-x>", "thread_id": "<out-x>"},
                {"signal_type": "meeting_interest", "source_message_id": "<out-x>", "thread_id": "<out-x>"}]
        with patch("dc_memory_data.read_emails", return_value=[out_x, out_y]), \
                patch("dc_memory_data.read_signals", return_value=sigs), \
                patch("dc_memory_data.read_leads", return_value=[]):
            f = build_funnel("testco")
        self.assertGreaterEqual(f["sent"], f["delivered"])
        self.assertGreaterEqual(f["delivered"], f["replied"])
        self.assertGreaterEqual(f["replied"], f["valid_inquiry"])
        self.assertGreaterEqual(f["valid_inquiry"], f["meeting_intent"])
        self.assertEqual(f["replied"], 1)  # 唯一回复企业 x.com
        self.assertEqual(f["sent"], 2)
        self.assertEqual(f["bounced"], 1)

    # ── 3 ────────────────────────────────────────────────
    def test_03_deterministic(self):
        self._outbound("re_1", provider_status="delivered")
        self._signal("quote_request", "msg-1")
        d1 = build_dashboard("testco")
        d2 = build_dashboard("testco")
        self.assertEqual(d1["funnel"], d2["funnel"])
        self.assertEqual(d1["strategy"], d2["strategy"])
        self.assertEqual(format_dashboard(d1), format_dashboard(d2))

    # ── 4 ────────────────────────────────────────────────
    def test_04_empty_no_fabrication(self):
        d = build_dashboard("testco")
        self.assertEqual(d["funnel"]["sent"], 0)
        self.assertEqual(d["buyers"], [])
        self.assertIn("暂无数据", format_dashboard(d))

    # ── 5 ────────────────────────────────────────────────
    def test_05_other_enterprise_unaffected(self):
        self._outbound("re_1", provider_status="delivered")
        d = build_dashboard("meorient.com")  # 其他企业
        self.assertEqual(d["funnel"]["sent"], 0)
        self.assertEqual(d["buyers"], [])

    # ── P0-E6 接线 ──────────────────────────────────────
    def test_06_evening_contains_dashboard_summary(self):
        self._outbound("re_1", provider_status="delivered")
        self._signal("quote_request", "msg-1")
        r = build_evening_report("testco")
        # 新版晚报文本不再内嵌「看板摘要/漏斗/策略」段落（改为今日指标 + 待跟进/待确认草稿，
        # 明细跳飞书跟进表）；看板数据仍结构化返回，故改校验新格式行 + 结构化看板字段。
        self.assertEqual(r["slot"], "evening")
        self.assertIn("待跟进", r["text"])
        self.assertIn("待确认草稿", r["text"])
        for k in ("sent", "delivered", "replied"):
            self.assertIn(k, r["funnel"])

    def test_07_morning_contains_key_changes(self):
        self._outbound("re_1", provider_status="delivered")
        r = build_morning_report("testco")
        # 新版早报文本不再带「漏斗/到期跟进/知识库」段落（只做跟进情况总结），
        # 看板与知识库改为结构化字段/明细跳转，故改校验新格式行 + 结构化看板字段。
        self.assertEqual(r["slot"], "morning")
        self.assertIn("待跟进", r["text"])
        self.assertIn("待确认草稿", r["text"])
        for k in ("sent", "delivered", "replied"):
            self.assertIn(k, r["funnel"])

    def test_08_conversational_query_returns_dashboard(self):
        for q in ("看一下邮件情况", "展会进展", "邮件漏斗", "哪些买家需要跟进", "当前营销效果"):
            self.assertTrue(detect_dashboard_intent(q), q)
        self.assertFalse(detect_dashboard_intent("看看"))
        self._outbound("re_1", provider_status="delivered")
        d = build_dashboard("testco")
        self.assertIn("触达漏斗", format_dashboard(d))

    def test_09_structured_field_preferred_over_domain(self):
        leads = [
            {"company_cdp_id": "LEAD-1", "company_name": "Company A", "domain": "a.com", "country": "US"},
            {"company_cdp_id": "LEAD-2", "company_name": "Company B", "domain": "b.com", "country": "BR"},
        ]
        # 邮箱 domain=other.com 不匹配，但 lead_id=LEAD-1 匹配 company_cdp_id
        ob = {"lead_id": "LEAD-1", "contact_id": ""}
        l = _resolve_lead(ob, "buyer@other.com", leads)
        self.assertEqual(l["company_name"], "Company A")

    def test_10_no_match_no_misattribution(self):
        leads = [{"company_cdp_id": "LEAD-2", "company_name": "Company B", "domain": "b.com", "country": "BR"}]
        # 邮箱 domain=x.com 不匹配，且无 lead_id → None（→暂无数据）
        ob = {"lead_id": "", "contact_id": ""}
        self.assertIsNone(_resolve_lead(ob, "buyer@x.com", leads))


if __name__ == "__main__":
    unittest.main()
