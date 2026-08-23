#!/usr/bin/env python3
"""
DC-Profile-Provision — 画像 provisioning（单租户 lead push 初始化）

画像（products + target_countries）的获取优先级：
  1. 优先：田总 memory 三层架构的企业画像（data/memory/<企业>/kb.json 的 profile）
  2. 兜底：getBasicInfo（orderRecords state=3 的 websiteCountry → 目标国家）

<企业> 键 = work/mio-api/.env 的 MIO_CDP_SUPPLIER_ID（动态获取，不是调用方传入）。
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def _load_env() -> None:
    """加载 work/mio-api/.env（不覆盖已有环境变量）。"""
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


def _env_supplier_id() -> str:
    """动态读取 .env 的 MIO_CDP_SUPPLIER_ID。"""
    return os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()


def _kb_profile(enterprise: str) -> dict:
    """读 KB 企业画像（data/memory/<enterprise>/kb.json 的 profile，只读）。"""
    try:
        from dc_kb_engine import KBEngine
        kb = KBEngine()._load(enterprise)
        if not kb:
            return {}
        return kb.get("profile") or {}
    except Exception:
        return {}


def _basic_info_countries(supplier_id: str) -> list[str]:
    """getBasicInfo 兜底：orderRecords 里 state=3（当前展会）的 websiteCountry → 目标国家（去重保序）。"""
    try:
        from dc_auto_campaign import get_basic_info
        open_id = os.environ.get("MIO_V_OPEN_ID", "")
        basic = get_basic_info(supplier_id, open_id=open_id)
        recs = basic.get("orderRecords") or []
        countries = []
        for r in recs:
            if r.get("state") != 3:
                continue
            c = (r.get("websiteCountry") or "").strip()
            if c and c not in countries:
                countries.append(c)
        return countries
    except Exception:
        return []


def provision_profile(supplier_id: str = "") -> dict:
    """画像 provisioning：KB 企业画像优先，getBasicInfo 兜底。

    <企业> 键 = MIO_CDP_SUPPLIER_ID（.env 动态获取）。supplier_id 参数仅作测试覆盖。
    """
    sid = (supplier_id or _env_supplier_id()).strip()
    if not sid:
        return {"products": [], "target_countries": [], "source": "none",
                "error": "MIO_CDP_SUPPLIER_ID 未配置"}

    # 1) 优先：memory 三层架构企业画像（data/memory/<sid>/kb.json）
    p = _kb_profile(sid)
    products = [str(x).strip() for x in (p.get("products") or []) if str(x).strip()]
    markets = [str(x).strip() for x in (p.get("target_markets") or []) if str(x).strip()]
    if products and markets:
        return {
            "products": [{"name": n} for n in products],
            "target_countries": [{"name": m, "aliases": []} for m in markets],
            "source": "kb",
        }

    # 2) 兜底：getBasicInfo → 目标国家（产品缺失，仅国家）
    countries = _basic_info_countries(sid)
    if countries:
        return {
            "products": products or [],
            "target_countries": [{"name": c, "aliases": []} for c in countries],
            "source": "getBasicInfo",
        }
    return {"products": [], "target_countries": [], "source": "none"}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="画像 provisioning 测试")
    ap.add_argument("--supplier-id", default="", help="默认用 .env 的 MIO_CDP_SUPPLIER_ID")
    args = ap.parse_args()
    print(json.dumps(provision_profile(args.supplier_id), ensure_ascii=False, indent=2))
