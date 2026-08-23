#!/usr/bin/env python3
"""Diff a live 买家线索 table's fields against the approved Base schema.

Historical Bases (created before a schema revision, e.g. before the v15
unlock columns) must be reconciled additively: this guard compares the live
field list with the approved schema and emits an add-only plan. It never
renames, retypes, or deletes user fields, and it refuses to auto-convert a
same-named field with an incompatible type — that requires an explicit
administrator decision because user data may be involved.

Usage:
    python base_schema_guard.py plan < "<live-field-list.json>"
    python base_schema_guard.py self-test

Input:  {"fields": [{"name": "买家公司名称", "type": "text"},
                    {"name": "是否解锁", "type": "single_select",
                     "options": ["未解锁", "已解锁"]}, ...]}
Output: {"ok": bool, "missing_fields": [...], "add_plan": [...],
         "incompatible_fields": [...], "primary_field_ok": bool}
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


class SchemaGuardError(RuntimeError):
    """Raised when the live field list cannot be evaluated safely."""


# Approved schema, mirrored from references/base-schema.md.
# kind: text | long_text | number | checkbox | person | datetime |
#       single_select | multi_select
REQUIRED_FIELDS: list[dict[str, Any]] = [
    # Interface fact fields
    {"name": "线索ID", "type": "text", "primary": True},
    {"name": "买家CDPID", "type": "text"},
    {"name": "联系人ID", "type": "text"},
    {"name": "买家公司名称", "type": "text"},
    {"name": "买家公司简介", "type": "long_text"},
    {"name": "买家国家", "type": "text"},
    {"name": "产品类别T1", "type": "text"},
    {"name": "产品类别T2", "type": "text"},
    {"name": "需求意向", "type": "long_text"},
    {"name": "关注产品", "type": "long_text"},
    {"name": "买家类型", "type": "text"},
    {"name": "买家特征", "type": "text"},
    {"name": "报名参展展会", "type": "text"},
    {"name": "需求时间", "type": "text"},
    # AI fields
    {"name": "AI匹配分", "type": "number"},
    {"name": "AI原始分", "type": "number"},
    {"name": "反馈扣分", "type": "number"},
    {"name": "AI匹配等级", "type": "single_select", "options": ["高", "中", "低"]},
    {"name": "核心匹配通过", "type": "checkbox"},
    {"name": "AI匹配理由", "type": "long_text"},
    {"name": "评分明细", "type": "long_text"},
    {"name": "线索明确MOQ", "type": "text"},
    {"name": "评分权重版本", "type": "text"},
    {"name": "企业画像版本", "type": "text"},
    {"name": "企业画像群ID", "type": "text"},
    {"name": "画像企业名称", "type": "text"},
    {"name": "运行上下文ID", "type": "text"},
    {"name": "AI处理时间", "type": "datetime"},
    # User-feedback fields
    {"name": "是否匹配", "type": "single_select",
     "options": ["待确认", "✅ 匹配", "❌ 不匹配"]},
    {"name": "不匹配原因", "type": "multi_select", "options": [
        "产品名称不匹配", "产品类别不匹配", "买家类型不匹配", "国家不匹配",
        "MOQ不匹配", "买家标签不匹配", "买家简介不匹配", "需求意向不匹配",
        "需求已过期", "线索质量低", "重复线索", "其他",
    ]},
    {"name": "反馈说明", "type": "long_text"},
    {"name": "反馈人", "type": "person"},
    {"name": "反馈时间", "type": "datetime"},
    {"name": "跟进状态", "type": "single_select",
     "options": ["未跟进", "已联系", "已回复", "已转化", "关闭"]},
    {"name": "跟进备注", "type": "long_text"},
    {"name": "是否解锁", "type": "single_select", "options": ["未解锁", "已解锁"]},
    # System fields
    {"name": "唯一去重键", "type": "text"},
    {"name": "飞书群ID", "type": "text"},
    {"name": "首次入池时间", "type": "datetime"},
    {"name": "最近更新时间", "type": "datetime"},
    {"name": "首次推送时间", "type": "datetime"},
    {"name": "最近推送时间", "type": "datetime"},
    {"name": "推送次数", "type": "number"},
    {"name": "最近推送批次ID", "type": "text"},
    {"name": "推送消息ID", "type": "text"},
    # Unlock system fields (v15)
    {"name": "解锁人", "type": "person"},
    {"name": "解锁时间", "type": "datetime"},
    {"name": "解锁方式", "type": "text"},
    {"name": "解锁推送消息ID", "type": "text"},
]

VALID_TYPES = {"text", "long_text", "number", "checkbox", "person",
               "datetime", "single_select", "multi_select"}

# Unified company lead pool main table (线索池), mirrored from
# references/base-schema.md. Interface facts + feedback + unlock + system
# fields; score details live in the linked 评分明细 sub-table and exhibition
# activity in 参展行为.
POOL_MAIN_FIELDS: list[dict[str, Any]] = [
    # System identity
    {"name": "唯一去重键", "type": "text", "primary": True},
    {"name": "企业键", "type": "text"},
    {"name": "来源", "type": "single_select", "options": ["AI猎客"]},
    # Interface fact fields
    {"name": "线索ID", "type": "text"},
    {"name": "买家CDPID", "type": "text"},
    {"name": "联系人ID", "type": "text"},
    {"name": "买家公司名称", "type": "text"},
    {"name": "买家公司简介", "type": "long_text"},
    {"name": "买家国家", "type": "text"},
    {"name": "产品类别T1", "type": "text"},
    {"name": "产品类别T2", "type": "text"},
    {"name": "需求意向", "type": "long_text"},
    {"name": "关注产品", "type": "long_text"},
    {"name": "买家类型", "type": "text"},
    {"name": "买家特征", "type": "text"},
    {"name": "需求时间", "type": "text"},
    # AI summary fields (details in 评分明细 sub-table)
    {"name": "AI匹配分", "type": "number"},
    {"name": "AI匹配等级", "type": "single_select", "options": ["高", "中", "低"]},
    {"name": "核心匹配通过", "type": "checkbox"},
    # User-feedback fields
    {"name": "是否匹配", "type": "single_select",
     "options": ["待确认", "✅ 匹配", "❌ 不匹配"]},
    {"name": "不匹配原因", "type": "multi_select", "options": [
        "产品名称不匹配", "产品类别不匹配", "买家类型不匹配", "国家不匹配",
        "MOQ不匹配", "买家标签不匹配", "买家简介不匹配", "需求意向不匹配",
        "需求已过期", "线索质量低", "重复线索", "其他",
    ]},
    {"name": "反馈说明", "type": "long_text"},
    {"name": "反馈人", "type": "person"},
    {"name": "反馈时间", "type": "datetime"},
    {"name": "跟进状态", "type": "single_select",
     "options": ["未跟进", "已联系", "已回复", "已转化", "关闭"]},
    {"name": "跟进备注", "type": "long_text"},
    # Unlock fields
    {"name": "是否解锁", "type": "single_select", "options": ["未解锁", "已解锁"]},
    {"name": "解锁人", "type": "person"},
    {"name": "解锁时间", "type": "datetime"},
    {"name": "解锁方式", "type": "text"},
    {"name": "解锁推送消息ID", "type": "text"},
    # System fields
    {"name": "飞书群ID", "type": "text"},
    {"name": "首次入池时间", "type": "datetime"},
    {"name": "最近更新时间", "type": "datetime"},
    {"name": "首次推送时间", "type": "datetime"},
    {"name": "最近推送时间", "type": "datetime"},
    {"name": "推送次数", "type": "number"},
    {"name": "最近推送批次ID", "type": "text"},
    {"name": "推送消息ID", "type": "text"},
]

SCHEMAS: dict[str, tuple[list[dict[str, Any]], str]] = {
    "legacy": (REQUIRED_FIELDS, "线索ID"),
    "pool": (POOL_MAIN_FIELDS, "唯一去重键"),
}


def plan(payload: Any, schema: str = "legacy") -> dict[str, Any]:
    if schema not in SCHEMAS:
        raise SchemaGuardError(f"unsupported schema: {schema!r}")
    required_fields, primary_name = SCHEMAS[schema]
    if not isinstance(payload, dict) or set(payload) != {"fields"}:
        raise SchemaGuardError('input must be an object with only "fields"')
    live = payload.get("fields")
    if not isinstance(live, list):
        raise SchemaGuardError("fields must be an array")

    live_by_name: dict[str, dict[str, Any]] = {}
    for index, field in enumerate(live):
        if not isinstance(field, dict):
            raise SchemaGuardError(f"fields[{index}] must be an object")
        name = field.get("name")
        if not isinstance(name, str) or not name.strip():
            raise SchemaGuardError(f"fields[{index}].name must be a non-empty string")
        name = name.strip()
        if name in live_by_name:
            raise SchemaGuardError(f"duplicate live field name: {name}")
        ftype = field.get("type")
        if ftype not in VALID_TYPES:
            raise SchemaGuardError(f"fields[{index}].type is missing or unsupported: {ftype!r}")
        options = field.get("options")
        if ftype in ("single_select", "multi_select"):
            if not isinstance(options, list) or not all(isinstance(o, str) for o in options):
                raise SchemaGuardError(f"{name}: select field must carry an options array")
        live_by_name[name] = {"name": name, "type": ftype, "options": options or []}

    missing: list[dict[str, Any]] = []
    incompatible: list[dict[str, Any]] = []
    for spec in required_fields:
        name = spec["name"]
        live_field = live_by_name.get(name)
        if live_field is None:
            entry = {"name": name, "type": spec["type"]}
            if spec.get("options"):
                entry["options"] = list(spec["options"])
            missing.append(entry)
            continue
        if live_field["type"] != spec["type"]:
            incompatible.append({
                "name": name,
                "expected_type": spec["type"],
                "actual_type": live_field["type"],
                "reason": "type_mismatch",
            })
            continue
        if spec.get("options"):
            absent = [o for o in spec["options"] if o not in live_field["options"]]
            if absent:
                incompatible.append({
                    "name": name,
                    "expected_type": spec["type"],
                    "actual_type": live_field["type"],
                    "missing_options": absent,
                    "reason": "missing_options",
                })

    primary_ok = primary_name in live_by_name and live_by_name[primary_name]["type"] == "text"
    return {
        "ok": not missing and not incompatible and primary_ok,
        "schema": schema,
        "primary_field": primary_name,
        "primary_field_ok": primary_ok,
        "missing_fields": missing,
        "add_plan": missing,  # add-only: create exactly these fields with these types/options
        "incompatible_fields": incompatible,
        "reconciliation_policy": "add_only",
    }


def fixture_full() -> dict[str, Any]:
    return {"fields": [
        {**{k: v for k, v in spec.items() if k != "primary"},
         "options": list(spec.get("options", []))}
        for spec in REQUIRED_FIELDS
    ]}


def fixture_pool_full() -> dict[str, Any]:
    return {"fields": [
        {**{k: v for k, v in spec.items() if k != "primary"},
         "options": list(spec.get("options", []))}
        for spec in POOL_MAIN_FIELDS
    ]}


def self_test() -> None:
    result = plan(fixture_full())
    assert result["ok"] is True and result["primary_field_ok"] is True
    assert result["schema"] == "legacy" and result["primary_field"] == "线索ID"
    assert result["missing_fields"] == [] and result["incompatible_fields"] == []

    # Legacy v14 Base: the five v15 unlock fields are absent.
    legacy_fields = [f for f in fixture_full()["fields"]
                     if f["name"] not in ("是否解锁", "解锁人", "解锁时间", "解锁方式", "解锁推送消息ID")]
    legacy = plan({"fields": legacy_fields})
    assert legacy["ok"] is False
    assert [f["name"] for f in legacy["add_plan"]] == [
        "是否解锁", "解锁人", "解锁时间", "解锁方式", "解锁推送消息ID"]
    unlock_spec = next(f for f in legacy["add_plan"] if f["name"] == "是否解锁")
    assert unlock_spec["type"] == "single_select"
    assert unlock_spec["options"] == ["未解锁", "已解锁"]

    # Type mismatch on an existing field is incompatible, never auto-converted.
    wrong_type = fixture_full()
    for f in wrong_type["fields"]:
        if f["name"] == "是否解锁":
            f["type"] = "text"
            f["options"] = []
    result = plan(wrong_type)
    assert result["ok"] is False
    assert result["incompatible_fields"][0]["reason"] == "type_mismatch"
    assert result["add_plan"] == []

    # A select missing a mandated option is reported.
    missing_option = fixture_full()
    for f in missing_option["fields"]:
        if f["name"] == "是否解锁":
            f["options"] = ["未解锁"]
    result = plan(missing_option)
    assert result["ok"] is False
    assert result["incompatible_fields"][0]["missing_options"] == ["已解锁"]

    # Extra user fields and extra options are tolerated.
    extra = fixture_full()
    extra["fields"].append({"name": "用户自定义列", "type": "text", "options": []})
    for f in extra["fields"]:
        if f["name"] == "是否解锁":
            f["options"] = ["未解锁", "已解锁", "用户加的选项"]
    assert plan(extra)["ok"] is True

    # Missing primary field is terminal.
    no_primary = {"fields": [f for f in fixture_full()["fields"] if f["name"] != "线索ID"]}
    result = plan(no_primary)
    assert result["primary_field_ok"] is False and result["ok"] is False

    # Malformed inputs are rejected.
    for bad in ({}, {"fields": "x"}, {"fields": [{}]},
                {"fields": [{"name": "a", "type": "unknown"}]},
                {"fields": [{"name": "a", "type": "text"},
                            {"name": "a", "type": "text"}]},
                {"fields": [{"name": "s", "type": "single_select"}]},
                {"fields": [], "extra": 1}):
        try:
            plan(bad)
        except SchemaGuardError:
            pass
        else:
            raise AssertionError(f"unsafe input was not rejected: {bad}")

    # Unified lead pool schema.
    pool = plan(fixture_pool_full(), schema="pool")
    assert pool["ok"] is True and pool["primary_field_ok"] is True
    assert pool["primary_field"] == "唯一去重键"

    # A pool missing identity/unlock columns gets an add-only plan.
    pool_partial = {"fields": [f for f in fixture_pool_full()["fields"]
                               if f["name"] not in ("企业键", "来源", "是否解锁")]}
    pool_result = plan(pool_partial, schema="pool")
    assert pool_result["ok"] is False
    assert [f["name"] for f in pool_result["add_plan"]] == ["企业键", "来源", "是否解锁"]
    source_spec = next(f for f in pool_result["add_plan"] if f["name"] == "来源")
    assert source_spec["type"] == "single_select" and source_spec["options"] == ["AI猎客"]

    # The pool primary field is 唯一去重键; 线索ID alone does not satisfy it.
    pool_no_primary = {"fields": [f for f in fixture_pool_full()["fields"]
                                  if f["name"] != "唯一去重键"]}
    pool_primary = plan(pool_no_primary, schema="pool")
    assert pool_primary["primary_field_ok"] is False and pool_primary["ok"] is False

    # An unknown schema name is rejected.
    try:
        plan(fixture_pool_full(), schema="unknown")
    except SchemaGuardError:
        pass
    else:
        raise AssertionError("unknown schema was not rejected")
    print("base_schema_guard self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "self-test"))
    parser.add_argument("--schema", choices=sorted(SCHEMAS), default="legacy",
                        help="approved schema to diff against (default: legacy)")
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = plan(json.load(sys.stdin), schema=args.schema)
    except (SchemaGuardError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if result["ok"] or result["add_plan"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
