#!/usr/bin/env python3
"""test_resend_attachment_ondemand.py — 附件「现拉」入口（用户 / 大模型要附件时用）。

口径：提醒卡片只报「有附件」，卡片里不带文件也不带邮件 id；用户问附件、或大模型要读
附件时，必须能按 message_id 或「最近一封带附件的入站」把字节拉下来 + 落盘 + 写索引。
首拉漏了（详情没带 attachments / 下载失败）也要能补上。

运行：cd work/mio-api && python3 -m unittest tests.test_resend_attachment_ondemand -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import dc_resend_attachments as att  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\nFAKE-IMAGE-BYTES"


class _FakeResp:
    def __init__(self, body: bytes):
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class OnDemandPullTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-att-ondemand-")
        os.environ["DC_DATA_DIR"] = self.tmp
        os.environ["RESEND_API_KEY_READ"] = "test-key"
        self._real_api = att._api
        self._real_urlopen = att.urllib.request.urlopen
        att.urllib.request.urlopen = lambda req, timeout=0: _FakeResp(PNG)

    def tearDown(self):
        att._api = self._real_api
        att.urllib.request.urlopen = self._real_urlopen
        os.environ.pop("RESEND_API_KEY_READ", None)
        os.environ.pop("RESEND_API_KEY", None)

    def _patch_detail(self, mid: str, attachments: list):
        """一条附件的最小可用桩：详情 + 附件元数据（带可下载 url）。"""
        def fake(path, timeout=30):
            if path == f"/emails/receiving/{mid}":
                return {"id": mid, "subject": "quote", "attachments": attachments}
            return {"filename": "logo.png", "content_type": "image/png",
                    "size": len(PNG), "download_url": "https://cdn.example/logo.png"}
        att._api = fake

    def test_pull_message_lands_bytes_and_writes_index(self):
        mid = "<mid-1>"
        self._patch_detail(mid, [{"id": "a1", "filename": "logo.png"}])
        r = att.pull_message(company_id="testco", message_id=mid)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["count"], 1)
        self.assertEqual(r["stored"], 1)
        path = Path(r["rows"][0]["path"])
        self.assertTrue(path.is_file(), "附件必须真落盘")
        self.assertEqual(path.read_bytes(), PNG)
        idx = list(Path(self.tmp).rglob("_index.jsonl"))
        self.assertEqual(len(idx), 1, "应写一份 _index.jsonl")
        self.assertIn("logo.png", idx[0].read_text(encoding="utf-8"))

    def test_pull_message_is_idempotent(self):
        mid = "<mid-2>"
        self._patch_detail(mid, [{"id": "a1", "filename": "logo.png"}])
        att.pull_message(company_id="testco", message_id=mid)
        second = att.pull_message(company_id="testco", message_id=mid)
        self.assertEqual(second["stored"], 1)
        idx = list(Path(self.tmp).rglob("_index.jsonl"))[0]
        lines = [ln for ln in idx.read_text(encoding="utf-8").splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, "同一附件不得在索引里重复")

    def test_message_without_attachments(self):
        self._patch_detail("<mid-3>", [])
        r = att.pull_message(company_id="testco", message_id="<mid-3>")
        self.assertTrue(r["ok"])
        self.assertEqual(r["count"], 0)
        self.assertIn("没有附件", r["note"])

    def test_detail_failure_is_structured_not_raising(self):
        def boom(path, timeout=30):
            raise RuntimeError("resend 502")
        att._api = boom
        r = att.pull_message(company_id="testco", message_id="<mid-4>")
        self.assertFalse(r["ok"])
        self.assertIn("detail:", r["error"])

    def test_pull_latest_skips_messages_without_attachments(self):
        def fake(path, timeout=30):
            if path.startswith("/emails/receiving?limit"):
                return {"data": [{"id": "m-new"}, {"id": "m-mid"}, {"id": "m-old"}]}
            if path == "/emails/receiving/m-new":
                return {"id": "m-new", "attachments": []}
            if path == "/emails/receiving/m-mid":
                return {"id": "m-mid", "attachments": [{"id": "a9", "filename": "logo.png"}]}
            if path == "/emails/receiving/m-mid/attachments/a9":
                return {"filename": "logo.png", "content_type": "image/png",
                        "download_url": "https://cdn.example/logo.png"}
            return {}
        att._api = fake
        r = att.pull_latest(company_id="testco", scan=10)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["message_id"], "m-mid")
        self.assertEqual(r["count"], 1)
        self.assertEqual(r["scanned"], 2, "应回看了 2 封才命中")

    def test_pull_latest_reports_none(self):
        def fake(path, timeout=30):
            if path.startswith("/emails/receiving?limit"):
                return {"data": [{"id": "m1"}]}
            return {"id": "m1", "attachments": []}
        att._api = fake
        r = att.pull_latest(company_id="testco", scan=5)
        self.assertTrue(r["ok"])
        self.assertEqual(r["count"], 0)
        self.assertIn("没有带附件", r["note"])

    def test_missing_key_is_structured(self):
        os.environ.pop("RESEND_API_KEY_READ", None)
        os.environ.pop("RESEND_API_KEY", None)
        r = att.pull_message(company_id="testco", message_id="<mid-5>")
        self.assertFalse(r["ok"])
        self.assertIn("RESEND_API_KEY", r["error"])

    def test_find_empty_gives_pull_hint(self):
        att._api = self._real_api
        r = att.find(company_id="testco")
        self.assertEqual(r["count"], 0)
        self.assertIn("--pull", r.get("hint", ""), "查不到时应提示现拉入口")


if __name__ == "__main__":
    unittest.main()
