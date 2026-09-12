#!/usr/bin/env python3
"""test_domain_health.py — 域名收发体检（只读）回归测试

全部离线：DNS 用注入的 runner 假数据，不触网；账户/事实用临时目录。
覆盖：
  - MX 有/无/非典型入口 → 收信 ok/warning/broken
  - SPF/DKIM/DMARC 缺失 → warning + 理由（不能判成 broken，能发不等于不能收）
  - 账户收信通道：dealclaw_proxy → webhook、personal → imap；binding 透传
  - 最近 inbound 事实时间
  - webhook 未提供 → skipped（不误报成 error）
  - 汇总计数与退出语义

运行：cd work/mio-api && python3 -m unittest tests.test_domain_health -v
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dc_domain_health as ddh  # noqa: E402


def runner_for(answers: dict):
    """answers: {(domain, rrtype): [rows]}"""
    def _run(domain: str, rrtype: str):
        return answers.get((domain, rrtype), [])
    return _run


def good_answers(domain: str) -> dict:
    return {
        (domain, "MX"): ["10 inbound-smtp.us-east-1.amazonaws.com."],
        (domain, "TXT"): ["v=spf1 include:amazonses.com ~all"],
        (f"resend._domainkey.{domain}", "TXT"): ["p=MIGfMA0..."],
        (f"_dmarc.{domain}", "TXT"): ["v=DMARC1; p=none;"],
    }


class DomainCheckTest(unittest.TestCase):
    def test_full_health_is_ok(self):
        d = "ok.example.com"
        r = ddh.check_domain(d, runner=runner_for(good_answers(d)))
        self.assertEqual(r["verdict"], ddh.STATUS_OK)
        self.assertEqual(r["receiving"], ddh.STATUS_OK)
        self.assertEqual(r["reasons"], [])

    def test_missing_mx_is_broken(self):
        d = "nomx.example.com"
        r = ddh.check_domain(d, runner=runner_for({}))
        self.assertEqual(r["receiving"], ddh.STATUS_BROKEN)
        self.assertEqual(r["verdict"], ddh.STATUS_BROKEN)
        self.assertTrue(any("无 MX" in x for x in r["reasons"]))

    def test_atypical_mx_is_warning(self):
        d = "odd.example.com"
        answers = good_answers(d)
        answers[(d, "MX")] = ["10 mail.other-provider.net."]
        r = ddh.check_domain(d, runner=runner_for(answers))
        self.assertEqual(r["receiving"], ddh.STATUS_WARN)
        self.assertTrue(any("非典型收信入口" in x for x in r["reasons"]))

    def test_missing_spf_dmarc_is_warning_not_broken(self):
        d = "send.example.com"
        answers = good_answers(d)
        answers[(d, "TXT")] = []            # 无 SPF
        answers[(f"_dmarc.{d}", "TXT")] = []
        r = ddh.check_domain(d, runner=runner_for(answers))
        self.assertEqual(r["verdict"], ddh.STATUS_WARN)
        self.assertEqual(r["receiving"], ddh.STATUS_OK)   # 能收
        self.assertTrue(any("SPF" in x for x in r["reasons"]))
        self.assertTrue(any("DMARC" in x for x in r["reasons"]))

    def test_missing_dkim_marks_sending_broken(self):
        d = "nokey.example.com"
        answers = good_answers(d)
        answers[(f"resend._domainkey.{d}", "TXT")] = []
        r = ddh.check_domain(d, runner=runner_for(answers))
        self.assertEqual(r["sending"], ddh.STATUS_BROKEN)


class AccountsTest(unittest.TestCase):
    def _fixture(self):
        tmp = Path(tempfile.mkdtemp(prefix="dc-domain-health-"))
        facts = tmp / "email-facts"
        (facts / "accounts").mkdir(parents=True)
        (facts / "bindings").mkdir(parents=True)
        (facts / "inbound" / "100000834234" / "2026-09").mkdir(parents=True)
        (facts / "accounts" / "ema_proxy.md").write_text(
            '# rec\n{"account_id":"ema_proxy","enterprise_id":"acme","provider":"resend",'
            '"mailbox_kind":"dealclaw_proxy","enabled":1}\n', encoding="utf-8")
        (facts / "accounts" / "ema_imap.md").write_text(
            '# rec\n{"account_id":"ema_imap","enterprise_id":"acme","provider":"netease_163",'
            '"mailbox_kind":"personal","enabled":1}\n', encoding="utf-8")
        (facts / "bindings" / "emb_1.md").write_text(
            '# rec\n{"binding_id":"emb_1","account_id":"ema_proxy",'
            '"inbound_filter":"dealclaw_replies","notify_enabled":1}\n', encoding="utf-8")
        (facts / "inbound" / "100000834234" / "2026-09" / "x.md").write_text(
            '# rec\n{"company_id":"100000834234","received_at":"2026-09-12T10:00:00+00:00"}\n',
            encoding="utf-8")
        return tmp

    def test_inbound_channel_by_mailbox_kind(self):
        accs = {a["account_id"]: a for a in ddh.load_accounts(self._fixture())}
        self.assertEqual(accs["ema_proxy"]["inbound_channel"], "webhook")
        self.assertEqual(accs["ema_imap"]["inbound_channel"], "imap")
        self.assertEqual(accs["ema_proxy"]["bindings"][0]["inbound_filter"], "dealclaw_replies")

    def test_last_inbound_at(self):
        self.assertEqual(ddh.last_inbound_at(self._fixture(), "100000834234"),
                         "2026-09-12T10:00:00+00:00")
        self.assertEqual(ddh.last_inbound_at(self._fixture(), "999"), "")

    def test_webhook_skipped_when_not_provided(self):
        w = ddh.check_webhook(None)
        self.assertFalse(w["checked"])
        self.assertEqual(w["status"], "skipped")


class RunChecksTest(unittest.TestCase):
    def test_summary_counts(self):
        d_ok, d_bad = "ok.example.com", "nomx.example.com"
        answers = good_answers(d_ok)   # d_bad 全空
        report = ddh.run_checks([d_ok, d_bad], runner=runner_for(answers))
        self.assertEqual(report["summary"]["ok"], 1)
        self.assertEqual(report["summary"]["broken"], 1)
        self.assertTrue(report["read_only"])
        self.assertFalse(report["sends_mail"])

    def test_render_text_smoke(self):
        d = "ok.example.com"
        text = ddh.render_text(ddh.run_checks([d], runner=runner_for(good_answers(d))))
        self.assertIn("域名收发体检", text)
        self.assertIn(d, text)

    def test_json_serializable(self):
        d = "ok.example.com"
        json.dumps(ddh.run_checks([d], runner=runner_for(good_answers(d))), ensure_ascii=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
