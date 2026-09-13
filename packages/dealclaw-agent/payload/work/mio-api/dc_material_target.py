#!/usr/bin/env python3
"""dc_material_target — 自动解析「物料表/资料层」坐标（Base + table + 附件列）。

不再向人要 token：物料表就是飞书多维表，按租户自动解析：
  ① 缓存：data/memory/<key>/kb_targets.json（命中即返回，避免重复建）
  ② 发现：已注册/可发现的 Base 里找名为 物料表/资料层/物料索引 的表
  ③ 兜底创建：base +base-create（"<公司名> · 物料表"）→ base +table-create（标准字段）
  ④ 解析附件列 field id（field-list 里找 type=attachment）
产物结构：
  {"base_token": "...", "table_id": "...", "attachment_field_id": "...",
   "created": bool, "source": "cache|discovered|created"}

标准字段（与 skill 的粒度铁律一致：一条记录 = 一个可独立调用的物料单元）：
  文件名称(text, 主字段) / 类型(select) / 状态(select) / 营销用途(text) / 附件(attachment)
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import dc_kb_engine as kbe  # noqa: E402
from dc_kb_engine import KBEngine  # noqa: E402

TABLE_NAMES = ("物料表", "资料层", "物料索引")
MATERIAL_TYPES = ("产品目录", "报价单", "技术规格", "认证证书", "样品实拍", "客户案例", "产品视频")
ATTACH_FIELD = "附件"
TABLE_FIELDS = [
    {"name": "文件名称", "type": "text"},
    {"name": "类型", "type": "select", "multiple": False,
     "options": [{"name": t} for t in MATERIAL_TYPES]},
    {"name": "状态", "type": "select", "multiple": False,
     "options": [{"name": "✅"}, {"name": "⬜"}]},
    {"name": "营销用途", "type": "text"},
    {"name": ATTACH_FIELD, "type": "attachment"},
]


def _lark(*args: str, timeout: int = 120) -> dict:
    cmd = ["lark-cli"] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"lark-cli 失败: {(r.stderr or r.stdout)[:200]}")
    out = r.stdout.strip()
    try:
        return json.loads(out) if out else {}
    except json.JSONDecodeError:
        raise RuntimeError(f"lark-cli 非 JSON 输出: {out[:200]}")


def _key(enterprise: str) -> str:
    try:
        return KBEngine()._key(enterprise)
    except Exception:
        return enterprise


def _cache_path(enterprise: str) -> Path:
    return kbe.KB_DIR / _key(enterprise) / "kb_targets.json"


def read_cache(enterprise: str) -> Optional[dict]:
    p = _cache_path(enterprise)
    if p.exists():
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            if d.get("base_token") and d.get("table_id"):
                return {**d, "source": "cache"}
        except Exception:
            pass
    return None


def write_cache(enterprise: str, target: dict) -> None:
    p = _cache_path(enterprise)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(target, ensure_ascii=False, indent=2), encoding="utf-8")


def find_table_in_base(base_token: str) -> Optional[dict]:
    """在给定 Base 里找同名的物料表。"""
    try:
        d = _lark("base", "+table-list", "--base-token", base_token, "--as", "bot", "--json")
    except Exception:
        return None
    items = (d.get("data") or {}).get("items") or (d.get("data") or {}).get("tables") \
        or d.get("items") or []
    for t in items:
        name = str(t.get("name") or "")
        if name in TABLE_NAMES:
            return {"base_token": base_token, "table_id": t.get("table_id") or t.get("id"),
                    "name": name}
    return None


def attachment_field_id(base_token: str, table_id: str) -> str:
    try:
        d = _lark("base", "+field-list", "--base-token", base_token,
                  "--table-id", table_id, "--as", "bot", "--json")
    except Exception:
        return ""
    items = (d.get("data") or {}).get("items") or (d.get("data") or {}).get("fields") or []
    for f in items:
        if str(f.get("field_name") or f.get("name")) == ATTACH_FIELD:
            return str(f.get("field_id") or f.get("id") or "")
    return ""


def create_base(company_name: str) -> str:
    d = _lark("base", "+base-create", "--name", f"{company_name or '租户'} · 物料表",
              "--as", "bot", "--json")
    data = d.get("data") or {}
    base = data.get("base") or {}
    return str(base.get("base_token") or data.get("app_token") or data.get("base_token") or "")


def create_table(base_token: str) -> str:
    d = _lark("base", "+table-create", "--base-token", base_token, "--name", "物料表",
              "--fields", json.dumps(TABLE_FIELDS, ensure_ascii=False),
              "--as", "bot", "--json")
    data = d.get("data") or {}
    tbl = data.get("table") or {}
    return str(data.get("table_id") or tbl.get("table_id") or tbl.get("id") or "")


def resolve_target(enterprise: str, company_name: str = "",
                   known_base_token: str = "", create_if_missing: bool = True) -> dict:
    """解析（必要时创建）物料表坐标。失败抛异常，绝不返回假坐标。"""
    cached = read_cache(enterprise)
    if cached:
        return cached

    created = False
    base_token = known_base_token
    table_id = ""

    if base_token:
        found = find_table_in_base(base_token)
        if found:
            table_id = found["table_id"]
    if not (base_token and table_id):
        if not create_if_missing:
            raise RuntimeError("物料表不存在且未允许创建")
        base_token = base_token or create_base(company_name or enterprise)
        if not base_token:
            raise RuntimeError("创建 Base 失败（未拿到 app_token）")
        table_id = create_table(base_token)
        if not table_id:
            raise RuntimeError("创建物料表失败（未拿到 table_id）")
        created = True

    field_id = attachment_field_id(base_token, table_id)
    target = {"base_token": base_token, "table_id": table_id,
              "attachment_field_id": field_id, "created": created,
              "source": "created" if created else "discovered"}
    write_cache(enterprise, target)
    return target


def main(argv=None) -> int:  # pragma: no cover
    import argparse, os
    ap = argparse.ArgumentParser(description="解析/创建租户物料表坐标")
    ap.add_argument("--enterprise", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--company-name", default="")
    ap.add_argument("--base-token", default="")
    ap.add_argument("--no-create", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    t = resolve_target(args.enterprise, args.company_name, args.base_token,
                       create_if_missing=not args.no_create)
    print(json.dumps(t, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
