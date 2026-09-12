#!/usr/bin/env python3
"""test_exhibition_index.py — 展会 meta 落点 + index.md 生成 单元测试。

覆盖：set_booth 记住不丢（用户优先）/ upsert_exhibition 按字段 merge /
index 文档六大块齐全 / 进度统计 / 完整度标注。
"""

import json
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dc_exhibition_meta as M  # noqa: E402
from dc_exhibition_index import (  # noqa: E402
    build_index_document,
    section_progress,
    section_integrity,
    write_index_file,
    publish_index,
)


def _patch_meta(td):
    return unittest.mock.patch.object(
        M, "meta_path", lambda cid: Path(td) / "data" / "memory" / cid / "meta.json")


def _write(root, cid, name, data):
    p = Path(root) / "data" / "memory" / cid / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


class TestMeta(unittest.TestCase):
    def test_set_booth_user_remembered(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                r = M.set_booth("sid", "A-123", source="user")
                self.assertTrue(r["ok"])
                self.assertEqual(r["booth"], "A-123")
                self.assertEqual(M.get_exhibition("sid")["booth"], "A-123")
                self.assertEqual(M.get_exhibition("sid")["booth_source"], "user")

    def test_interface_does_not_overwrite_user(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                M.set_booth("sid", "A-123", source="user")
                r = M.set_booth("sid", "B-999", source="win-contracts")
                self.assertTrue(r.get("kept_user_value"))
                self.assertEqual(M.get_exhibition("sid")["booth"], "A-123")

    def test_interface_fills_when_empty(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                M.set_booth("sid", "C-1", source="win-contracts")
                self.assertEqual(M.get_exhibition("sid")["booth"], "C-1")

    def test_upsert_merges_fields(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                M.upsert_exhibition("sid", "exh1", name="Mexico Expo 2026", city="墨西哥城")
                M.upsert_exhibition("sid", "exh1", country="MX")
                e = M.get_exhibition("sid", "exh1")
                self.assertEqual(e["name"], "Mexico Expo 2026")   # 未被覆盖
                self.assertEqual(e["city"], "墨西哥城")
                self.assertEqual(e["country"], "MX")

    def test_preserves_other_meta_fields(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                M.write_meta("sid", {"exhibition_stage": "live", "exhibitions": []})
                M.set_booth("sid", "A-1", source="user")
                meta = M.read_meta("sid")
                self.assertEqual(meta["exhibition_stage"], "live")


class TestProgress(unittest.TestCase):
    def test_counts(self):
        buyers = [
            {"lead": {"company": "A", "followup_priority": "优先跟进", "priority_reason": "r"},
             "interactions": [1, 2], "invitation": {"exhibitionName": "E"}},
            {"lead": {"company": "B"}, "interactions": [], "invitation": None},
        ]
        md = section_progress(buyers)
        self.assertIn("买家总数：2", md)
        self.assertIn("已邀约：1", md)
        self.assertIn("互动总条数：2", md)
        self.assertIn("优先跟进：1", md)
        self.assertIn("A（r）", md)


class TestIntegrity(unittest.TestCase):
    def test_marks_unavailable(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [{"company": "A"}])
            md = section_integrity("sid", workspace_root=td)
            self.assertIn("线索池 leads.json：✅ ready", md)
            self.assertIn("interactions.json：⚠️ unavailable", md)


class TestIndexDocument(unittest.TestCase):
    def test_all_sections(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                M.upsert_exhibition("sid", "exh1", name="Mexico Expo 2026", city="墨西哥城")
                M.set_booth("sid", "A-123", source="user")
                _write(td, "sid", "leads.json", [
                    {"company": "Casa", "company_cdp_id": "c1", "country": "MX",
                     "stage": "需求明确", "followup_priority": "优先跟进"}])
                _write(td, "sid", "interactions.json", [
                    {"interaction_id": "i1", "customer_id": "c1", "channel": "email",
                     "direction": "inbound", "occurred_at": "2026-09-08T00:00:00Z",
                     "subject": "Re: quote", "summary": "要样品"}])
                _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
                _write(td, "sid", "kb.json", {"profile": {"name": "Our Co"}})

                md = build_index_document("sid", workspace_root=td)
                for sec in ("一、展商参展信息", "二、展会信息", "三、买家总览",
                            "四、买家档案", "五、进度概览", "六、数据完整度"):
                    self.assertIn(sec, md)
                self.assertIn("A-123", md)          # 展位号
                self.assertIn("用户提供，已记住", md)  # 记住标注
                self.assertIn("Mexico Expo 2026", md)
                self.assertIn("# Casa", md)          # 单客档案

    def test_empty_company(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                md = build_index_document("sid", workspace_root=td)
                self.assertIn("暂无买家记录", md)


class TestWriteAndPublish(unittest.TestCase):
    def test_write_index_file(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                M.upsert_exhibition("sid", "exh1", name="Mexico Expo 2026")
                r = write_index_file("sid", workspace_root=td)
                self.assertTrue(r["ok"])
                self.assertIn("exhibitions", r["path"])
                self.assertIn("展会目录", Path(r["path"]).read_text(encoding="utf-8"))

    def test_publish_create_then_update(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                M.upsert_exhibition("sid", "exh1", name="E")
                def create_doc(content):
                    return "https://doc/1"
                def update_doc(url, content):
                    return True
                r1 = publish_index("sid", create_doc=create_doc, update_doc=update_doc, workspace_root=td)
                self.assertEqual(r1["action"], "create")
                self.assertEqual(M.get_exhibition("sid")["index_doc_url"], "https://doc/1")
                r2 = publish_index("sid", create_doc=create_doc, update_doc=update_doc, workspace_root=td)
                self.assertEqual(r2["action"], "update")

    def test_publish_create_failed(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                r = publish_index("sid", create_doc=lambda c: "",
                                  update_doc=lambda u, c: True, workspace_root=td)
                self.assertFalse(r["ok"])


class TestSyncInfo(unittest.TestCase):
    def test_sync_from_fetcher(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                def fetcher():
                    return [{"exhibitionId": "exh1", "name": "Mexico Expo 2026", "country": "MX",
                             "inshowStartDate": "2026-09-05", "inshowEndDate": "2026-09-08"}]
                r = M.sync_exhibition_info("sid", fetcher=fetcher)
                self.assertTrue(r["ok"])
                e = M.get_exhibition("sid", "exh1")
                self.assertEqual(e["name"], "Mexico Expo 2026")
                self.assertEqual(e["start"], "2026-09-05")

    def test_sync_preserves_user_booth(self):
        with tempfile.TemporaryDirectory() as td:
            with _patch_meta(td):
                M.set_booth("sid", "A-123", exhibition_id="exh1", source="user")
                M.sync_exhibition_info("sid", fetcher=lambda: [{"exhibitionId": "exh1", "name": "E"}])
                self.assertEqual(M.get_exhibition("sid", "exh1")["booth"], "A-123")


if __name__ == "__main__":
    unittest.main(verbosity=2)
