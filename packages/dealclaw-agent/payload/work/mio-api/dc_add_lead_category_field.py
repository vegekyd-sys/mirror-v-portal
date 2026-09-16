#!/usr/bin/env python3
"""给已有线索池补「线索大类」列（2026-09-15）。

背景：字段模型加了「线索大类」（展会买家 / 常态买家），但**代码没有"给已有表补字段"的能力**
（`EXPECTED_FIELD_NAMES` 不满足时只会刷新 field_map，不会建列）。所以这里提供一个
显式的一次性补列工具。

**默认 dry-run**：只列出"哪个池缺这一列、将要执行什么命令"，不改任何线上表。
加 `--apply` 才真正调用 `lark-cli base +field-create`。

用法::

    cd work/mio-api
    python3 dc_add_lead_category_field.py                 # 只看（默认）
    python3 dc_add_lead_category_field.py --apply         # 真补

池来源：`data/company_registry.json`（`DC_DATA_DIR` 可覆盖）里的每个企业池 + 展会池。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(BASE / "data")))
REGISTRY_FILE = DATA_DIR / "company_registry.json"

FIELD_NAME = "线索大类"
FIELD_JSON = {
    "name": FIELD_NAME,
    "type": "select",
    "multiple": False,
    "options": [{"name": "展会买家"}, {"name": "常态买家"}],
}


def _lark(*args: str) -> dict:
    p = subprocess.run(["lark-cli", *args], capture_output=True, text=True, timeout=120)
    try:
        return json.loads(p.stdout[p.stdout.find("{"):])
    except Exception:  # noqa: BLE001
        return {"_raw": (p.stdout or p.stderr)[:300]}


def existing_field_names(base_token: str, table_id: str) -> set[str]:
    res = _lark("base", "+field-list", "--base-token", base_token, "--table-id", table_id,
                "--as", "bot", "--format", "json")
    items = ((res.get("data") or {}).get("items")) or []
    return {str(f.get("field_name") or f.get("name") or "") for f in items}


def load_pools() -> list[dict]:
    if not REGISTRY_FILE.exists():
        return []
    try:
        reg = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    pools = []
    for company_id, v in reg.items():
        if not isinstance(v, dict):
            continue
        if v.get("app_token") and v.get("table_id"):
            pools.append({"company_id": company_id, "name": v.get("enterprise_name") or "",
                          "app_token": v["app_token"], "table_id": v["table_id"]})
    return pools


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="给已有线索池补「线索大类」列")
    p.add_argument("--apply", action="store_true", help="真的执行 field-create（默认只 dry-run）")
    a = p.parse_args(argv)

    pools = load_pools()
    if not pools:
        print(json.dumps({"ok": False,
                          "error": f"注册表不可用或为空: {REGISTRY_FILE}",
                          "note": "请在租户运行环境执行（本机是 V 环境，没有 company_registry.json）"},
                         ensure_ascii=False, indent=1))
        return 2

    plan = []
    for pool in pools:
        have = existing_field_names(pool["app_token"], pool["table_id"])
        cmd = ["lark-cli", "base", "+field-create",
               "--base-token", pool["app_token"], "--table-id", pool["table_id"],
               "--json", json.dumps(FIELD_JSON, ensure_ascii=False),
               "--as", "bot", "--format", "json"]
        need = FIELD_NAME not in have
        item = {**pool, "field_exists": not need, "command": " ".join(cmd)}
        if need and a.apply:
            item["result"] = _lark(*cmd[1:])
        plan.append(item)

    todo = [x for x in plan if not x["field_exists"]]
    print(json.dumps({"ok": True, "mode": "apply" if a.apply else "dry-run",
                      "pools": len(plan), "need_field": len(todo),
                      "plan": plan}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
