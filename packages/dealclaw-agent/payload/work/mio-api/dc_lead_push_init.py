#!/usr/bin/env python3
"""
DC-Lead-Push-Init — 单租户 lead push 初始化：生成 data/buyer-leads-v10/{主群chat_id}.json 的 state。

流程：
  1. 解析主接收方 chat_id（notify_routes.json default）
  2. provision_profile() → products + target_countries（data/memory/<supplier_id>/kb.json 优先，getBasicInfo 兜底）
  3. getBasicInfo → company_name
  4. 写 state（binding + profile，schema_version 10）
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

DEALCLAW_HOME = Path(os.environ.get("DEALCLAW_HOME", str(Path(__file__).resolve().parents[2])))
DATA_DIR = DEALCLAW_HOME / "data" / "buyer-leads-v10"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_env() -> None:
    try:
        from _tenant_env import load_tenant_env
        load_tenant_env()
    except ImportError:
        pass
    f = Path(__file__).resolve().parent / ".env"
    if not f.exists():
        return
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            if k not in os.environ:
                os.environ[k] = v.strip()


_load_env()


def resolve_chat_id() -> str:
    try:
        from dc_notify import get_default_target
        return get_default_target()
    except Exception:
        return ""


def get_company_name(supplier_id: str) -> str:
    try:
        from dc_auto_campaign import get_basic_info
        open_id = os.environ.get("MIO_V_OPEN_ID", "")
        basic = get_basic_info(supplier_id, open_id=open_id)
        return (basic.get("companyName") or basic.get("companyNameEn") or supplier_id).strip()
    except Exception:
        return supplier_id


def init_state(chat_id: str = "", supplier_id: str = "", dry_run: bool = False) -> dict:
    from dc_profile_provision import provision_profile, _env_supplier_id

    sid = (supplier_id or _env_supplier_id()).strip()
    chat_id = (chat_id or resolve_chat_id()).strip()
    if not chat_id:
        return {"status": "error", "error": "未配置主接收方（notify_routes.json default）"}
    if not sid:
        return {"status": "error", "error": "MIO_CDP_SUPPLIER_ID 未配置"}

    prof = provision_profile(sid)
    products = prof.get("products") or []
    countries = prof.get("target_countries") or []
    company_name = get_company_name(sid)

    # 画像缺产品（KB 无 products / getBasicInfo 不提供产品）→ lead push 无法查买家，跳过初始化
    if not products:
        return {"status": "insufficient", "chat_id": chat_id, "supplier_id": sid,
                "company_name": company_name, "profile_source": prof.get("source"),
                "countries": [c["name"] for c in countries],
                "error": "画像缺产品（KB 无 products，getBasicInfo 不提供产品），lead push 无法查买家，跳过初始化"}

    state = {
        "schema_version": 10,
        "revision": 1,
        "status": "active" if (products and countries) else "partial",
        "chat_id": chat_id,
        "label": company_name,
        "binding": {
            "chat_id": chat_id,
            "company_name": company_name,
            "knowledge_doc_token": "",
            "base_app_token": None,
            "base_table_id": None,
            "tradechina_supplier_id": sid,
            "document_origin": "single_tenant_provision",
            "bound_by": "auto-init",
            "bound_at": _now(),
        },
        "profile": {
            "source_chat_id": chat_id,
            "source_doc_token": "",
            "source_kind": "single_tenant",
            "status": "active" if (products and countries) else "incomplete",
            "normalized_hash": "",
            "updated_at": _now(),
            "products": [{"name": p.get("name"), "aliases": p.get("aliases", []), "categories": []}
                         for p in products],
            "buyer_types": [],
            "target_countries": countries,
            "moq": "",
            "desired_buyer_tags": [],
            "buyer_profile_keywords": [],
            "intent_keywords": [],
        },
        "resource_permissions": None,
        "push": {"batches": {}},
        "unlocks": {},
    }

    if dry_run:
        return {"status": "dry_run", "chat_id": chat_id, "supplier_id": sid,
                "company_name": company_name, "profile_source": prof.get("source"),
                "products": [p["name"] for p in products],
                "countries": [c["name"] for c in countries]}

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / f"{chat_id}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    os.chmod(path, 0o600)
    return {"status": "initialized", "chat_id": chat_id, "path": str(path),
            "company_name": company_name, "profile_source": prof.get("source"),
            "products": [p["name"] for p in products],
            "countries": [c["name"] for c in countries]}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="单租户 lead push 初始化")
    ap.add_argument("--chat-id", default="", help="主接收方（默认 notify_routes.json default）")
    ap.add_argument("--supplier-id", default="", help="supplier id（默认 .env MIO_CDP_SUPPLIER_ID）")
    ap.add_argument("--dry-run", action="store_true", help="只预览不写")
    args = ap.parse_args()
    print(json.dumps(init_state(args.chat_id, args.supplier_id, args.dry_run),
                     ensure_ascii=False, indent=2))
