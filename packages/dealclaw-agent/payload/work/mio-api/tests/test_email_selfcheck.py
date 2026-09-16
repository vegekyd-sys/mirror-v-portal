"""邮件链自检（dc_email_selfcheck）测试。

覆盖：三条链的健康/降级判定、时间窗过滤、脏数据不崩、退出码语义。
跑法：
  cd <mio-api> && python3 -m unittest discover -s . -t . -p "test_email_selfcheck.py"
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

_MIO = Path(__file__).resolve().parents[1]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

import dc_email_selfcheck as sc  # noqa: E402


def _now_iso(delta_hours: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=delta_hours)).isoformat()


class _Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name)
        (self.data / "email-facts" / "outbound").mkdir(parents=True)
        (self.data / "email-facts" / "inbound").mkdir(parents=True)
        (self.data / "notifications").mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def add_outbound(self, *, account_id="ema_1", smtp_message_id="<m@x>", origin="oc_g",
                     when=0, sub="_ok", local_message_id="<l@x>"):
        d = self.data / "email-facts" / "outbound" / sub / "2026-09"
        d.mkdir(parents=True, exist_ok=True)
        rec = {"record_type": "outbound", "account_id": account_id, "sender": "a@b.com",
               "resend_id": "r1", "smtp_message_id": smtp_message_id,
               "local_message_id": local_message_id, "origin_notify_target": origin,
               "sent_at": _now_iso(when)}
        (d / f"{abs(hash(str(rec) + sub))}.md").write_text(json.dumps(rec) + "\n", encoding="utf-8")

    def add_inbound(self, *, binding_status="matched", failure_reason="", when=0):
        d = self.data / "email-facts" / "inbound" / "c1" / "2026-09"
        d.mkdir(parents=True, exist_ok=True)
        rec = {"record_type": "inbound", "binding_status": binding_status,
               "failure_reason": failure_reason, "received_at": _now_iso(when),
               "sender": "buyer@x.com"}
        (d / f"{abs(hash(str(rec)))}.md").write_text(json.dumps(rec) + "\n", encoding="utf-8")

    def add_notification(self, *, status="sent", error="", when=0):
        rec = {"notification_id": "n_1", "status": status, "last_error": error,
               "sent_at": _now_iso(when), "payload": {"title": "买家想报价"}}
        with (self.data / "notifications" / "sent.md").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")


class HealthyChain(_Base):
    def test_all_three_links_ok(self):
        self.add_outbound()
        self.add_inbound(binding_status="matched")
        self.add_notification()
        result = sc.run_selfcheck(self.data, hours=24)
        self.assertEqual(result["status"], sc.STATUS_OK)
        self.assertTrue(result["ok"])
        self.assertEqual(sc.EXIT_CODES[result["status"]], 0)


class DegradedChain(_Base):
    def test_outbound_without_account_is_degraded(self):
        self.add_outbound(account_id="")
        result = sc.run_selfcheck(self.data, hours=24)
        link = result["links"]["outbound_facts"]
        self.assertEqual(link["status"], sc.STATUS_DEGRADED)
        self.assertTrue(any("account_id" in p for p in link["problems"]))

    def test_outbound_without_any_message_id_is_degraded(self):
        """两种 Message-ID 全空 → 回信必然配不上 → 降级。"""
        self.add_outbound(smtp_message_id="", local_message_id="")
        link = sc.run_selfcheck(self.data, hours=24)["links"]["outbound_facts"]
        self.assertEqual(link["status"], sc.STATUS_DEGRADED)
        self.assertTrue(any("Message-ID" in p for p in link["problems"]))

    def test_all_replies_unmatched_is_degraded_with_reason(self):
        for _ in range(3):
            self.add_inbound(binding_status="unmatched", failure_reason="ambiguous_contact_match")
        link = sc.run_selfcheck(self.data, hours=24)["links"]["reply_match"]
        self.assertEqual(link["status"], sc.STATUS_DEGRADED)
        self.assertEqual(link["unmatched"], 3)
        self.assertEqual(link["unmatched_reasons"], {"ambiguous_contact_match": 3})

    def test_notification_failure_is_degraded_and_visible(self):
        self.add_notification(status="error", error="unknown account for channel openclaw-weixin")
        link = sc.run_selfcheck(self.data, hours=24)["links"]["notify_delivery"]
        self.assertEqual(link["status"], sc.STATUS_DEGRADED)
        self.assertEqual(link["failed"], 1)
        self.assertIn("openclaw-weixin", link["failed_samples"][0]["error"])

    def test_unmatched_outbound_dir_counts(self):
        self.add_outbound(sub="_unmatched")
        link = sc.run_selfcheck(self.data, hours=24)["links"]["outbound_facts"]
        self.assertEqual(link["unmatched_dir_count"], 1)
        self.assertEqual(link["status"], sc.STATUS_DEGRADED)


class HealOutboundAttribution(_Base):
    """自愈类 1：_unmatched/ 里能按发件地址认回账号的，补归属（默认只看不改）。"""

    def _add_account(self, addr="a@b.com"):
        sys.path.insert(0, str(_MIO))
        from email_gateway.store import EmailStore  # noqa: PLC0415

        return EmailStore(self.data).add_account(
            enterprise_id="test", owner_open_id="ou_x", email_address=addr,
            provider="resend", mailbox_kind="dealclaw_proxy", secret_ref="env:RESEND_API_KEY",
        )

    def test_dry_run_counts_without_changing_files(self):
        self._add_account()
        self.add_outbound(sub="_unmatched")
        heal = sc.heal_outbound_attribution(self.data, apply=False)
        self.assertEqual(heal["fixable"], 1)
        self.assertEqual(heal["fixed"], 0)
        self.assertTrue(list((self.data / "email-facts" / "outbound" / "_unmatched").rglob("*.md")))

    def test_apply_moves_and_is_idempotent(self):
        account = self._add_account()
        account_id = account["account_id"]
        self.add_outbound(sub="_unmatched")
        first = sc.heal_outbound_attribution(self.data, apply=True)
        self.assertEqual(first["fixed"], 1)
        moved = list((self.data / "email-facts" / "outbound" / account_id).rglob("*.md"))
        self.assertEqual(len(moved), 1)
        self.assertFalse(list((self.data / "email-facts" / "outbound" / "_unmatched").rglob("*.md")))
        second = sc.heal_outbound_attribution(self.data, apply=True)
        self.assertEqual((second["fixable"], second["fixed"]), (0, 0), "重复跑不得再动任何文件")
        self.assertTrue((self.data / "email-facts" / sc.FIX_LOG_NAME).exists(), "必须留痕可回滚")

    def test_unknown_sender_is_skipped_not_guessed(self):
        """发件地址不在本租户账号表里 → 不猜、不动（乱归属比不归属更糟）。"""
        self._add_account(addr="known@b.com")
        self.add_outbound(sub="_unmatched")  # sender=a@b.com，不在账号表
        heal = sc.heal_outbound_attribution(self.data, apply=True)
        self.assertEqual(heal["fixed"], 0)
        self.assertEqual(heal["skip_reasons"].get("no_account_for_sender"), 1)
        self.assertTrue(list((self.data / "email-facts" / "outbound" / "_unmatched").rglob("*.md")))


def _render_contains_heal():
    return None


class NeedsHumanClassification(_Base):
    def test_notify_failure_and_unmatched_reply_are_flagged_for_human(self):
        self.add_inbound(binding_status="unmatched", failure_reason="ambiguous")
        self.add_notification(status="error", error="unknown account")
        result = sc.run_selfcheck(self.data, hours=24)
        human = sc.needs_human(result)
        self.assertTrue(any("通知" in item for item in human))
        self.assertTrue(any("回信" in item for item in human))


class WindowingAndRobustness(_Base):
    def test_old_records_are_outside_window(self):
        self.add_inbound(binding_status="unmatched", failure_reason="old", when=-48)
        link = sc.run_selfcheck(self.data, hours=24)["links"]["reply_match"]
        self.assertEqual(link["total"], 0)
        self.assertEqual(link["status"], sc.STATUS_OK)

    def test_broken_json_line_does_not_crash(self):
        (self.data / "notifications" / "sent.md").write_text("not json\n{broken\n", encoding="utf-8")
        result = sc.run_selfcheck(self.data, hours=24)
        self.assertIn("status", result)

    def test_empty_data_dir_is_ok(self):
        result = sc.run_selfcheck(self.data, hours=1)
        self.assertEqual(result["status"], sc.STATUS_OK)
        self.assertTrue(result["ok"])

    def test_render_contains_link_names(self):
        text = sc.render(sc.run_selfcheck(self.data, hours=1))
        for name in ("outbound_facts", "reply_match", "notify_delivery"):
            self.assertIn(name, text)


if __name__ == "__main__":
    unittest.main()
