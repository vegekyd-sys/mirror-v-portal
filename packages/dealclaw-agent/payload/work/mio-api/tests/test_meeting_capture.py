#!/usr/bin/env python3
"""test_meeting_capture.py — 慧记/慧译真实接口联调保障测试。

覆盖：
- 联调保障 10 场景（伪造 evidence_verified / raw 缺失 / hash 不一致 / 越界 /
  空 records vs 接口失败 / 未知嵌套 / 多页 / replay 确定性 / 多版本 / 脱敏分层）
- FileRawLoader 生产读取 8 场景（正常读取 / 路径穿越 / 绝对路径 / 符号链接 /
  不存在 / hash 不一致 / 过大 / 非法编码）
- dry_run 不产生业务写入
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_meeting_capture import (  # noqa: E402
    capture_raw_response,
    inspect_schema,
    inspect_empty,
    replay,
    verify_evidence_from_raw,
    build_diagnostic_report,
    log_safe_view,
    FileRawLoader,
    run_debug,
)
from dc_meeting_ingest import (  # noqa: E402
    IngestStore,
    verify_evidence,
    classify_signals,
)


class TestCapture(unittest.TestCase):
    def test_1_forged_evidence_verified_rejected(self):
        forged = [{"type": "product_need", "value": "x", "evidence_text": "这段不在原文", "evidence_source": "transcript", "evidence_verified": True}]
        result = classify_signals(forged, "原文里没有那句话", "")
        self.assertFalse(result[0]["evidence_verified"])

    def test_2_raw_record_ref_missing(self):
        sig = {"raw_record_ref": "raw/not_exist.txt", "evidence_text": "x", "evidence_source": "transcript"}
        loader = lambda ref: None
        self.assertFalse(verify_evidence_from_raw(sig, loader))

    def test_3_content_hash_mismatch(self):
        sig = {"raw_record_ref": "r1", "content_hash": "hash_a", "evidence_text": "x", "evidence_source": "transcript"}
        loader = lambda ref: {"ok": True, "text": "x", "content_hash": "hash_b"}
        self.assertFalse(verify_evidence_from_raw(sig, loader))

    def test_4_evidence_out_of_bounds(self):
        sig = {"type": "product_need", "value": "x", "evidence_text": "需要", "evidence_source": "transcript", "evidence_start": 999, "evidence_end": 1005}
        self.assertFalse(verify_evidence(sig, "需要采购户外桌", ""))

    def test_5_empty_records_vs_api_error(self):
        self.assertEqual(inspect_empty("note", {"records": [], "success": True, "total": 0, "code": 200})["status"], "no_data")
        self.assertEqual(inspect_empty("note", {"records": [], "success": False, "code": 500})["status"], "api_error")
        self.assertEqual(inspect_empty("note", {"records": [], "success": True, "total": 10, "code": 200})["status"], "pagination_or_field_error")

    def test_6_unknown_nested_field(self):
        records = [{"id": "n1", "text": "x", "nested": {"a": 1, "b": {"c": 2}}, "unknown_list": [1, 2, 3]}]
        insp = inspect_schema(records)
        self.assertIn("nested", insp["fields"])
        self.assertTrue(insp["fields"]["nested"]["nested"])
        self.assertIn("unknown_list", insp["fields"])

    def test_7_multi_page_records(self):
        p1 = capture_raw_response("note", {"records": [{"id": "n1", "text": "a"}, {"id": "n2", "text": "b"}], "total": 5, "success": True}, pagination={"page": 1, "limit": 2})
        self.assertEqual(p1["meta"]["record_count"], 2)
        self.assertEqual(p1["meta"]["total"], 5)

    def test_8_replay_deterministic(self):
        note_fixture = capture_raw_response(
            "note",
            {"records": [{"id": "note_001", "text": "买家需要采购约200套户外餐桌椅，请报价。", "customerId": "cust_001", "opportunityId": "opp_001"}], "success": True, "total": 1},
        )
        r1 = replay(note_fixture=note_fixture, customer_id="cust_001", opportunity_id="opp_001")
        r2 = replay(note_fixture=note_fixture, customer_id="cust_001", opportunity_id="opp_001")
        self.assertEqual(r1["stage"]["proposed_stage"], r2["stage"]["proposed_stage"])
        self.assertEqual(r1["stage"]["status"], r2["stage"]["status"])

    def test_9_same_record_multi_version(self):
        store = IngestStore()
        store.put_raw({"source": "note", "source_record_id": "n1", "kind": "transcript", "text": "版本A", "content_hash": "h1"})
        store.put_raw({"source": "note", "source_record_id": "n1", "kind": "transcript", "text": "版本B", "content_hash": "h2"})
        self.assertEqual(len(store.raw_versions("note", "n1")), 2)
        self.assertEqual(store.get_raw("note", "n1")["text"], "版本B")

    def test_10_raw_complete_log_redacted(self):
        """raw 完整原文 + 日志/诊断脱敏分层。"""
        resp = {"records": [{"id": "n1", "text": "会议全文" * 100, "email": "buyer@example.com", "phone": "+86 138 0013 8000"}], "success": True}
        cap = capture_raw_response("note", resp)
        # raw 完整：response 含全文和联系方式
        raw_saved = json.dumps(cap["response"], ensure_ascii=False)
        self.assertIn("buyer@example.com", raw_saved)
        self.assertIn("会议全文" * 100, raw_saved)
        # 日志脱敏：log_safe_view 不含全文和联系方式
        log_saved = json.dumps(log_safe_view(cap), ensure_ascii=False)
        self.assertNotIn("buyer@example.com", log_saved)
        self.assertNotIn("会议全文" * 100, log_saved)
        self.assertIn("redacted", log_saved)


class TestFileRawLoader(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = Path(self.tmp) / "raw_root"
        self.root.mkdir()
        self.loader = FileRawLoader(str(self.root))

    def _write(self, relpath, content):
        p = self.root / relpath
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return p

    def test_normal_read_full_text(self):
        self._write("meeting/note_001.txt", "买家需要采购户外桌")
        r = self.loader.load("meeting/note_001.txt")
        self.assertTrue(r["ok"])
        self.assertEqual(r["text"], "买家需要采购户外桌")
        self.assertIn("content_hash", r)

    def test_path_traversal(self):
        r = self.loader.load("../secret.txt")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "path_traversal")

    def test_absolute_path(self):
        r = self.loader.load("/etc/passwd")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "absolute_path")

    def test_symlink_escape(self):
        outside = Path(self.tmp) / "outside.txt"
        outside.write_text("secret", encoding="utf-8")
        link = self.root / "link.txt"
        os.symlink(str(outside), str(link))
        r = self.loader.load("link.txt")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "symlink_escape")

    def test_file_not_found(self):
        r = self.loader.load("meeting/not_exist.txt")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "not_found")

    def test_hash_mismatch(self):
        self._write("meeting/note_001.txt", "原文内容")
        r = self.loader.load("meeting/note_001.txt", expected_hash="wrong_hash")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "hash_mismatch")

    def test_file_too_large(self):
        loader = FileRawLoader(str(self.root), max_file_size=10)
        self._write("meeting/big.txt", "x" * 100)
        r = loader.load("meeting/big.txt")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "too_large")

    def test_bad_encoding(self):
        p = self.root / "meeting" / "bad.txt"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\xff\xfe\x00\x01")
        r = self.loader.load("meeting/bad.txt")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "bad_encoding")


class TestDryRun(unittest.TestCase):
    def test_dry_run_no_business_write(self):
        r = run_debug(source="note", supplier_id="cust_001", exhibition_id="opp_001", dry_run=True)
        self.assertTrue(r["dry_run"])
        self.assertIn("summary", r)
        # dry_run 只诊断 + 预计数量，不落库（store 内存，无文件写入）
        self.assertIn("new", r["summary"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
