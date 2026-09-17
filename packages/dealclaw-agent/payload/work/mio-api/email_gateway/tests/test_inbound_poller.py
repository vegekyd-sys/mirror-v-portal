"""入站取信管子测试：游标语义、只通知归属成功的、异常不推进游标。"""

import json
import sys
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway import inbound_poller as ip  # noqa: E402


def item(rid, created="2026-09-15T03:00:00Z", sender="buyer@x.com", to_addr="bambu-lab@mail.dealclaw.io"):
    return {"id": rid, "created_at": created, "from": sender, "to": [to_addr], "subject": "Re: hi"}


class FakeDeps:
    def __init__(self, items, ingest_results=None, cursor=None, list_status=200, deliver_ok=True):
        self.items = items
        self.ingest_results = ingest_results or {}
        self.cursor = cursor or {}
        self.list_status = list_status
        self.deliver_ok = deliver_ok
        self.ingested = []
        self.notified = []
        self.saved = []

    def deps(self):
        return {
            "list_received": lambda limit=50: (self.list_status, {"data": self.items}),
            "load_cursor": lambda: dict(self.cursor),
            "save_cursor": lambda hw, created, processed: self.saved.append((hw, created, processed)),
            "to_ingest_event": lambda it: {"event_type": "email.received",
                                           "payload": {"email_id": it["id"], "from": it["from"],
                                                       "to": it["to"], "subject": it["subject"]}},
            "ingest": self._ingest,
            "deliver": self._deliver,
        }

    def _ingest(self, event):
        rid = event["payload"]["email_id"]
        self.ingested.append(rid)
        return self.ingest_results.get(rid, {"ok": True, "matched": True})

    def _deliver(self, binding, *, text):
        self.notified.append({"binding": binding, "text": text})
        return {"ok": self.deliver_ok, "channel": "app_bot"}


class FakeStore:
    def __init__(self, accounts=None, bindings=None):
        self._accounts = accounts if accounts is not None else [
            {"account_id": "ema_1", "email": "bambu-lab@mail.dealclaw.io"}]
        self._bindings = bindings if bindings is not None else [
            {"account_id": "ema_1", "notify_enabled": 1, "chat_id": "ou_me"}]

    def list_accounts(self):
        return self._accounts

    def list_bindings(self):
        return self._bindings


class BaselineTests(unittest.TestCase):
    def test_baseline_saves_high_water_and_ingests_nothing(self):
        f = FakeDeps([item("r3"), item("r2"), item("r1")])
        r = ip.poll_once(baseline=True, deps=f.deps(), store=FakeStore())
        self.assertEqual(r["mode"], "baseline")
        self.assertEqual(r["baseline_id"], "r3")
        self.assertEqual(f.ingested, [])
        self.assertEqual(f.saved[0][0], "r3")
        self.assertTrue(r["cursor_advanced"])

    def test_baseline_dry_run_does_not_save(self):
        f = FakeDeps([item("r3")])
        r = ip.poll_once(baseline=True, dry_run=True, deps=f.deps(), store=FakeStore())
        self.assertEqual(f.saved, [])
        self.assertFalse(r["cursor_advanced"])


