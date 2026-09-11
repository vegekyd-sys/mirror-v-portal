#!/usr/bin/env python3
"""test_reflection_writers.py — reflection writer 回归测试（bug 修复固化）

对应候选 bug：「reflection 脚本曾 fallback 到全局共享路径 → 写错目录」。
固化点：
  1. resolve_workspace 自定位（脚本上两级），**不得**回退全局共享路径。
  2. 日期文件按业务时区（knight.config.timezone，默认 Asia/Shanghai）命名。

运行：cd packages/dealclaw-agent && python3 tests/test_reflection_writers.py
"""
import importlib.util
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

AGENT = Path(__file__).resolve().parents[1]
WRITER = AGENT / "payload" / "scripts" / "write-reflection.py"


def _load():
    spec = importlib.util.spec_from_file_location("write_reflection", WRITER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestResolveWorkspace(unittest.TestCase):
    def setUp(self):
        self.wr = _load()

    def test_self_locating_default(self):
        """无 config.workspace 时，自定位到脚本上两级（= payload 根），不回退全局。"""
        ws = self.wr.resolve_workspace({})
        self.assertEqual(ws, AGENT / "payload")

    def test_explicit_workspace_wins(self):
        ws = self.wr.resolve_workspace({"workspace": "/tmp/tenant-a"})
        self.assertEqual(ws, Path("/tmp/tenant-a"))

    def test_no_global_fallback(self):
        """不得解析到共享/全局目录（防写错目录）：必须就是 payload 自身，且不在全局配置路径下。"""
        ws = self.wr.resolve_workspace({})
        self.assertEqual(ws, AGENT / "payload")          # 自定位锚点
        s = str(ws)
        self.assertFalse(s.endswith("/memory"))           # 不得落到全局 memory
        self.assertNotIn("/.knight", s)                  # 不得回退全局 knight 配置路径
        self.assertNotEqual(ws, Path.home() / ".knight")


class TestBusinessTzFilename(unittest.TestCase):
    def setUp(self):
        self.wr = _load()

    def test_business_tz_used(self):
        cfg = {"timezone": "Asia/Shanghai"}
        tz = self.wr._business_tz(cfg)
        self.assertEqual(str(tz), "Asia/Shanghai")

    def test_write_local_filename_is_business_day(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = {"workspace": td, "timezone": "Asia/Shanghai",
                   "storage": {"local": {"reflections_dir": "memory/reflections"}}}
            self.wr.write_local({"context": "x"}, cfg)
            expected = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
            self.assertTrue((Path(td) / "memory" / "reflections" / f"{expected}.jsonl").exists())

    def test_default_tz_when_missing(self):
        self.assertEqual(str(self.wr._business_tz({})), "Asia/Shanghai")


if __name__ == "__main__":
    unittest.main(verbosity=2)
