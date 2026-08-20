#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import dc_company_registry as registry


class LeadPoolSyncTests(unittest.TestCase):
    def test_sync_creates_updates_and_returns_link(self):
        calls = []

        def fake_run(*args, **kwargs):
            calls.append(args)
            if "+record-batch-create" in args:
                return {"ok": True, "data": {"records": [{"record_id": "rec_new"}]}}
            return {"ok": True, "data": {}}

        pool = {
            "app_token": "app_x",
            "table_id": "tbl_x",
            "field_map": {},
            "created": False,
            "bitable_url": "https://versa-ai.feishu.cn/base/app_x?table=tbl_x",
        }
        records = [
            {
                "companyName": "New Buyer",
                "website": "https://new.example/path",
                "countryCnName": "德国",
                "companyAttributes": ["品牌商"],
                "purchaseTags": [{"name": "drinkware"}],
                "buyerIntroduce": "高匹配品牌买家",
            },
            {
                "companyName": "Existing Buyer",
                "website": "existing.example",
                "country": "DE",
            },
        ]

        with patch.object(registry, "ensure_company_lead_pool", return_value=pool), \
             patch.object(registry, "_existing_record_index", return_value={
                 "website:existing.example": "rec_existing"
             }), \
             patch.object(registry, "_run_lark", side_effect=fake_run):
            result = registry.sync_leads_to_pool(
                "acme.example", "Acme", records, source="引擎搜索"
            )

        self.assertEqual(result["created"], 1)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["bitable_url"], pool["bitable_url"])
        self.assertTrue(any("+record-batch-create" in call for call in calls))
        self.assertTrue(any("+record-upsert" in call for call in calls))

    def test_field_mapping_keeps_user_visible_fields(self):
        fields = registry._record_fields({
            "companyName": "Buyer GmbH",
            "website": "buyer.example",
            "countryCnName": "德国",
            "companyAttributes": ["分销商"],
            "purchaseTags": ["Glassware", "Lighting"],
            "recommendation": "渠道匹配",
        }, "米奥数据库")
        self.assertEqual(fields["公司名"], "Buyer GmbH")
        self.assertEqual(fields["买家类型"], "经销商")
        self.assertEqual(fields["匹配产品"], ["Glassware", "Lighting"])
        self.assertEqual(fields["来源"], "米奥数据库")


if __name__ == "__main__":
    unittest.main()
