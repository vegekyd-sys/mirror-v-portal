#!/usr/bin/env python3
"""T7 — 发信质量与用量指标的自检测试（标准库 unittest，无 pytest / 无新依赖）。

覆盖：六指标分渠道聚合口径、退信率/投诉率分母、租户隔离、租户时区分日边界、
区间闭区间、两套账（权益账 / Provider 成本账）、缺口如实上报、只读无副作用、CLI。

跑法（权威副本根目录）：
  cd <mio-api> && python3 -m unittest discover -s email_gateway/tests -t .
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway.store import EmailStore
from email_metrics.quality_metrics import (CHANNEL_FOUNDER_DIRECT, CHANNEL_GROWTH_SEND,
                                           CHANNEL_UNATTRIBUTED, METRICS,
                                           format_quality_line, metrics_view)

# 纯数字企业 id：enterprise_ids.canonical_company_id 对数字原样返回，
# 不受测试环境里 MIO_CDP_SUPPLIER_ID 影响。
ENT = "152600996207"
OTHER_ENT = "999888777"
GS_ACCOUNT = "resend_gs"
FD_ACCOUNT = "ema_fd0000000000001"


def outbound(*, resend_id="", account_id=GS_ACCOUNT, status="sent", provider_status="",
             created_at="2026-09-14T02:00:00+00:00", company_id=ENT, thread_id="",
             local_message_id="", smtp_message_id=""):
    rec = {"company_id": company_id, "account_id": account_id, "status": status,
           "created_at": created_at, "sent_at": created_at,
           "provider_status": provider_status}
    if resend_id:
        rec["resend_id"] = resend_id
        rec["local_message_id"] = local_message_id or resend_id
    if thread_id:
        rec["thread_id"] = thread_id
    if smtp_message_id:
        rec["smtp_message_id"] = smtp_message_id
    return rec


def inbound(*, message_id, received_at="2026-09-14T04:00:00+00:00", sender="buyer@example.com",
            company_id=ENT, in_reply_to="", references=None, thread_id="", contact_id="",
            lead_id=""):
    rec = {"company_id": company_id, "message_id": message_id, "sender": sender,
           "received_at": received_at, "created_at": received_at}
    if in_reply_to:
        rec["in_reply_to"] = in_reply_to
    if references:
        rec["references"] = references
    if thread_id:
        rec["thread_id"] = thread_id
    if contact_id:
        rec["contact_id"] = contact_id
    if lead_id:
        rec["lead_id"] = lead_id
    return rec


class T7SendQualityTests(unittest.TestCase):

    # ── 1. 六指标 / 分渠道 ──────────────────────────────
    def test_01_six_metrics_present_per_channel(self):
        view = metrics_view(ENT, outbound_records=[], inbound_records=[], accounts=[])
        for ch in (CHANNEL_FOUNDER_DIRECT, CHANNEL_GROWTH_SEND, CHANNEL_UNATTRIBUTED, "all"):
            self.assertIn(ch, view["channels"])
            for metric in METRICS:
                self.assertIn(metric, view["channels"][ch],
                              f"{ch} 缺指标 {metric}")
        # 未采集的指标必须是 None（不是 0）
        self.assertIsNone(view["metrics"]["unsubscribed"])
        self.assertIsNone(view["channels"]["all"]["unsubscribed"])
        self.assertIs(view["gaps"]["unsubscribed"]["collected"], False)

    def test_02_channel_split_by_account(self):
        out = [
            outbound(resend_id="gs1", account_id=GS_ACCOUNT, provider_status="delivered"),
            outbound(resend_id="gs2", account_id=GS_ACCOUNT, provider_status="bounced"),
            outbound(resend_id="fd1", account_id=FD_ACCOUNT, provider_status="delivered"),
            outbound(resend_id="fd2", account_id=FD_ACCOUNT),
        ]
        view = metrics_view(ENT, outbound_records=out, inbound_records=[], accounts=[])
        gs = view["channels"][CHANNEL_GROWTH_SEND]
        fd = view["channels"][CHANNEL_FOUNDER_DIRECT]
        self.assertEqual((gs["accepted"], gs["delivered"], gs["bounced"]), (2, 1, 1))
        self.assertEqual((fd["accepted"], fd["delivered"], fd["pending"]), (2, 1, 1))
        self.assertEqual(view["channels"]["all"]["accepted"], 4)

    def test_03_rates_use_accepted_denominator(self):
        out = [
            outbound(resend_id="a", provider_status="delivered"),
            outbound(resend_id="b", provider_status="delivered"),
            outbound(resend_id="c", provider_status="bounced"),
            outbound(resend_id="d", provider_status="complained"),
        ]
        view = metrics_view(ENT, outbound_records=out, inbound_records=[], accounts=[])
        health = view["provider_health"]
        self.assertEqual(health["accepted"], 4)
        self.assertEqual(health["bounce_rate"], round(1 / 4, 4))
        self.assertEqual(health["complaint_rate"], round(1 / 4, 4))
        self.assertEqual(health["sample"]["all"],
                         {"accepted": 4, "bounced": 1, "complained": 1})
        self.assertEqual(health["basis"]["bounce_rate"], "bounced / accepted（同日同时段同渠道队列）")
        self.assertEqual(health["basis"]["complaint_rate"], "complained / accepted（同日同时段同渠道队列）")
        # 分渠道同样按 accepted 为分母
        self.assertEqual(health["by_channel"][CHANNEL_GROWTH_SEND]["bounce_rate"],
                         round(1 / 4, 4))

    def test_04_rates_are_none_without_accepted(self):
        view = metrics_view(ENT, outbound_records=[], inbound_records=[], accounts=[])
        self.assertIsNone(view["provider_health"]["bounce_rate"])
        self.assertIsNone(view["provider_health"]["complaint_rate"])

    # ── 2. 租户隔离 ────────────────────────────────────
    def test_05_tenant_isolation(self):
        out = [
            outbound(resend_id="mine", provider_status="delivered"),
            outbound(resend_id="theirs", provider_status="bounced", company_id=OTHER_ENT),
        ]
        inb = [
            inbound(message_id="m-mine", in_reply_to="mine"),
            inbound(message_id="m-theirs", company_id=OTHER_ENT),
        ]
        view = metrics_view(ENT, outbound_records=out, inbound_records=inb, accounts=[])
        self.assertEqual(view["channels"]["all"]["accepted"], 1)
        self.assertEqual(view["channels"]["all"]["bounced"], 0)
        self.assertEqual(view["channels"]["all"]["replied"], 1)
        other = metrics_view(OTHER_ENT, outbound_records=out, inbound_records=inb, accounts=[])
        self.assertEqual(other["channels"]["all"]["accepted"], 1)
        self.assertEqual(other["channels"]["all"]["bounced"], 1)
        self.assertEqual(other["channels"]["all"]["replied"], 1)

    def test_06_enterprise_id_required(self):
        with self.assertRaises(ValueError):
            metrics_view("", outbound_records=[], inbound_records=[], accounts=[])
        with self.assertRaises(ValueError):
            metrics_view("   ", outbound_records=[], inbound_records=[], accounts=[])

    # ── 3. 时区分日 / 区间 ─────────────────────────────
    def test_07_business_day_timezone_boundary(self):
        # 2026-09-14T17:30Z = 2026-09-15 01:30 (Asia/Shanghai)
        out = [outbound(resend_id="edge", provider_status="delivered",
                        created_at="2026-09-14T17:30:00+00:00")]
        sh = metrics_view(ENT, start="2026-09-15", end="2026-09-15", report_timezone="Asia/Shanghai",
                          outbound_records=out, inbound_records=[], accounts=[])
        self.assertEqual(sh["channels"]["all"]["accepted"], 1)
        sh_prev = metrics_view(ENT, start="2026-09-14", end="2026-09-14",
                               report_timezone="Asia/Shanghai",
                               outbound_records=out, inbound_records=[], accounts=[])
        self.assertEqual(sh_prev["channels"]["all"]["accepted"], 0)
        utc = metrics_view(ENT, start="2026-09-15", end="2026-09-15", report_timezone="UTC",
                           outbound_records=out, inbound_records=[], accounts=[])
        self.assertEqual(utc["channels"]["all"]["accepted"], 0)
        self.assertEqual(utc["report_timezone"], "UTC")

    def test_08_range_is_inclusive(self):
        out = [
            outbound(resend_id="d13", created_at="2026-09-12T20:00:00+00:00", provider_status="delivered"),
            outbound(resend_id="d14", created_at="2026-09-13T20:00:00+00:00", provider_status="delivered"),
            outbound(resend_id="d15", created_at="2026-09-14T20:00:00+00:00", provider_status="delivered"),
        ]
        view = metrics_view(ENT, start="2026-09-13", end="2026-09-14",
                            report_timezone="Asia/Shanghai",
                            outbound_records=out, inbound_records=[], accounts=[])
        # 三个时间戳在上海分别是 09-13 / 09-14 / 09-15
        self.assertEqual(view["channels"]["all"]["accepted"], 2)
        self.assertEqual(view["range"], {"start": "2026-09-13", "end": "2026-09-14"})

    def test_09_reply_business_day_uses_received_at(self):
        out = [outbound(resend_id="r", thread_id="t1", created_at="2026-09-14T02:00:00+00:00")]
        inb = [inbound(message_id="m1", in_reply_to="r",
                       received_at="2026-09-14T17:30:00+00:00")]  # → 09-15 上海
        d14 = metrics_view(ENT, start="2026-09-14", end="2026-09-14", report_timezone="Asia/Shanghai",
                           outbound_records=out, inbound_records=inb, accounts=[])
        self.assertEqual(d14["channels"]["all"]["replied"], 0)
        d15 = metrics_view(ENT, start="2026-09-15", end="2026-09-15", report_timezone="Asia/Shanghai",
                           outbound_records=out, inbound_records=inb, accounts=[])
        self.assertEqual(d15["channels"]["all"]["replied"], 1)
        # 发送在同期窗口外（09-14 02:00Z = 09-14 10:00 上海）
        self.assertEqual(d15["channels"]["all"]["accepted"], 0)

    # ── 4. 缺口 / 不造假数 ─────────────────────────────
    def test_10_legacy_unverified_excluded_and_reported(self):
        out = [outbound(resend_id=""),           # 无 Provider 受理 id
               outbound(resend_id="ok", provider_status="delivered")]
        view = metrics_view(ENT, outbound_records=out, inbound_records=[], accounts=[])
        self.assertEqual(view["channels"]["all"]["accepted"], 1)
        self.assertEqual(view["channels"]["all"]["legacy_unverified"], 1)
        self.assertEqual(view["status"], "partial")
        self.assertIn("legacy_unverified:1", view["reasons"])

    def test_11_unattributed_replies_counted_not_dropped(self):
        out = [outbound(resend_id="known", account_id=FD_ACCOUNT, thread_id="t-known")]
        inb = [
            inbound(message_id="m1", in_reply_to="known"),
            inbound(message_id="m2", sender="x@y.com"),          # 匹配不到原发件
        ]
        view = metrics_view(ENT, outbound_records=out, inbound_records=inb, accounts=[])
        self.assertEqual(view["channels"][CHANNEL_FOUNDER_DIRECT]["replied"], 1)
        self.assertEqual(view["channels"][CHANNEL_UNATTRIBUTED]["replied"], 1)
        self.assertEqual(view["channels"]["all"]["replied"], 2)
        self.assertIn("replies_unattributed:1", view["reasons"])
        self.assertEqual(view["gaps"]["counts"]["replies_unattributed"], 1)

    def test_12_unique_repliers_dedup_but_reply_count_kept(self):
        out = [outbound(resend_id="r1", account_id=FD_ACCOUNT)]
        inb = [
            inbound(message_id="m1", in_reply_to="r1", sender="same@buyer.com", contact_id="c1"),
            inbound(message_id="m2", in_reply_to="r1", sender="same@buyer.com", contact_id="c1"),
        ]
        view = metrics_view(ENT, outbound_records=out, inbound_records=inb, accounts=[])
        self.assertEqual(view["channels"][CHANNEL_FOUNDER_DIRECT]["replied"], 2)
        self.assertEqual(view["channels"][CHANNEL_FOUNDER_DIRECT]["unique_repliers"], 1)

    def test_13_duplicate_inbound_message_counted_once(self):
        out = [outbound(resend_id="r1")]
        inb = [inbound(message_id="dup", in_reply_to="r1"),
               inbound(message_id="dup", in_reply_to="r1")]
        view = metrics_view(ENT, outbound_records=out, inbound_records=inb, accounts=[])
        self.assertEqual(view["channels"]["all"]["replied"], 1)

    def test_14_source_unavailable_reports_unavailable_not_zero(self):
        class BoomStore:
            def list_outbound_records(self, company_id=None):
                raise RuntimeError("boom")

            def list_inbound_records(self, company_id=None):
                raise RuntimeError("boom")

        view = metrics_view(ENT, store=BoomStore())
        self.assertEqual(view["status"], "unavailable")
        self.assertTrue(any(r.startswith("source_unavailable") for r in view["reasons"]))
        self.assertIsNone(view["metrics"]["accepted"])
        self.assertIsNone(view["metrics"]["bounced"])
        self.assertIsNone(view["provider_health"]["bounce_rate"])
        self.assertIsNone(view["entitlement"]["quota_per_day"])

    # ── 5. 两套账 ──────────────────────────────────────
    def test_15_entitlement_matches_gate_count_sent_today(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = EmailStore(tmp)
            a1 = store.add_account(enterprise_id=ENT, owner_open_id="ou_one",
                                   email_address="v1@mail.dealclaw.io", provider="resend",
                                   secret_ref="s1", daily_send_limit=30)
            a2 = store.add_account(enterprise_id=ENT, owner_open_id="ou_one",
                                   email_address="v2@mail.dealclaw.io", provider="resend",
                                   secret_ref="s2", daily_send_limit=10)
            now = datetime.now(timezone.utc).isoformat()
            store.insert_message(outbound(resend_id="t1", account_id=a1["account_id"],
                                          created_at=now, company_id=ENT))
            store.insert_message(outbound(resend_id="t2", account_id=a1["account_id"],
                                          created_at=now, company_id=ENT))
            store.insert_message(outbound(resend_id="t3", account_id=a2["account_id"],
                                          created_at=now, company_id=ENT))

            view = metrics_view(ENT, store=store, tenant=None)
            ent = view["entitlement"]
            self.assertEqual(ent["quota_per_day"], 40)
            self.assertEqual(ent["sent_today"], 3)
            self.assertEqual(ent["remaining_today"], 37)
            self.assertIs(ent["exhausted"], False)
            self.assertEqual(ent["accounts_configured"], 2)
            self.assertEqual(ent["default_per_account_limit"], 30)
            # 与发送闸门用的 EmailStore.count_sent_today 同口径（逐账号对齐）
            for row in ent["accounts"]:
                self.assertEqual(row["sent_today"],
                                 store.count_sent_today(row["account_id"]))
                self.assertEqual(row["remaining_today"],
                                 row["daily_send_limit"] - row["sent_today"])
            # Provider 受理口径另列，不与权益口径混用
            self.assertEqual(ent["accepted_today"], 3)

    def test_16_entitlement_without_accounts_is_honest(self):
        view = metrics_view(ENT, outbound_records=[], inbound_records=[], accounts=[])
        ent = view["entitlement"]
        self.assertEqual(ent["quota_per_day"], 0)
        self.assertEqual(ent["reason"], "no_accounts_configured")
        self.assertIsNone(ent["exhausted"])
        self.assertEqual(ent["default_per_account_limit"], 30)
        unknown = metrics_view(ENT, store=type("S", (), {
            "list_outbound_records": lambda self, company_id=None: (_ for _ in ()).throw(RuntimeError("x")),
            "list_inbound_records": lambda self, company_id=None: [],
        })())
        self.assertEqual(unknown["status"], "unavailable")

    def test_17_provider_cost_ledger_is_empty_but_shaped(self):
        out = [outbound(resend_id="a", provider_status="delivered")]
        view = metrics_view(ENT, outbound_records=out, inbound_records=[], accounts=[])
        cost = view["provider_cost"]
        self.assertIs(cost["available"], False)
        self.assertEqual(cost["reason"], "no_provider_usage_source")
        for key in ("sends", "receives", "api_calls", "quota_consumed", "plan_limit",
                    "spend_amount", "spend_currency", "billing_period"):
            self.assertIsNone(cost["fields"][key], f"Provider 成本字段 {key} 应为空")
        self.assertEqual(cost["local_proxies"]["accepted_in_range"], 1)
        self.assertIn("不是 Provider 计费数字", cost["local_proxies"]["note"])

    # ── 6. 只读 / 渲染 / CLI ───────────────────────────
    def test_18_metrics_view_has_no_side_effects(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = EmailStore(tmp)
            acct = store.add_account(enterprise_id=ENT, owner_open_id="ou_one",
                                     email_address="v1@mail.dealclaw.io", provider="resend",
                                     secret_ref="s1")
            store.insert_message(outbound(resend_id="a", account_id=acct["account_id"],
                                          provider_status="delivered", company_id=ENT))
            before = self._tree_snapshot(Path(tmp))
            metrics_view(ENT, store=store)
            metrics_view(ENT, store=store, start="2026-01-01", end="2026-12-31")
            after = self._tree_snapshot(Path(tmp))
            self.assertEqual(before, after, "metrics_view 必须只读，不得新增/改动任何文件")

    def test_19_format_line_hides_uncollected(self):
        view = metrics_view(ENT, outbound_records=[outbound(resend_id="a",
                                                            provider_status="delivered")],
                            inbound_records=[], accounts=[])
        line = format_quality_line(view)
        self.assertIn("退信率", line)
        self.assertIn("投诉率", line)
        self.assertIn("未采集", line)

    def test_20_cli_email_quality(self):
        from email_gateway.cli import main
        with tempfile.TemporaryDirectory() as tmp:
            store = EmailStore(tmp)
            acct = store.add_account(enterprise_id=ENT, owner_open_id="ou_one",
                                     email_address="v1@mail.dealclaw.io", provider="resend",
                                     secret_ref="s1")
            store.insert_message(outbound(resend_id="a", account_id=acct["account_id"],
                                          provider_status="bounced", company_id=ENT))
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = main(["--data-dir", tmp, "email-quality", "--enterprise", ENT])
            self.assertEqual(code, 0)
            payload = json.loads(buf.getvalue())
            self.assertEqual(payload["channels"]["all"]["accepted"], 1)
            self.assertEqual(payload["channels"]["all"]["bounced"], 1)
            self.assertEqual(payload["provider_health"]["bounce_rate"], 1.0)

            buf2 = io.StringIO()
            with redirect_stdout(buf2):
                main(["--data-dir", tmp, "email-quality", "--enterprise", ENT, "--line"])
            self.assertIn("FD", buf2.getvalue())

            buf3 = io.StringIO()
            with redirect_stdout(buf3):
                main(["--data-dir", tmp, "email-quality", "--enterprise", ENT,
                      "--provider-cost"])
            self.assertIs(json.loads(buf3.getvalue())["available"], False)

    # ── 工具 ───────────────────────────────────────────
    @staticmethod
    def _tree_snapshot(root: Path) -> dict:
        snap = {}
        for path in sorted(root.rglob("*")):
            rel = str(path.relative_to(root))
            if path.is_dir():
                snap[rel] = "dir"
            else:
                st = path.stat()
                snap[rel] = (st.st_size, st.st_mtime_ns)
        return snap


if __name__ == "__main__":
    unittest.main()