class PollTests(unittest.TestCase):
    def test_only_processes_items_after_high_water(self):
        f = FakeDeps([item("r3"), item("r2"), item("r1")], cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertEqual(f.ingested, ["r3"])
        self.assertEqual(r["considered"], 1)
        self.assertEqual(r["ingested"], 1)

    def test_matched_reply_notifies_user_dm(self):
        f = FakeDeps([item("r3")], cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(notify=True, deps=f.deps(), store=FakeStore())
        self.assertEqual(r["matched"], 1)
        self.assertEqual(r["notified"], 1)
        self.assertEqual(f.notified[0]["binding"]["chat_id"], "ou_me")
        self.assertIn("解读", f.notified[0]["text"])
        self.assertIn("建议下一步", f.notified[0]["text"])

    def test_ingest_unmatched_but_mailbox_attributable_is_collected(self):
        """新语义（2026-09-15）：ingest 未匹配，但能按收件箱归属 → 仍算归属成功。

        背景：实测 Resend 详情接口可能不给 In-Reply-To，只靠头部精确匹配会“拉到了却认不出”。
        因此归属改为双口径：收件箱优先，In-Reply-To 仅作精修。
        """
        f = FakeDeps([item("r3")], ingest_results={"r3": {"ok": True, "matched": False}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertEqual(r["unmatched"], 0)
        self.assertEqual(r["matched"], 1)
        self.assertEqual(len(r["replies"]), 1)
        self.assertEqual(r["replies"][0]["attribution"]["method"], "recipient")
        self.assertEqual(f.notified, [])   # 默认不通知机器人

    def test_truly_unattributable_reply_is_counted_not_collected(self):
        """收件箱也认不出时，才计为未归属且不收集（不能乱挂接）。"""
        f = FakeDeps([item("r3")], ingest_results={"r3": {"ok": True, "matched": False}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore(accounts=[]))
        self.assertEqual(r["unmatched"], 1)
        self.assertEqual(r["replies"], [])

    def test_duplicate_fact_is_skipped(self):
        f = FakeDeps([item("r3")], ingest_results={"r3": {"ok": True, "duplicate_fact": True}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertEqual(r["skipped"], 1)
        self.assertEqual(r["ingested"], 0)

    def test_ingest_failure_does_not_advance_cursor(self):
        f = FakeDeps([item("r3")], ingest_results={"r3": {"ok": False, "status": "retryable"}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertFalse(r["cursor_advanced"])
        self.assertEqual(f.saved, [])
        self.assertTrue(r["errors"])

    def test_no_notify_when_binding_missing(self):
        f = FakeDeps([item("r3")], cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(notify=True, deps=f.deps(), store=FakeStore(bindings=[]))
        self.assertEqual(r["notified"], 0)
        self.assertTrue(any("notify skipped" in e for e in r["errors"]))

    def test_collect_returns_reply_facts_for_agent(self):
        f = FakeDeps([item("r3")],
                     ingest_results={"r3": {"ok": True, "matched": True,
                                            "text_preview": "Please send your catalog",
                                            "signals": [{"signal_type": "quote_request",
                                                         "evidence": "need price"}]}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertEqual(f.notified, [])          # 不推给任何机器人
        self.assertEqual(len(r["replies"]), 1)
        rep = r["replies"][0]
        self.assertEqual(rep["from"], "buyer@x.com")
        self.assertEqual(rep["excerpt"], "Please send your catalog")
        self.assertEqual(rep["signals"][0]["type"], "quote_request")
        self.assertTrue(rep["thread_matched"])

    def test_unmatched_reply_not_collected(self):
        f = FakeDeps([item("r3")], ingest_results={"r3": {"ok": True, "matched": False}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore(accounts=[]))
        self.assertEqual(r["replies"], [])

    def test_notify_disabled_by_flag(self):
        f = FakeDeps([item("r3")], cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(notify=False, deps=f.deps(), store=FakeStore())
        self.assertEqual(f.notified, [])
        self.assertEqual(r["notified"], 0)

    def test_dry_run_does_not_save_or_notify(self):
        f = FakeDeps([item("r3")], cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(dry_run=True, deps=f.deps(), store=FakeStore())
        self.assertEqual(f.saved, [])
        self.assertEqual(f.notified, [])

    def test_list_failure_is_reported(self):
        f = FakeDeps([], list_status=500)
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertFalse(r["ok"])
        self.assertTrue(r["errors"])

    def test_empty_inbox_is_ok(self):
        f = FakeDeps([])
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertTrue(r["ok"])
        self.assertEqual(r["pulled"], 0)

    def test_cursor_advances_to_newest_after_success(self):
        f = FakeDeps([item("r3"), item("r2")], cursor={"high_water_received_id": "r1"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertTrue(r["cursor_advanced"])
        self.assertEqual(r["advanced_to"], "r3")
        self.assertEqual(sorted(f.ingested), ["r2", "r3"])


class ScanDeps:
    """可注入时钟 / 翻页 / 断点状态的假依赖（2026-09-17 超时与断点用）。"""

    def __init__(self, pages, cursor=None, scan=None, ingest_results=None,
                 step=5.0, clock=None):
        self.pages = pages                 # {after or "": (items, has_more)}
        self.cursor = dict(cursor or {})
        self.scan = dict(scan or {})
        self.ingest_results = ingest_results or {}
        self.step = step
        self._clock = clock
        self._now = 0.0
        self.ingested = []
        self.saved = []
        self.saved_scan = []
        self.requests = []

    def monotonic(self):
        if self._clock:
            return self._clock()
        val = self._now
        self._now += self.step
        return val

    def _list(self, limit=50, after=None):
        key = after or ""
        self.requests.append(key)
        items, has_more = self.pages.get(key, ([], False))
        return 200, {"data": list(items), "has_more": has_more}

    def _ingest(self, event):
        rid = event["payload"]["email_id"]
        self.ingested.append(rid)
        return self.ingest_results.get(rid, {"ok": True, "matched": True})

    def _save_cursor(self, hw, created, processed):
        self.saved.append((hw, created, list(processed)))
        self.cursor["high_water_received_id"] = hw
        self.cursor["recent_processed_ids"] = list(processed)

    def _save_scan(self, state):
        self.saved_scan.append(dict(state))
        self.scan.clear()
        self.scan.update(state)

    def deps(self):
        return {
            "list_received": self._list,
            "load_cursor": lambda: dict(self.cursor),
            "save_cursor": self._save_cursor,
            "to_ingest_event": lambda it: {"payload": {"email_id": it["id"], "from": it["from"],
                                                       "to": it["to"], "subject": it["subject"]}},
            "ingest": self._ingest,
            "deliver": lambda binding, *, text: {"ok": True, "channel": "app_bot"},
            "load_scan": lambda: dict(self.scan),
            "save_scan": self._save_scan,
            "monotonic": self.monotonic,
        }


class BudgetTests(unittest.TestCase):
    """墙钟预算：到点收手，但已做的不能白做（田耕郡 2026-09-17 报的 timeout）。"""

    def test_deadline_stops_round_and_keeps_progress(self):
        items = [item("r4"), item("r3"), item("r2"), item("r1")]
        f = ScanDeps({"": (items, False)}, cursor={})
        r = ip.poll_once(deps=f.deps(), store=FakeStore(), timeout_seconds=15)
        # 时钟 5s 一跳：第 2 次预算判定（t=15）就过期 → 只做旧→新里的第一封
        self.assertEqual(r["stopped_reason"], "deadline")
        self.assertTrue(r["partial"])
        self.assertEqual(f.ingested, ["r1"])
        self.assertFalse(r["cursor_advanced"])          # 没做完绝不前移高水位
        self.assertEqual(f.saved[-1][0], "")            # 高水位保持空
        self.assertIn("r1", f.saved[-1][2])             # 但处理进度落盘了
        self.assertEqual(r["ingested"], 1)

    def test_next_round_resumes_where_it_stopped(self):
        items = [item("r4"), item("r3"), item("r2"), item("r1")]
        f = ScanDeps({"": (items, False)},
                     cursor={"high_water_received_id": "", "recent_processed_ids": ["r1"]})
        r = ip.poll_once(deps=f.deps(), store=FakeStore(), timeout_seconds=600)
        self.assertEqual(f.ingested, ["r2", "r3", "r4"])   # 旧 → 新，跳过已做的
        self.assertEqual(r["skipped"], 1)
        self.assertTrue(r["cursor_advanced"])
        self.assertEqual(r["advanced_to"], "r4")

    def test_zero_budget_means_no_limit(self):
        f = ScanDeps({"": ([item("r2"), item("r1")], False)}, cursor={})
        r = ip.poll_once(deps=f.deps(), store=FakeStore(), timeout_seconds=0)
        self.assertEqual(r["stopped_reason"], "complete")
        self.assertFalse(r["partial"])

    def test_hard_stop_payload_is_valid_json(self):
        payload = json.loads(ip._hard_stop_json("hard_timeout"))
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["partial"])
        self.assertEqual(payload["stopped_reason"], "hard_timeout")
        self.assertEqual(payload["replies"], [])


class PaginationTests(unittest.TestCase):
    """新信多到一页装不下：反向翻页 + 翻页断点（原来 max_pages 是死参数，只取第一页会丢信）。"""

    def _pages(self):
        return {"": ([item("r4"), item("r3")], True),
                "r3": ([item("r2"), item("r1")], False)}

    def test_walks_back_until_history_end(self):
        f = ScanDeps(self._pages(), cursor={})
        r = ip.poll_once(deps=f.deps(), store=FakeStore(), timeout_seconds=600, limit=2, max_pages=4)
        self.assertEqual(f.requests, ["", "r3"])
        self.assertEqual(f.ingested, ["r1", "r2", "r3", "r4"])   # 旧 → 新
        self.assertEqual(r["advanced_to"], "r4")
        self.assertTrue(r["scan_exhausted"])
        self.assertEqual(f.saved_scan[-1], {})                      # 扫完了就清断点

    def test_unfinished_scan_keeps_high_water_and_resumes(self):
        f1 = ScanDeps(self._pages(), cursor={})
        r1 = ip.poll_once(deps=f1.deps(), store=FakeStore(), timeout_seconds=600, limit=2, max_pages=1)
        self.assertFalse(f1.saved_scan[-1].get("exhausted", False))
        self.assertEqual(f1.saved_scan[-1], {"scan_after": "r3", "scan_newest": "r4"})
        self.assertTrue(r1["scan_in_progress"])
        self.assertFalse(r1["cursor_advanced"])                     # 还有更旧的新信没看 → 不前移
        self.assertEqual(f1.ingested, ["r3", "r4"])

        # 下一轮：带看断点接着往回翻
        f2 = ScanDeps(self._pages(), cursor=f1.cursor, scan=f1.scan)
        r2 = ip.poll_once(deps=f2.deps(), store=FakeStore(), timeout_seconds=600, limit=2, max_pages=2)
        self.assertEqual(f2.requests, ["r3"])
        self.assertEqual(f2.ingested, ["r1", "r2"])
        self.assertEqual(r2["advanced_to"], "r4")                  # 扫完才把高水位推到扫描顶端
        self.assertEqual(f2.saved_scan[-1], {})


if __name__ == "__main__":
    unittest.main()
