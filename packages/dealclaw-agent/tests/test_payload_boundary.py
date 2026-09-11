#!/usr/bin/env python3
"""test_payload_boundary.py — payload 打包边界 + review-reflections 分类测试

校验：
  1. payload 树中不存在被排除的运行时 reflection / 企业数据 / 每日流水 / .env（打包边界）。
  2. review-reflections 的 5 分类判定（bug/skill_improvement/industry_knowledge/tenant_only/ignore）。
  3. 脱敏（邮箱/open_id/电话）。
  4. review-reflections 只读输入、不产生副作用（候选生成是纯函数）。

运行：cd packages/dealclaw-agent && python3 tests/test_payload_boundary.py
"""
import fnmatch
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

AGENT = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT.parents[1]
PAYLOAD = AGENT / "payload"
BOUNDARY = json.loads((AGENT / "payload-boundary.json").read_text(encoding="utf-8"))
# review-reflections 是「分发前测试母体工具」，已在 tools/reflection-review（不进 payload）
REVIEW_SCRIPT = REPO_ROOT / "tools" / "reflection-review" / "review-reflections.py"


def _load_review():
    spec = importlib.util.spec_from_file_location("review_reflections", REVIEW_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _matches(rel: str, pattern: str) -> bool:
    if pattern.endswith("/**"):
        base = pattern[:-3]
        return rel == base or rel.startswith(base + "/")
    return fnmatch.fnmatch(rel, pattern)


class TestPayloadExcludes(unittest.TestCase):
    def test_no_excluded_tracked_files(self):
        """实际会发出去的 = git 跟踪的 payload 文件；不得命中排除清单。"""
        import subprocess
        root = subprocess.check_output(["git", "-C", str(AGENT), "rev-parse", "--show-toplevel"],
                                       text=True).strip()
        out = subprocess.check_output(
            ["git", "-C", root, "ls-files", "--", "packages/dealclaw-agent/payload"], text=True)
        allowed = set(BOUNDARY.get("allow_placeholders", []))
        violations = []
        for line in out.splitlines():
            line = line.strip()
            if not line:
                continue
            rel = line.split("packages/dealclaw-agent/payload/", 1)[-1]
            if rel in allowed:
                continue
            for pat in BOUNDARY["exclude"]:
                if _matches(rel, pat):
                    violations.append((rel, pat))
                    break
        self.assertEqual(violations, [], f"payload 跟踪文件含被排除项（越界）: {violations}")

    def test_review_reflections_not_in_payload(self):
        self.assertFalse((PAYLOAD / "scripts" / "review-reflections.py").exists(),
                         "review-reflections 属于测试母体工具，不应在 payload")
        self.assertTrue(REVIEW_SCRIPT.exists(), f"缺少 {REVIEW_SCRIPT}")

    def test_dockerignore_covers_runtime_data(self):
        di = (AGENT / ".dockerignore").read_text(encoding="utf-8")
        for pat in ("payload/memory/reflections/*.jsonl", "reflections.jsonl",
                    "payload/work/mio-api/data", "payload/data", "payload/.env",
                    "payload/memory/2"):
            self.assertIn(pat, di, f".dockerignore 缺少排除项：{pat}")

    def test_rules_cover_key_cases(self):
        ex = BOUNDARY["exclude"]
        self.assertTrue(any("memory/reflections" in p for p in ex))
        self.assertTrue(any("reflections.jsonl" in p for p in ex))
        self.assertIn(".env", ex)
        self.assertTrue(any("memory/2" in p for p in ex))  # 每日流水

    def test_matches_helper(self):
        self.assertTrue(_matches("memory/reflections/2026-09-11.jsonl", "memory/reflections/**"))
        self.assertTrue(_matches("memory/2026-09-11.md", "memory/2[0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md"))
        self.assertFalse(_matches("memory/projects/dealclaw/industry-knowledge.md", "memory/reflections/**"))


class TestReviewClassification(unittest.TestCase):
    def setUp(self):
        self.m = _load_review()

    def test_agent_bug(self):
        cls, _ = self.m.classify_agent({"what_failed": "线上报错，空指针崩溃", "tags": ["bug"]})
        self.assertEqual(cls, "bug")

    def test_agent_skill(self):
        cls, _ = self.m.classify_agent({"what_worked": "建立了标准流程", "next_time": "必须端到端验证",
                                        "tags": ["workflow"]})
        self.assertEqual(cls, "skill_improvement")

    def test_business_industry(self):
        cls, _ = self.m.classify_business({"type": "fact", "what": "德国买家要认证",
                                           "how": "找买家按认证筛"})
        self.assertEqual(cls, "industry_knowledge")

    def test_business_reporting_is_skill(self):
        """Agent 如何表达/分析/排序/执行 → skill_improvement（不是领域知识）。"""
        cls, _ = self.m.classify_business(
            {"type": "pattern", "what": "客户要的是数字和 ROI，不是叙事性文案",
             "how": "早晚报按此排序/展示，Top-N 只放有证据客户"})
        self.assertEqual(cls, "skill_improvement")

    def test_buyer_behavior_is_industry(self):
        cls, _ = self.m.classify_business(
            {"type": "pattern", "what": "优先有采购记录的制造商，而非询盘多的贸易商",
             "how": "找买家时按买家行为筛"})
        self.assertEqual(cls, "industry_knowledge")

    def test_business_tenant_preference(self):
        cls, _ = self.m.classify_business({"type": "preference", "what": "只做印尼越南不碰泰国",
                                           "how": "过滤泰国"})
        self.assertEqual(cls, "tenant_only")

    def test_agent_ignore(self):
        cls, _ = self.m.classify_agent({"what_worked": "今天很顺利", "what_failed": "",
                                        "next_time": "", "tags": []})
        self.assertEqual(cls, "ignore")

    def test_desensitize(self):
        out = self.m.mask_pii("联系 a@b.com 或 ou_1234567890abcdef 电话 +86 138-0000-0000")
        self.assertNotIn("a@b.com", out)
        self.assertNotIn("ou_1234567890abcdef", out)


class TestReviewNoSideEffects(unittest.TestCase):
    def test_build_candidates_is_pure(self):
        m = _load_review()
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            (ws / "memory" / "reflections").mkdir(parents=True)
            (ws / "memory" / "reflections" / "2026-09-11.jsonl").write_text(
                json.dumps({"context": "x", "what_worked": "a", "what_failed": "崩溃",
                            "next_time": "修", "tags": []}, ensure_ascii=False) + "\n",
                encoding="utf-8")
            (ws / "memory" / "projects" / "dealclaw").mkdir(parents=True)
            (ws / "memory" / "projects" / "dealclaw" / "reflections.jsonl").write_text(
                json.dumps({"ts": "2026-09-11T00:00:00Z", "type": "fact",
                            "what": "德国买家要认证", "how": "筛", "user": ""},
                           ensure_ascii=False) + "\n", encoding="utf-8")
            before = {p: p.read_bytes() for p in ws.rglob("*") if p.is_file()}
            cands = m.build_candidates(ws)
            self.assertTrue(cands)
            self.assertEqual({c["classification"] for c in cands} & {"bug", "industry_knowledge"},
                             {"bug", "industry_knowledge"})
            for p, b in before.items():
                self.assertEqual(p.read_bytes(), b, f"{p} 被改动（应只读）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
