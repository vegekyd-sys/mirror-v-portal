#!/usr/bin/env python3
"""test_email_metrics_integration.py — 邮件统计口径第一阶段（兼容修复 + 影子双读 + 按租户切换）

覆盖任务要求的场景：
  ① 三处（早晚报 / EmailProvider / 看板）数字一致
  ② 已回复不得进待跟进
  ③ 未归属回复（unassigned）正确处理
  ④ 跨日（UTC → Asia/Shanghai）
  ⑤ 数据不完整 → partial / unavailable，**不返回假 0**
  ⑥ shadow 模式：用户可见输出 = 旧口径，差异只记日志/落盘
  ⑦ legacy 字段名兼容回归（record_type / direction、resend_received_id / resend_id）
  ⑧ 按租户口径开关（默认 legacy）

运行：
  cd work/mio-api && python3 -m unittest tests.test_email_metrics_integration -v
  或 python3 tests/test_email_metrics_integration.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from email_metrics import config as cfg  # noqa: E402
from email_metrics.config import MODE_ENV  # noqa: E402
from email_metrics.legacy import business_date  # noqa: E402
from email_metrics.service import (STATUS_OK, STATUS_PARTIAL, STATUS_UNAVAILABLE,  # noqa: E402
                                   read_email_metrics)

C1 = "152600996207"
COMPANY = C1


# ── 夹具（**按真实落盘字段名**：record_type / resend_received_id）──────
def out_record(i, *, status="delivered", sent_at="2026-09-12T01:00:00+00:00",
               with_provider_id=True, recipients=None, touch=0):
    rec = {
        "schema_version": 1,
        "record_type": "outbound",
        "account_id": "acc1",
        "company_id": COMPANY,
        "campaign_id": "cmp1",
        "recipients": recipients or [f"buyer{i}@x.com"],
        "provider_status": status,
        "status": "sent",
        "sent_at": sent_at,
        "created_at": sent_at,
        "touch_number": touch,
        "thread_id": f"thread{i}",
    }
    if with_provider_id:
        rec["resend_id"] = f"re_{i}"
        rec["smtp_message_id"] = f"<smtp{i}@x>"
    return rec


def in_record(i, *, in_reply_to="", received_at="2026-09-12T02:00:00+00:00",
              binding="bound", received_id=None):
    rec = {
        "schema_version": 1,
        "record_type": "inbound",
        "account_id": "acc1",
        "company_id": COMPANY,
        "message_id": f"<in{i}@buyer>",
        "resend_received_id": received_id if received_id is not None else f"rcv_{i}",
        "in_reply_to": in_reply_to,
        "references": [],
        "thread_id": "",
        "received_at": received_at,
        "created_at": received_at,
    }
    if binding:
        rec["binding_status"] = binding
    return rec


class FakeStore:
    def __init__(self, outbounds, inbounds=None):
        self._out = list(outbounds)
        self._in = list(inbounds or [])

    def list_outbound_records(self, company_id=None):
        return [r for r in self._out if not company_id or r.get("company_id") == company_id]

    def list_inbound_records(self, company_id=None):
        return [r for r in self._in if not company_id or r.get("company_id") == company_id]


class BoomStore:
    def list_outbound_records(self, company_id=None):
        raise OSError("email-facts 目录不可读")

    def list_inbound_records(self, company_id=None):
        raise OSError("email-facts 目录不可读")


def make_context(tenant="meorient", company=COMPANY, date="2026-09-12"):
    from dc_daily_brief import BriefContext
    return BriefContext(
        tenant=tenant, company=company, report_type="morning", date=date,
        tz="Asia/Shanghai", as_of=f"{date}T08:00:00+08:00",
        window_start=f"{date}T00:00:00+08:00", window_end=f"{date}T23:59:59+08:00",
    )


class ModeEnvMixin:
    """按用例设置口径开关；tearDown 一律还原（默认 legacy）。"""

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in list(os.environ)
                       if k.startswith("DC_EMAIL_METRICS_MODE") or k == "DC_REPORT_TIMEZONE"}
        os.environ.pop(MODE_ENV, None)

    def tearDown(self):
        for k in list(os.environ):
            if k.startswith("DC_EMAIL_METRICS_MODE"):
                os.environ.pop(k, None)
        os.environ.update({k: v for k, v in self._saved.items() if v is not None})


# ── ⑦ legacy 字段名兼容回归 ─────────────────────────────
class TestLegacyFieldNameCompat(ModeEnvMixin, unittest.TestCase):
    def test_default_mode_is_legacy(self):
        self.assertEqual(cfg.resolve_mode(), "legacy", "开关缺省必须是 legacy（线上行为不变）")
        self.assertEqual(cfg.resolve_mode(tenant="meorient", company_id=COMPANY), "legacy")

    def test_two_field_bugs_are_fixed(self):
        """落盘写 record_type、入站存 resend_received_id —— 旧代码读错就恒 0 / 虚高待跟进。"""
        from dc_email_provider import EmailProvider
        store = FakeStore(
            [out_record(1, sent_at="2026-09-09T01:00:00+00:00")],          # 3 天前，超过观察期
            [in_record(1, in_reply_to="", received_id="re_1")],            # 入站 id 存在 resend_received_id
        )
        result = EmailProvider(store=store).collect(make_context())
        res = next(it for it in result.items if it.kind == "result")
        self.assertEqual(res.detail["replied"], 1, "回复不再恒 0（此前读 direction 读不到）")
        actions = [it for it in result.items if it.kind == "action"]
        self.assertEqual(actions, [], "已回复不得进待跟进（此前读 resend_id 读不到 → 虚高）")

    def test_direction_alias_out_in(self):
        """dc_memory_data 落盘写 direction=out/in，也要认。"""
        from email_metrics.legacy import direction_of, is_inbound
        self.assertEqual(direction_of({"direction": "out"}), "outbound")
        self.assertEqual(direction_of({"direction": "in"}), "inbound")
        self.assertTrue(is_inbound({"record_type": "inbound"}))
        self.assertFalse(is_inbound({"record_type": "outbound"}))


# ── ⑧ 按租户切换 ────────────────────────────────────────
class TestPerTenantMode(ModeEnvMixin, unittest.TestCase):
    def test_tenant_scoped_switch(self):
        os.environ[f"{MODE_ENV}_MEORIENT"] = "v1"
        self.assertEqual(cfg.resolve_mode(tenant="meorient"), "v1")
        self.assertEqual(cfg.resolve_mode(tenant="tuda"), "legacy", "未配置租户不受影响")
        self.assertEqual(cfg.describe(tenant="meorient")["decided_by"],
                         f"{MODE_ENV}_MEORIENT")

    def test_company_scoped_switch_and_invalid_value_falls_back(self):
        os.environ[f"{MODE_ENV}_{COMPANY}"] = "shadow"
        self.assertEqual(cfg.resolve_mode(company_id=COMPANY), "shadow")
        os.environ[MODE_ENV] = "V1 "          # 大小写/空白归一
        self.assertEqual(cfg.resolve_mode(), "v1")
        os.environ[MODE_ENV] = "yolo"          # 非法值 → 回退 legacy，不抛错
        self.assertEqual(cfg.resolve_mode(), "legacy")

    def test_service_uses_tenant_mode(self):
        os.environ[f"{MODE_ENV}_MEORIENT"] = "v1"
        store = FakeStore([out_record(1)], [])
        m = read_email_metrics(company_id=COMPANY, tenant="meorient", store=store)
        self.assertEqual(m["mode"], "v1")
        self.assertIsNotNone(m["v1"])
        m2 = read_email_metrics(company_id=COMPANY, tenant="other", store=store)
        self.assertEqual(m2["mode"], "legacy")
        self.assertIsNone(m2["v1"])


# ── ① 三处数字一致 ──────────────────────────────────────
class TestThreeConsumersAgree(ModeEnvMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        os.environ[MODE_ENV] = "v1"
        # 3 送达 + 1 退信；2 封入站分别回复前两封（In-Reply-To 强引用）
        self.store = FakeStore(
            [out_record(i) for i in (0, 1, 2)] + [out_record(3, status="bounced")],
            [in_record(0, in_reply_to="<smtp0@x>"),
             in_record(1, in_reply_to="<smtp1@x>", binding="bound")],
        )

    def _numbers(self):
        import dc_daily_report as dr
        import dc_growth_dashboard as gd
        from dc_email_provider import EmailProvider
        from email_metrics.service import read_email_metrics as svc

        daily = dr.collect_metrics(COMPANY, store=self.store, tz="Asia/Shanghai")
        provider = EmailProvider(store=self.store).collect(make_context())
        res = next(it for it in provider.items if it.kind == "result").detail
        dash = gd.build_email_metrics(COMPANY, store=self.store, signals=[])["metrics"]
        shared = svc(company_id=COMPANY, store=self.store, consumer="test")["metrics"]
        keys = ("sent", "delivered", "bounced", "replied")
        return ({k: daily[k] for k in keys}, {k: res[k] for k in keys},
                {k: dash[k] for k in keys}, {k: shared[k] for k in keys})

    def test_all_three_read_same_caliber(self):
        daily, provider, dash, shared = self._numbers()
        self.assertEqual(daily, provider, "早晚报与 EmailProvider 数字必须一致")
        self.assertEqual(daily, dash, "早晚报与看板数字必须一致")
        self.assertEqual(daily, shared, "三处都必须来自唯一读入口")
        self.assertEqual(daily, {"sent": 4, "delivered": 3, "bounced": 1, "replied": 2},
                         "v1 口径：发送=accepted 4 · 送达=delivered_final 3 · 退信 1 · 唯一回复买家 2")

    def test_shadow_mode_keeps_legacy_numbers_but_records_diff(self):
        os.environ[MODE_ENV] = "shadow"
        shadow_dir = tempfile.mkdtemp(prefix="dc-shadow-")
        os.environ["DC_EMAIL_METRICS_SHADOW_DIR"] = shadow_dir
        try:
            # 故意造两处口径差：无 provider id 的旧记录（旧算、v1 不算）+ 未归属入站
            store = FakeStore(
                [out_record(i) for i in (0, 1, 2)] + [out_record(3, status="bounced"),
                                                      out_record(4, with_provider_id=False)],
                [in_record(0, in_reply_to="<smtp0@x>"),
                 in_record(9, in_reply_to="", binding=None)],
            )
            m = read_email_metrics(company_id=COMPANY, store=store, consumer="shadow-test")
            self.assertEqual(m["status"], STATUS_OK)
            # 用户可见 = 旧口径：发送 = outbound 记录数（5），回复 = 入站消息数（2）
            self.assertEqual(m["metrics"], {"sent": 5, "delivered": 4, "bounced": 1, "replied": 2})
            self.assertIsNotNone(m["v1"], "shadow 必须同时算 v1")
            self.assertTrue(m["shadow"]["recorded"], "shadow 差异必须落盘")
            files = list(Path(shadow_dir).glob("shadow-*.jsonl"))
            self.assertEqual(len(files), 1, "差异按业务日切成 JSONL")
            payload = json.loads(files[0].read_text(encoding="utf-8").splitlines()[-1])
            self.assertEqual(payload["consumer"], "shadow-test")
            diff = {d["metric"]: d for d in payload["diff"]}
            self.assertEqual(payload["legacy"]["sent"], 5)
            self.assertEqual(payload["v1"]["sent"], 4, "无 provider id 不计入 sent")
            self.assertEqual(diff["sent"]["delta"], -1)
            self.assertTrue(diff["sent"]["reason"], "差异必须带原因")
            self.assertEqual(diff["replied"]["delta"], -1, "未归属回复不计入唯一回复买家")
            self.assertTrue(diff["replied"]["reason"])
            # shadow 不得改变用户可见输出
            from dc_email_provider import EmailProvider
            res = next(it for it in EmailProvider(store=store).collect(make_context()).items
                       if it.kind == "result").detail
            self.assertEqual(res["sent"], 5)
            self.assertEqual(res["replied"], 2)
        finally:
            os.environ.pop("DC_EMAIL_METRICS_SHADOW_DIR", None)


# ── ② 已回复不得进待跟进 ────────────────────────────────
class TestRepliedNotInFollowup(ModeEnvMixin, unittest.TestCase):
    def _overdue_emails(self):
        from dc_email_provider import EmailProvider
        store = FakeStore(
            [out_record(0, sent_at="2026-09-09T01:00:00+00:00"),
             out_record(1, sent_at="2026-09-09T01:00:00+00:00")],
            [in_record(0, in_reply_to="<smtp0@x>")],
        )
        result = EmailProvider(store=store).collect(make_context())
        actions = [it for it in result.items if it.kind == "action"]
        emails = [t.id for a in actions for t in a.target_refs if t.type == "buyer"]
        return emails, result

    def test_legacy_mode(self):
        emails, _ = self._overdue_emails()
        self.assertIn("buyer1@x.com", emails)
        self.assertNotIn("buyer0@x.com", emails, "已回复的买家不得进待跟进")

    def test_v1_mode(self):
        os.environ[MODE_ENV] = "v1"
        emails, _ = self._overdue_emails()
        self.assertIn("buyer1@x.com", emails)
        self.assertNotIn("buyer0@x.com", emails, "v1 口径下同样不得进待跟进")


# ── ③ 未归属回复 ────────────────────────────────────────
class TestUnassignedReply(ModeEnvMixin, unittest.TestCase):
    def test_unassigned_is_kept_not_silently_dropped(self):
        os.environ[MODE_ENV] = "v1"
        store = FakeStore(
            [out_record(0, sent_at="2026-09-09T01:00:00+00:00")],
            [in_record(0, in_reply_to="", binding=None)],   # 无任何引用 → unassigned
        )
        m = read_email_metrics(company_id=COMPANY, store=store, consumer="unassigned-test")
        self.assertEqual(m["status"], STATUS_OK, "未归属是分级结果，不是数据不完整")
        self.assertEqual(m["metrics"]["replied"], 0, "匹配不到不得硬挂，不计入唯一回复买家")
        self.assertEqual(m["unassigned_count"], 1, "未归属必须被计数/保留")
        evidence = m["availability"]["evidence"]["v1_unassigned_ambiguous"]
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["binding_status"], "unassigned")
        self.assertFalse(evidence[0]["counted"], "未归属不计入批次")
        self.assertNotIn("@", json.dumps(evidence), "证据必须脱敏")
        # 未被归属 → 该买家仍留在待跟进（不静默丢弃，也不虚假排除）
        from dc_email_provider import EmailProvider
        result = EmailProvider(store=store).collect(make_context())
        emails = [t.id for a in result.items if a.kind == "action"
                  for t in a.target_refs if t.type == "buyer"]
        self.assertEqual(emails, ["buyer0@x.com"])


# ── ④ 跨日（UTC → Asia/Shanghai）────────────────────────
class TestCrossDayTimezone(ModeEnvMixin, unittest.TestCase):
    def test_business_date_not_utc_date(self):
        # UTC 09-10 17:10 = 上海 09-11 01:10 → 业务日是 09-11，不是 09-10
        self.assertEqual(business_date("2026-09-10T17:10:00+00:00"), "2026-09-11")
        self.assertEqual(business_date("2026-09-10T02:00:00+00:00"), "2026-09-10")

    def test_today_filter_is_tz_aware_in_both_calibers(self):
        store = FakeStore(
            [out_record(0, sent_at="2026-09-10T17:10:00+00:00")],   # 上海 09-11 01:10
            [in_record(0, in_reply_to="<smtp0@x>", received_at="2026-09-10T18:00:00+00:00")],
        )
        for mode in ("legacy", "v1"):
            os.environ[MODE_ENV] = mode
            m_10 = read_email_metrics(company_id=COMPANY, store=store, date="2026-09-10")
            m_11 = read_email_metrics(company_id=COMPANY, store=store, date="2026-09-11")
            self.assertEqual(m_10["metrics"]["sent"], 0,
                             f"{mode}: UTC 09-10 17:10 不属于上海 09-10")
            self.assertEqual(m_11["metrics"]["sent"], 1,
                             f"{mode}: UTC 09-10 17:10 属于上海 09-11")
            self.assertEqual(m_11["metrics"]["replied"], 1, f"{mode}: 回复同样按业务日归属")

    def test_store_count_sent_today_is_tz_aware(self):
        from email_gateway.store import EmailStore
        tmp = tempfile.mkdtemp(prefix="dc-store-tz-")
        store = EmailStore(data_dir=tmp)
        now = datetime.now(timezone.utc)
        store.insert_message({"direction": "outbound", "company_id": COMPANY,
                              "account_id": "acc1", "recipients": ["a@x.com"],
                              "status": "sent", "provider_status": "delivered",
                              "created_at": now.isoformat(), "sent_at": now.isoformat()})
        old = (now - timedelta(hours=30)).isoformat()
        store.insert_message({"direction": "outbound", "company_id": COMPANY,
                              "account_id": "acc1", "recipients": ["b@x.com"],
                              "status": "sent", "provider_status": "delivered",
                              "created_at": old, "sent_at": old})
        self.assertEqual(store.count_sent_today("acc1"), 1, "今日只算业务时区当天")


# ── ⑤ 数据不完整 → partial / unavailable（不得假 0）──────
class TestCompletenessNotFakeZero(ModeEnvMixin, unittest.TestCase):
    def test_partial_when_legacy_records_unverifiable(self):
        os.environ[MODE_ENV] = "v1"
        store = FakeStore(
            [out_record(0),                        # 有 provider id → accepted
             out_record(1, with_provider_id=False)],  # 无 provider id → legacy_unverified
            [],
        )
        m = read_email_metrics(company_id=COMPANY, store=store, consumer="partial-test")
        self.assertEqual(m["status"], STATUS_PARTIAL)
        self.assertIn("legacy_unverified:1", m["reasons"])
        self.assertEqual(m["metrics"]["sent"], 1, "不能因为不完整就报 0")
        self.assertEqual(m["v1"]["legacy_unverified"], 1)

    def test_unavailable_when_source_unreadable(self):
        os.environ[MODE_ENV] = "v1"
        for mode in ("legacy", "shadow", "v1"):
            os.environ[MODE_ENV] = mode
            m = read_email_metrics(company_id=COMPANY, store=BoomStore(), consumer="boom")
            self.assertEqual(m["status"], STATUS_UNAVAILABLE, f"{mode}: 数据源不可用必须上报")
            self.assertIsNone(m["metrics"]["sent"], f"{mode}: 不得返回假 0")
            self.assertTrue(any("source_unavailable" in r for r in m["reasons"]))
            self.assertIn("OSError", m["availability"]["error"])

    def test_render_line_never_shows_fake_zero(self):
        from email_metrics.service import format_metrics_line
        line = format_metrics_line({"status": STATUS_UNAVAILABLE,
                                    "metrics": {"sent": None, "delivered": None,
                                                "bounced": None, "replied": None},
                                    "reasons": ["source_unavailable:OSError"]})
        self.assertIn("不可用", line)
        self.assertNotIn("0", line)

    def test_email_provider_reports_unavailable_not_zero(self):
        os.environ[MODE_ENV] = "v1"
        from dc_email_provider import EmailProvider
        metrics = read_email_metrics(company_id=COMPANY, store=BoomStore())
        result = EmailProvider(store=FakeStore([]), metrics=metrics).collect(make_context())
        res = next(it for it in result.items if it.kind == "result")
        self.assertEqual(res.detail["data_status"], STATUS_UNAVAILABLE)
        self.assertIsNone(res.detail["sent"])
        self.assertIn("不可用", res.title)


class TestFollowupChainReplyAttribution(ModeEnvMixin, unittest.TestCase):
    """待跟进链路（dc_followup）：入站字段名写 resend_received_id 时不得算成未回复。"""

    def test_replied_buyer_not_in_followup_candidates(self):
        import email_gateway.store as store_mod
        import dc_email_controller.dc_followup as fu
        import dc_ls_store

        store = FakeStore(
            [out_record(0, sent_at="2026-09-09T01:00:00+00:00", touch=0)],
            [in_record(0, in_reply_to="<smtp0@x>", binding=None)],
        )

        class _LS:
            def is_buyer_blocked(self, *a, **k):
                return False

        orig_ls, orig_es = dc_ls_store.LeadStore, store_mod.EmailStore
        dc_ls_store.LeadStore = _LS
        store_mod.EmailStore = lambda *a, **k: store
        try:
            cands = fu.list_followup_candidates(COMPANY)
        finally:
            dc_ls_store.LeadStore = orig_ls
            store_mod.EmailStore = orig_es
        self.assertEqual(cands, [], "已回复不得进待跟进（入站存 resend_received_id 也要认）")

    def test_unreplied_buyer_still_a_candidate(self):
        import email_gateway.store as store_mod
        import dc_email_controller.dc_followup as fu
        import dc_ls_store

        store = FakeStore([out_record(0, sent_at="2026-09-09T01:00:00+00:00", touch=0)], [])

        class _LS:
            def is_buyer_blocked(self, *a, **k):
                return False

        orig_ls, orig_es = dc_ls_store.LeadStore, store_mod.EmailStore
        dc_ls_store.LeadStore = _LS
        store_mod.EmailStore = lambda *a, **k: store
        try:
            cands = fu.list_followup_candidates(COMPANY)
        finally:
            dc_ls_store.LeadStore = orig_ls
            store_mod.EmailStore = orig_es
        self.assertEqual(len(cands), 1, "未回复且到期的仍必须进待跟进（不能过度排除）")


ALL_TESTS = [v for k, v in sorted(globals().items())
             if k.startswith("test_") or (isinstance(v, type) and issubclass(v, unittest.TestCase))]  # noqa: E501


if __name__ == "__main__":
    unittest.main(verbosity=2)
