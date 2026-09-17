#!/usr/bin/env python3
"""test_daily_report_inbound_selfheal.py — 早晚报「出数前有界自愈」回归。

背景：Resend 入站此前不写事实层（已修：handle_inbound_event 落库），但补丁上线前漏掉的
回复、webhook 丢投、轮询游标越过的历史缺口不会自动回来。早晚报在出数前有界补一次：
只拉入站、限条数、短超时、失败不影响出数。

覆盖：
  ① 先补后算：collect_metrics 内部顺序 = pull → read（出数前完成自愈）
  ② 自愈失败/超时不影响日报出数（best-effort）
  ③ 开关 DC_DAILY_INBOUND_SELFHEAL=0 时不调用
  ④ 幂等：一天早晚两报重复跑不会重复计数
  ⑤ 租户闸门：查不到本租户绑定邮箱时**根本不拉**（共用 Resend 账号，不过滤就会串租户）

运行：
  cd work/mio-api && python3 -m unittest tests.test_daily_report_inbound_selfheal -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

COMPANY = "testco"
AGENT_EMAIL = "thia@mail.dealclaw.io"


def _now():
    return datetime.now(timezone.utc).isoformat()


class DailyReportSelfHealTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-selfheal-")
        os.environ["DC_DATA_DIR"] = self.tmp
        os.environ.pop("DC_DAILY_INBOUND_SELFHEAL", None)
        os.environ.pop("DC_DAILY_INBOUND_SELFHEAL_TIMEOUT", None)
        self.order = []

        # 自愈要拉共用 Resend 账号的收信，必须先有「本租户绑定邮箱」这个口径，
        # 否则闸门 fail-closed 直接不拉（见 test_selfheal_refuses_without_tenant_scope）
        from email_gateway.store import EmailStore
        EmailStore().add_account(
            enterprise_id=COMPANY, owner_open_id="ou_selfheal_owner",
            email_address=AGENT_EMAIL, provider="resend",
            secret_ref="env:RESEND_API_KEY", mailbox_kind="dealclaw_proxy")

        import dc_daily_report as dr
        import dc_resend_history as hist
        import email_metrics.service as svc

        self.dr, self.hist, self.svc = dr, hist, svc
        self._orig_pull, self._orig_read = hist.pull, svc.read_email_metrics

    def tearDown(self):
        self.hist.pull = self._orig_pull
        self.svc.read_email_metrics = self._orig_read
        for k in ("DC_DAILY_INBOUND_SELFHEAL", "DC_DAILY_INBOUND_SELFHEAL_TIMEOUT"):
            os.environ.pop(k, None)
        os.environ.pop("DC_DATA_DIR", None)

    # ── 假实现 ─────────────────────────────────────────────
    def _fake_pull_writes(self, *, direction="", limit=0, company_id="", **kw):
        self.order.append("pull")
        from email_gateway.store import EmailStore

        EmailStore().insert_message({
            "account_id": "ema_t1",
            "direction": "inbound",
            "message_id": "<heal1@buyer.example>",
            "resend_received_id": "rid-heal",
            "sender": "buyer@example.com",
            "recipients": [AGENT_EMAIL],
            "subject": "Re: hi",
            "text_preview": "ok收到，明天来",
            "received_at": _now(),
            "company_id": COMPANY,
            "related": True,
        })
        return {"ok": True, "written": 1, "sides": {"received": {"fetched": 1}}, "errors": []}

    def _fake_read(self, **kw):
        self.order.append("read")
        return {
            "metrics": {"sent": 1, "delivered": 1, "replied": 0, "bounced": 0},
            "status": "ok", "mode": "legacy", "range": None,
        }

    def _inbound_count(self):
        from email_gateway.store import EmailStore

        return len(EmailStore().list_inbound_records(COMPANY))

    # ── 用例 ───────────────────────────────────────────────
    def test_selfheal_runs_before_reading(self):
        self.hist.pull = self._fake_pull_writes
        self.svc.read_email_metrics = self._fake_read

        out = self.dr.collect_metrics(COMPANY)

        self.assertEqual(self.order, ["pull", "read"], "必须先补后算")
        self.assertEqual(self._inbound_count(), 1, "自愈应把入站写进事实层")
        self.assertEqual(out.get("status"), "ok")

    def test_selfheal_failure_does_not_break_report(self):
        def boom(**kw):
            self.order.append("pull")
            raise RuntimeError("resend down")

        self.hist.pull = boom
        self.svc.read_email_metrics = self._fake_read

        out = self.dr.collect_metrics(COMPANY)  # 不应抛异常

        self.assertIn("read", self.order)
        self.assertEqual(out.get("status"), "ok")

    def test_selfheal_timeout_does_not_block_report(self):
        def slow(**kw):
            self.order.append("pull")
            time.sleep(3)
            return {"ok": True, "written": 0, "sides": {}, "errors": []}

        os.environ["DC_DAILY_INBOUND_SELFHEAL_TIMEOUT"] = "1"
        self.hist.pull = slow
        self.svc.read_email_metrics = self._fake_read

        t0 = time.time()
        out = self.dr.collect_metrics(COMPANY)
        elapsed = time.time() - t0

        self.assertEqual(out.get("status"), "ok")
        self.assertLess(elapsed, 2.5, "超时后不得继续等待自愈")

    def test_selfheal_disabled_by_env(self):
        os.environ["DC_DAILY_INBOUND_SELFHEAL"] = "0"
        self.hist.pull = self._fake_pull_writes
        self.svc.read_email_metrics = self._fake_read

        self.dr.collect_metrics(COMPANY)

        self.assertEqual(self.order, ["read"], "关闭开关时不应回填")
        self.assertEqual(self._inbound_count(), 0)

    def test_selfheal_refuses_without_tenant_scope(self):
        """查不到本租户邮箱 → 一次 pull 都不许发（否则拉回来的是全平台的信）。"""
        empty = tempfile.mkdtemp(prefix="dc-selfheal-noscope-")
        os.environ["DC_DATA_DIR"] = empty
        self.hist.pull = self._fake_pull_writes
        self.svc.read_email_metrics = self._fake_read

        out = self.dr.collect_metrics(COMPANY)

        self.assertEqual(self.order, ["read"], "口径未知时不得拉取共用账号的收信")
        self.assertEqual(out.get("status"), "ok", "拒绝拉取不影响出数")

    def test_selfheal_is_idempotent(self):
        self.hist.pull = self._fake_pull_writes
        self.svc.read_email_metrics = self._fake_read

        self.dr.collect_metrics(COMPANY)   # 早报
        self.dr.collect_metrics(COMPANY)   # 晚报

        self.assertEqual(self.order.count("pull"), 2)
        self.assertEqual(self._inbound_count(), 1, "重复跑不得重复计数")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
