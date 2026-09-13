#!/usr/bin/env python3
"""dc_contact_link 测试：邮箱 → 联系人/线索 的解析（离线）。"""
from __future__ import annotations
import json, sys, tempfile, unittest
from pathlib import Path
MIO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIO))
import dc_contact_link as cl


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        (d / "contacts" / "acme").mkdir(parents=True)
        (d / "contacts" / "acme" / "2026-09-13.md").write_text(
            "# DealClaw Contacts\n"
            + json.dumps({"lead_id": "CO123", "company_id": "acme", "contact_id": "LX456",
                          "name": "Rogerio Oliveira", "role": "Buyer",
                          "email": "ROGERIO@Example.com"}, ensure_ascii=False) + "\n",
            encoding="utf-8")
        (d / "leads.json").write_text(json.dumps([
            {"company_name": "PT Example Indonesia", "domain": "example.co.id",
             "_xq_email": "boss@example.co.id", "_xq_contactName": "Budi"}
        ], ensure_ascii=False), encoding="utf-8")
        self.d = d

    def tearDown(self):
        self.tmp.cleanup()

    def test_match_contact_by_email_case_insensitive(self):
        r = cl.link_by_email("acme", ["rogerio@example.com"], data_dir=self.d)
        self.assertEqual(r["lead_id"], "CO123")
        self.assertEqual(r["contact_id"], "LX456")
        self.assertEqual(r["contact_name"], "Rogerio Oliveira")

    def test_match_lead_by_xq_email(self):
        r = cl.link_by_email("acme", ["boss@example.co.id"], data_dir=self.d)
        self.assertEqual(r["lead_company"], "PT Example Indonesia")
        self.assertEqual(r["lead_domain"], "example.co.id")

    def test_domain_fallback_matches_other_contact_in_domain(self):
        """联系人邮箱没直接命中时，按域名兜底归到同一买家主体。"""
        r = cl.link_by_email("acme", ["someone-else@example.com"], data_dir=self.d)
        self.assertEqual(r["match"], "domain-contacts")
        self.assertEqual(r["contact_id"], "LX456")

    def test_no_match_returns_empty(self):
        r = cl.link_by_email("acme", ["nobody@nowhere.com"], data_dir=self.d)
        self.assertEqual(r["match"], "")
        self.assertEqual(r["lead_id"], "")

    def test_no_recipients(self):
        self.assertEqual(cl.link_by_email("acme", [], data_dir=self.d)["match"], "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
