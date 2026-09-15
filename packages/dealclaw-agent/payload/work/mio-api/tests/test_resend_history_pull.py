"""dc_resend_history 回归：并发取详情、写入计数（written/skipped/failed）、429 退避。

背景：全量回拉时"每封一次详情调用"是瓶颈（实测 0.42s/封 ⇒ 1.6 万封约 2.5 小时）。
加并发不能改变语义：顺序必须保持、写库仍单线程、限流只允许变慢不允许丢数据。
"""

import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

_MIO = Path(__file__).resolve().parents[1]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

import dc_resend_history as rh  # noqa: E402


class FetchDetailsTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def fake_detail(direction, key, eid):
            self.calls.append(eid)
            return {"id": eid, "text": f"body-{eid}"}

        self._patch = mock.patch.object(rh, "detail", side_effect=fake_detail)
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def test_sequential_preserves_order(self):
        items = [{"id": f"e{i}"} for i in range(25)]
        out = rh.fetch_details("sent", "k", items, workers=1)
        self.assertEqual([d["id"] for d in out], [f"e{i}" for i in range(25)])

    def test_concurrent_preserves_order(self):
        items = [{"id": f"e{i}"} for i in range(25)]
        out = rh.fetch_details("sent", "k", items, workers=4)
        self.assertEqual([d["id"] for d in out], [f"e{i}" for i in range(25)])
        self.assertEqual(len(self.calls), 25)

    def test_missing_id_does_not_crash(self):
        out = rh.fetch_details("sent", "k", [{"id": ""}, {"id": "e1"}], workers=4)
        self.assertEqual(len(out), 2)


class PullCountingTests(unittest.TestCase):
    def _pull(self, items, written_flags, **kw):
        store = mock.Mock()

        def insert(fact):
            return written_flags.pop(0)

        store.insert_message.side_effect = insert
        with mock.patch.object(rh, "list_side", return_value=items), \
             mock.patch.object(rh, "detail", return_value={"text": "b"}), \
             mock.patch.object(rh, "to_fact", side_effect=lambda it, det, side, cid: {"id": it["id"]}), \
             mock.patch("email_gateway.store.MarkdownEmailStore", return_value=store):
            return rh.pull(direction="sent", limit=1000, company_id="", key="k", **kw)

    def test_counts_written_and_skipped(self):
        items = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
        r = self._pull(items, [True, False, True], all_tenants=True)
        self.assertEqual(r["sides"]["sent"],
                         {"fetched": 3, "existing": 0, "written": 2,
                          "skipped": 1, "failed": 0})
        self.assertEqual(r["written"], 2)

    def test_known_ids_are_skipped_without_refetching(self):
        """已落库的邮件不能再去拉详情（回拉预算要花在新增上，且要能收敛）。"""
        items = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
        store = mock.Mock()
        store.insert_message.side_effect = [True]
        with mock.patch.object(rh, "list_side", return_value=items), \
             mock.patch.object(rh, "known_source_ids", return_value={"a", "b"}), \
             mock.patch.object(rh, "fetch_details") as fd, \
             mock.patch.object(rh, "to_fact", side_effect=lambda it, det, side, cid: {"id": it["id"]}), \
             mock.patch("email_gateway.store.MarkdownEmailStore", return_value=store):
            fd.return_value = [{"id": "c", "text": "b"}]
            r = rh.pull(direction="sent", key="k", all_tenants=True, concurrency=4)
        self.assertEqual(r["sides"]["sent"]["existing"], 2)
        self.assertEqual(r["sides"]["sent"]["written"], 1)
        self.assertEqual([i["id"] for i in fd.call_args[0][2]], ["c"])

    def test_chunked_writes_are_flushed_per_chunk(self):
        """分块：块内取完详情立即写盘，进程被打断时已完成的块不白做。"""
        items = [{"id": f"e{i}"} for i in range(5)]
        store = mock.Mock()
        store.insert_message.return_value = True
        seen_chunks = []

        def fake_fetch(direction, key, chunk, workers=1):
            seen_chunks.append([i["id"] for i in chunk])
            return [{"id": i["id"]} for i in chunk]

        with mock.patch.object(rh, "list_side", return_value=items), \
             mock.patch.object(rh, "known_source_ids", return_value=set()), \
             mock.patch.object(rh, "fetch_details", side_effect=fake_fetch), \
             mock.patch.object(rh, "to_fact", side_effect=lambda it, det, side, cid: {"id": it["id"]}), \
             mock.patch("email_gateway.store.MarkdownEmailStore", return_value=store):
            r = rh.pull(direction="sent", key="k", all_tenants=True, chunk_size=2)
        self.assertEqual(seen_chunks, [["e0", "e1"], ["e2", "e3"], ["e4"]])
        self.assertEqual(r["sides"]["sent"]["written"], 5)

    def test_insert_failure_is_counted_not_raised(self):
        store = mock.Mock()
        store.insert_message.side_effect = [True, RuntimeError("boom")]
        with mock.patch.object(rh, "list_side", return_value=[{"id": "a"}, {"id": "b"}]), \
             mock.patch.object(rh, "detail", return_value={}), \
             mock.patch.object(rh, "to_fact", side_effect=lambda it, det, side, cid: {"id": it["id"]}), \
             mock.patch("email_gateway.store.MarkdownEmailStore", return_value=store):
            r = rh.pull(direction="sent", key="k", all_tenants=True)
        self.assertEqual(r["sides"]["sent"]["failed"], 1)
        self.assertEqual(r["sides"]["sent"]["written"], 1)
        self.assertTrue(r["errors"])

    def test_dry_run_writes_nothing(self):
        items = [{"id": "a"}, {"id": "b"}]
        r = self._pull(items, [], dry_run=True, all_tenants=True)
        self.assertEqual(r["sides"]["sent"]["written"], 0)
        self.assertFalse(r["dry_run"] is None)


class RateLimitBackoffTests(unittest.TestCase):
    def test_retries_then_succeeds(self):
        err = urllib.error.HTTPError("u", 429, "too many", {"Retry-After": "0"}, None)
        responses = [err, mock.MagicMock()]

        def opener(_req, timeout=0):
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            ctx = mock.MagicMock()
            ctx.__enter__ = lambda s: mock.MagicMock(read=lambda: b'{"ok":1}')
            ctx.__exit__ = lambda s, *a: False
            return ctx

        with mock.patch.object(rh.urllib.request, "urlopen", side_effect=opener), \
             mock.patch.object(rh.time, "sleep") as slept:
            out = rh._get("/emails", "k")
        self.assertEqual(out, {"ok": 1})
        self.assertTrue(slept.called)

    def test_gives_up_after_attempts(self):
        def opener(_req, timeout=0):
            raise urllib.error.HTTPError("u", 429, "too many", {}, None)

        with mock.patch.object(rh.urllib.request, "urlopen", side_effect=opener), \
             mock.patch.object(rh.time, "sleep"):
            with self.assertRaises(RuntimeError):
                rh._get("/emails", "k", attempts=3)

    def test_403_still_means_no_read_permission(self):
        def opener(_req, timeout=0):
            raise urllib.error.HTTPError("u", 403, "forbidden", {}, None)

        with mock.patch.object(rh.urllib.request, "urlopen", side_effect=opener):
            with self.assertRaises(PermissionError):
                rh._get("/emails", "k")


if __name__ == "__main__":
    unittest.main()
