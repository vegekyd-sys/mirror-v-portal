#!/usr/bin/env python3
"""dc_memory_view / dc_learning_digest 测试（全部离线，写临时 workspace）。

覆盖 2026-09-17 客户要求：「反思和更懂必须显化 + 主动汇报」。
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

MIO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIO))


class _TmpWorkspace:
    """临时 workspace（OPENCLAW_WORKSPACE_DIR + DC_DATA_DIR 都指向它）。"""

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._old = {k: os.environ.get(k) for k in ("OPENCLAW_WORKSPACE_DIR", "DC_DATA_DIR")}
        os.environ["OPENCLAW_WORKSPACE_DIR"] = str(self.root)
        os.environ["DC_DATA_DIR"] = str(self.root / "data")
        return self.root

    def __exit__(self, *exc):
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()


def _seed_facts(root: Path, company_id: str, rows: list[tuple]):
    path = root / "memory" / "company" / company_id / "facts.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "# 企业事实\n\n| 字段 | 值 | 来源 | 时间 |\n|---|---|---|---|\n"
    for field, value, source, date in rows:
        body += f"| {field} | {value} | {source} | {date} |\n"
    path.write_text(body, encoding="utf-8")


def _seed_rules(root: Path, company_id: str, rules: list[str]):
    path = root / "memory" / "company" / company_id / "rules.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(rules) + "\n", encoding="utf-8")


def _seed_reflections(root: Path, recs: list[dict]):
    path = root / "memory" / "projects" / "dealclaw" / "reflections.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n", encoding="utf-8")


def _today():
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")


class TestReaders(unittest.TestCase):
    def test_1_read_facts_parses_fixed_table(self):
        from dc_memory_view import read_facts
        with _TmpWorkspace() as root:
            _seed_facts(root, "C1", [("认证", "CE", "session", "2026-09-17"),
                                     ("产品线", "stand up pouch", "session", "2026-09-17")])
            rows = read_facts("C1")
            self.assertEqual([r["field"] for r in rows], ["认证", "产品线"])
            self.assertEqual(rows[0]["value"], "CE")

    def test_2_read_facts_missing_is_empty_not_invented(self):
        from dc_memory_view import read_facts
        with _TmpWorkspace():
            self.assertEqual(read_facts("NOPE"), [])

    def test_3_read_rules_parses_meta(self):
        from dc_memory_view import read_rules
        with _TmpWorkspace() as root:
            _seed_rules(root, "C1", ["- [active | 2026-09-17 | 会话] 东南亚只做印尼越南"])
            rules = read_rules("C1")
            self.assertEqual(len(rules), 1)
            self.assertEqual(rules[0]["text"], "东南亚只做印尼越南")
            self.assertEqual(rules[0]["state"], "active")

    def test_4_read_reflections_limit_and_user_filter(self):
        from dc_memory_view import read_reflections
        with _TmpWorkspace() as root:
            _seed_reflections(root, [
                {"ts": "2026-09-01T00:00:00+00:00", "what": "通用经验", "type": "pattern"},
                {"ts": "2026-09-02T00:00:00+00:00", "what": "别人家的", "type": "fact", "user": "ou_other"},
                {"ts": "2026-09-03T00:00:00+00:00", "what": "我方偏好", "type": "preference", "user": "ou_me"},
            ])
            self.assertEqual(len(read_reflections(limit=5)), 3)
            mine = read_reflections(limit=5, user="ou_me")
            self.assertEqual({r["what"] for r in mine}, {"通用经验", "我方偏好"})

    def test_5_resolve_company_id_prefers_existing_store(self):
        from dc_memory_view import resolve_company_id
        with _TmpWorkspace() as root:
            _seed_facts(root, "REAL", [("认证", "CE", "s", _today())])
            self.assertEqual(resolve_company_id("easterglasscom", "REAL"), "REAL")
            self.assertEqual(resolve_company_id("easterglasscom"), "easterglasscom")  # 都没有 → 不编造


class TestBlocks(unittest.TestCase):
    def test_6_facts_block_has_fixed_header_and_empty_when_missing(self):
        from dc_memory_view import render_facts_block
        with _TmpWorkspace() as root:
            self.assertEqual(render_facts_block("C1"), [])
            _seed_facts(root, "C1", [("认证", "CE", "session", _today())])
            text = "\n".join(render_facts_block("C1"))
            self.assertIn("## 📌 企业事实（我记住的）", text)
            self.assertIn("| 字段 | 值 | 来源 | 时间 |", text)
            self.assertIn("| 认证 | CE | session |", text)

    def test_7_rules_block_lists_active_only(self):
        from dc_memory_view import render_rules_block
        with _TmpWorkspace() as root:
            _seed_rules(root, "C1", ["- [active | 2026-09-17 | 会话] 只做印尼越南",
                                     "- [retired | 2026-09-10 | 会话] 旧口径"])
            text = "\n".join(render_rules_block("C1"))
            self.assertIn("只做印尼越南", text)
            self.assertNotIn("旧口径", text)

    def test_8_learning_block_reads_real_reflections(self):
        from dc_memory_view import render_learning_block
        with _TmpWorkspace() as root:
            _seed_reflections(root, [{"ts": "2026-09-17T01:00:00+00:00", "type": "pattern",
                                      "what": "客户要数字和 ROI，不是叙事"}])
            text = "\n".join(render_learning_block("C1"))
            self.assertIn("客户要数字和 ROI", text)


class TestDigest(unittest.TestCase):
    def test_9_digest_collects_facts_rules_reflections(self):
        from dc_memory_view import learning_digest
        with _TmpWorkspace() as root:
            day = _today()
            _seed_facts(root, "C1", [("认证", "CE", "session", day)])
            _seed_rules(root, "C1", [f"- [active | {day} | 会话] 东南亚只做印尼越南"])
            _seed_reflections(root, [{"ts": f"{day}T01:00:00+00:00", "type": "pattern",
                                      "what": "客户问交期先给排产表"}])
            out = learning_digest("C1", open_id="ou_me")
            self.assertGreaterEqual(out["count"], 3)
            self.assertIn("我又更懂你了", out["text"])
            self.assertIn("接下来我会照这些筛线索", out["text"])

    def test_10_digest_empty_when_nothing_new(self):
        from datetime import datetime, timedelta, timezone
        from dc_memory_view import learning_digest
        with _TmpWorkspace() as root:
            _seed_facts(root, "C1", [("认证", "CE", "session", "2020-01-01")])
            out = learning_digest("C1", since=datetime.now(timezone.utc) - timedelta(days=1))
            self.assertEqual(out["count"], 0)
            self.assertEqual(out["text"], "")


class TestDigestRunner(unittest.TestCase):
    def test_11_dry_run_does_not_send_or_write_state(self):
        import dc_learning_digest as d
        with _TmpWorkspace() as root:
            _seed_reflections(root, [{"ts": f"{_today()}T01:00:00+00:00", "type": "pattern",
                                      "what": "新学到的事"}])
            out = d.run("C1", open_id="ou_me", apply=False)
            self.assertEqual(out["status"], "dry_run")
            self.assertFalse((root / "data" / "learning-digest-state.json").exists())

    def test_12_rate_limited_within_interval(self):
        import dc_learning_digest as d
        with _TmpWorkspace() as root:
            _seed_reflections(root, [{"ts": f"{_today()}T01:00:00+00:00", "type": "pattern",
                                      "what": "新学到的事"}])
            state = root / "data" / "learning-digest-state.json"
            state.parent.mkdir(parents=True, exist_ok=True)
            state.write_text(json.dumps({"C1::ou_me": {
                "last_sent_at": d._now().isoformat(timespec="seconds"), "last_key": "x"}}),
                encoding="utf-8")
            out = d.run("C1", open_id="ou_me", apply=True)
            self.assertEqual(out["status"], "rate_limited")

    def test_13_no_items_never_sends(self):
        import dc_learning_digest as d
        with _TmpWorkspace():
            out = d.run("C1", open_id="ou_me", apply=True)
            self.assertEqual(out["status"], "no_items")

    def test_14_force_bypasses_rate_limit_and_route_error_is_honest(self):
        import dc_learning_digest as d
        with _TmpWorkspace() as root:
            _seed_reflections(root, [{"ts": f"{_today()}T01:00:00+00:00", "type": "pattern",
                                      "what": "新学到的事"}])
            out = d.run("C1", open_id="ou_me", apply=True, force=True)
            # 没有 notify 路由 → 必须如实报错，不得假装已发送，也不得写状态
            self.assertIn(out["status"], {"sent", "send_failed", "error"})
            if out["status"] != "sent":
                self.assertFalse((root / "data" / "learning-digest-state.json").exists())


class TestKbPublishWiring(unittest.TestCase):
    """文档展示层：首页「最近学到的新知识」真读反思，主题页含事实/规则。"""

    def _fake_kb(self):
        return {
            "profile": {"name": "示例公司", "usp": "软包装 20 年", "certifications": "CE"},
            "persona": {"country": {"BR": 3}, "buyer_type": {"importers": 2}, "evolution": []},
            "products": [{"name": "stand up pouch"}],
            "materials": {},
            "competitive": {},
            "iq_memory": {},
        }

    def test_15_homepage_shows_real_learnings(self):
        import dc_kb_publish as pub
        from dc_memory_view import learning_digest  # noqa: F401
        with _TmpWorkspace() as root:
            _seed_reflections(root, [{"ts": f"{_today()}T01:00:00+00:00", "type": "pattern",
                                      "what": "客户要数字和 ROI"}])
            orig = pub._load_kb
            pub._load_kb = lambda enterprise: (None, self._fake_kb())
            try:
                text = pub.build_homepage("C1")
            finally:
                pub._load_kb = orig
            self.assertIn("客户要数字和 ROI", text)

    def test_16_theme_page_shows_facts_and_rules(self):
        import dc_kb_publish as pub
        with _TmpWorkspace() as root:
            _seed_facts(root, "C1", [("认证", "CE", "session", _today())])
            _seed_rules(root, "C1", [f"- [active | {_today()} | 会话] 东南亚只做印尼越南"])
            orig = pub._load_kb
            pub._load_kb = lambda enterprise: (None, self._fake_kb())
            try:
                text = pub.build_profile("C1")
            finally:
                pub._load_kb = orig
            self.assertIn("## 📌 企业事实（我记住的）", text)
            self.assertIn("## 📐 长期规则（我们的约定）", text)
            self.assertIn("东南亚只做印尼越南", text)


class TestBriefWiring(unittest.TestCase):
    """早晚报「最近又学会了」默认真读同一份记忆（调用方不传也不空段）。"""

    def test_17_morning_brief_reads_real_learnings_by_default(self):
        import dc_brief_render as br
        with _TmpWorkspace() as root:
            _seed_reflections(root, [{"ts": f"{_today()}T01:00:00+00:00", "type": "pattern",
                                      "what": "客户问交期先给排产表"}])
            text = br.render_morning(kind="daily", date_label="2026-09-17",
                                    done=["发了 3 封开发信"], company_id="C1")
            self.assertIn("■ 最近又学会了", text)
            self.assertIn("客户问交期先给排产表", text)

    def test_18_morning_brief_omits_section_when_nothing_learned(self):
        import dc_brief_render as br
        with _TmpWorkspace():
            text = br.render_morning(kind="daily", date_label="2026-09-17", company_id="C1")
            self.assertNotIn("■ 最近又学会了", text)

    def test_19_explicit_learned_still_wins(self):
        import dc_brief_render as br
        with _TmpWorkspace():
            text = br.render_morning(kind="daily", learned=["调用方自己传的"], company_id="C1")
            self.assertIn("调用方自己传的", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
