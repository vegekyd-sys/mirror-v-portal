#!/usr/bin/env python3
# -- coding: UTF-8 --
"""dc_onsite_touch.py — 展中触达清单准备（到场买家 + 展位号 + 自我介绍素材）

给 dealclaw-onsite-touch（展中到场触达）做数据准备：
  1. 确定当前开展展会
  2. 拉到场买家：已邀约到场（notice-list msg-type 3）/ 现场推荐（buyer onsite）
  3. 拉展位号（win-contracts，字段名待真实数据确认，先占位多字段兼容）
  4. 拉自我介绍/亮点素材（kb.json profile）
  5. 汇总成「展中触达清单」JSON，供 Agent 写邮件 + Founder Direct 发送

用法：
  python3 dc_onsite_touch.py run [--company-id <sid>] [--exhibition-id <id>] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _tenant_env import load_tenant_env

load_tenant_env()

try:
    from enterprise_ids import canonical_company_id
except ImportError:  # 兜底
    def canonical_company_id(cid: str) -> str:
        return (cid or "").strip() or os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()

# 复用现成 fetch
from monitor_buyer_onsite import fetch_onsite_notices  # noqa: E402  notice-list msg-type 3
from dc_onsite_recommend import current_exhibitions, fetch_onsite, load_products  # noqa: E402


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _xiaoyuan(*args: str) -> dict:
    cmd = [
        "xiaoyuan",
        "--open-id", os.environ.get("MIO_V_OPEN_ID", ""),
        "--supplier-id", os.environ.get("MIO_CDP_SUPPLIER_ID", ""),
        *args,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    try:
        return json.loads(proc.stdout or proc.stderr)
    except Exception:
        return {"_raw": (proc.stdout or proc.stderr)[:500]}


# ── 展位号（win-contracts）────────────────────────────────────

# TODO: 展位号字段名待真实数据确认，先多字段名兼容占位
BOOTH_KEYS = ("booth", "boothNumber", "boothNo", "standNo", "standNumber", "boothNum", "展位号", "pavilionBooth")


def fetch_booth(exhibition_id: str) -> str:
    """拉展位号：company win-contracts --exhibition-id <id>。"""
    resp = _xiaoyuan("company", "win-contracts", "--exhibition-id", exhibition_id)
    data = (resp.get("response", {}).get("data") or {})
    recs = data if isinstance(data, list) else (data.get("records") or data.get("list") or [])
    if not recs:
        return ""
    r = recs[0]
    for k in BOOTH_KEYS:
        v = r.get(k)
        if v:
            return str(v).strip()
    return ""


# ── 自我介绍 / 亮点素材 ───────────────────────────────────────

def load_profile(company_id: str) -> dict:
    p = _workspace_root() / "data" / "memory" / company_id / "kb.json"
    if not p.exists():
        return {}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}
    prof = d.get("profile", {}) or {}
    return {
        "name": prof.get("name") or prof.get("name_en") or "",
        "products": prof.get("products") or prof.get("product") or [],
        "usp": prof.get("usp") or "",
        "certifications": prof.get("certifications") or "",
        "scale": prof.get("scale") or "",
        "business_model": prof.get("business_model") or "",
    }


# ── 邮箱提取（多字段兼容，字段名待真实数据确认）─────────────────

EMAIL_KEYS = ("email", "emails", "contactEmail", "firstContactEmails", "buyerEmail", "contactEmails")


def _email_of(rec: dict) -> str:
    for k in EMAIL_KEYS:
        v = rec.get(k)
        if isinstance(v, list) and v:
            return str(v[0]).strip()
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _name_of(rec: dict) -> str:
    for k in ("company", "companyName", "buyerCompanyName", "name", "title"):
        v = rec.get(k)
        if v:
            return str(v).strip()
    return ""


# ── 汇总展中触达清单 ───────────────────────────────────────────

def build_touch_list(company_id: str, exhibition_id: str = "") -> dict:
    profile = load_profile(company_id)
    keywords = load_products(company_id)

    if exhibition_id:
        exhs = [{"exhibitionId": exhibition_id, "name": "", "country": "",
                 "inshowStartDate": "", "inshowEndDate": ""}]
    else:
        exhs = current_exhibitions()
    if not exhs:
        return {"action": "onsite_touch", "status": "no_exhibition", "items": []}

    items = []
    for exh in exhs:
        booth = fetch_booth(exh["exhibitionId"])
        invited = fetch_onsite_notices()  # 已邀约到场（notice-list msg-type 3）
        recommended = fetch_onsite(exh["exhibitionId"], keywords)  # 现场推荐（buyer onsite）

        items.append({
            "exhibitionId": exh["exhibitionId"],
            "name": exh.get("name") or "",
            "booth": booth,
            "invited_onsite": [
                {"company": _name_of(r), "email": _email_of(r), "raw_keys": sorted(r.keys())}
                for r in invited
            ],
            "recommended_onsite": [
                {"company": _name_of(r), "email": _email_of(r), "raw_keys": sorted(r.keys())}
                for r in recommended
            ],
        })

    return {
        "action": "onsite_touch",
        "company_id": company_id,
        "profile": profile,
        "items": items,
    }


def main() -> None:
    p = argparse.ArgumentParser(description="小元-展中触达清单准备")
    p.add_argument("action", choices=["run"], help="生成触达清单")
    p.add_argument("--company-id", default=None, help="企业 ID（缺省读 MIO_CDP_SUPPLIER_ID）")
    p.add_argument("--exhibition-id", default="", help="指定展会 ID（跳过自动判断当前展会）")
    args = p.parse_args()

    company_id = canonical_company_id(args.company_id)
    if not company_id:
        raise SystemExit("[dc_onsite_touch] 无法确定企业 ID")
    result = build_touch_list(company_id, args.exhibition_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
