#!/usr/bin/env python3
"""find_buyers_v2.normalize — 纯函数：归一化 / 字段检查 / 展会ID核验 / 确定性去重。

无网络、无文件、无副作用；同输入同输出（replay 可复现）。
归一化口径与 legacy 单一来源对齐：复用 dc_ls_store.normalize_domain /
normalize_company_name；导入失败时用等价内联实现兜底（并由测试比对一致性）。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Iterable, Optional

_HERE = Path(__file__).resolve().parent
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

try:  # 单一来源：legacy 的归一化实现（同目录）
    from dc_ls_store import normalize_company_name as _norm_company
    from dc_ls_store import normalize_domain as _norm_domain
except Exception:  # pragma: no cover - 兜底
    def _norm_domain(domain: str) -> str:
        d = str(domain or "").strip().lower()
        d = re.sub(r"^https?://", "", d)
        d = d.split("/")[0].split("?")[0].split("#")[0].split(":")[0]
        d = re.sub(r"^www\.", "", d)
        return d.strip(".")

    def _norm_company(name: str) -> str:
        return re.sub(r"[^A-Z0-9]", "", str(name or "").upper())


COMPANY_KEYS = ("companyName", "company", "company_name", "name")
WEBSITE_KEYS = ("companyWebsite", "website", "companyDomain", "domain")
COUNTRY_KEYS = ("country", "countryCode")
PROFILE_KEYS = ("companyProfile", "profile", "companyIntro", "description", "简介")
PRODUCT_KEYS = ("purchaseTags", "productList", "matchedProducts", "tags", "关注产品")
BUYER_TYPE_KEYS = ("companyAttributes", "buyerType", "buyerTypes", "buyerTag", "buyer_tags")
SIZE_KEYS = ("staffSizeLevel", "tradeScaleLevel", "annualRevenueLevel", "scale", "size")
EXHIBITION_KEYS = ("preExhibitionIds", "preExhibitionId", "exhibitionIds")
# 真实响应里的分数字段（2026-09-13 核实：响应里没有 AI匹配分）。
# 口径（田耕郡 2026-09-13 定）：**主分用五维综合分 fiveCompositeScore（0–5）**，
# totalQualityScore / fiveRecommend / fiveValuable / fiveActive / fiveComplete 作辅助参考。
# 实测该字段高度压缩（p50≈3.04、p75≈3.08、p90≈3.10、≥3.5 仅 4%），
# 因此质量线用**分位数**表达，不用绝对分当阈值。
SCORE_KEYS = ("fiveCompositeScore", "totalQualityScore", "fiveMatchScore",
              "AI匹配分", "ai_score", "aiMatchScore", "matchScore")
SCORE_FIELD_CANDIDATES = ("totalQualityScore", "fiveCompositeScore", "fiveMatchScore",
                          "fiveRecommendScore", "fiveValuableScore", "fiveActiveScore",
                          "fiveCompleteScore")
INDUSTRY_KEYS = ("industry", "industryName", "行业")


def pick(rec: dict, keys: Iterable[str]) -> str:
    """取第一个非空字段（列表按逗号拼接），缺失返回空串。"""
    for k in keys:
        v = rec.get(k)
        if v is None:
            continue
        if isinstance(v, (list, tuple)):
            joined = ", ".join(str(x).strip() for x in v if str(x).strip())
            if joined:
                return joined
            continue
        s = str(v).strip()
        if s:
            return s
    return ""


def as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(x).strip() for x in value if str(x).strip()]
    s = str(value).strip()
    if not s:
        return []
    return [p.strip() for p in re.split(r"[,;，；|]", s) if p.strip()]


def pick_list(rec: dict, keys: Iterable[str]) -> list[str]:
    for k in keys:
        if rec.get(k) not in (None, ""):
            out = as_list(rec.get(k))
            if out:
                return out
    return []


def to_float(value) -> Optional[float]:
    """只有真实数值才返回；缺失/非法 → None（不补 0）。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except ValueError:
        return None


def normalize_record(rec: dict, *, page: Optional[int] = None,
                     position: Optional[int] = None) -> dict:
    company = pick(rec, COMPANY_KEYS)
    website = pick(rec, WEBSITE_KEYS)
    return {
        "company": company,
        "website": website,
        "domain": _norm_domain(website),
        "country": pick(rec, COUNTRY_KEYS).upper(),
        "profile": pick(rec, PROFILE_KEYS),
        "industry": pick(rec, INDUSTRY_KEYS),
        "products": pick_list(rec, PRODUCT_KEYS),
        "buyer_type": pick(rec, BUYER_TYPE_KEYS),
        "size": pick(rec, SIZE_KEYS),
        "exhibitions": pick_list(rec, EXHIBITION_KEYS),
        "score": to_float(pick(rec, SCORE_KEYS)),
        "scores_raw": {k: v for k, v in
                       ((k, to_float(rec.get(k))) for k in SCORE_FIELD_CANDIDATES)
                       if v is not None},
        "page": page,
        "position": position,
        "key_company": _norm_company(company),
        "key_domain": _norm_domain(website),
    }


def field_issues(norm: dict) -> list[str]:
    """字段检查：只标问题，不因此剔除（缺字段不等于不合适）。"""
    issues = []
    if not norm.get("company"):
        issues.append("缺公司名")
    if not norm.get("country"):
        issues.append("缺国家")
    if not norm.get("buyer_type"):
        issues.append("缺买家类型")
    if not norm.get("products"):
        issues.append("缺匹配产品")
    if not norm.get("key_domain") and not norm.get("key_company"):
        issues.append("缺去重键")
    return issues


def matches_exhibition(norm: dict, target_ids: Iterable[str]) -> bool:
    """展会ID核验：target 为空表示不按展会过滤，恒为真。"""
    targets = {str(t).strip() for t in (target_ids or []) if str(t).strip()}
    if not targets:
        return True
    return bool(targets & set(norm.get("exhibitions") or []))


def dedupe(norms: list[dict]) -> tuple[list[dict], list[dict]]:
    """确定性去重：**同域名或同名**即视为重复（与 legacy 的 website/company 双键口径一致）；

    保留分数最高者，同分取更靠前（page, position）。
    """
    def rank(n: dict):
        score = n.get("score")
        return (
            -(score if score is not None else -1.0),
            n.get("page") if n.get("page") is not None else 10 ** 6,
            n.get("position") if n.get("position") is not None else 10 ** 6,
            n.get("company") or "",
        )

    kept: list[dict] = []
    dropped: list[dict] = []
    seen: set[str] = set()
    for n in sorted(norms, key=rank):
        dk = f"domain:{n['key_domain']}" if n.get("key_domain") else ""
        ck = f"company:{n['key_company']}" if n.get("key_company") else ""
        if not dk and not ck:
            dropped.append({**n, "excluded_reason": "缺去重键"})
            continue
        if (dk and dk in seen) or (ck and ck in seen):
            dropped.append({**n, "excluded_reason": "重复(同域名/同名)"})
            continue
        if dk:
            seen.add(dk)
        if ck:
            seen.add(ck)
        kept.append(n)
    return kept, dropped


def rank_for_delivery(norms: list[dict]) -> list[dict]:
    """交付排序：分数降序（None 最后），同分按 (page, position) 稳定排序。"""
    def key(n: dict):
        return (0 if n.get("score") is not None else 1,
                -(n.get("score") or 0.0),
                n.get("page") if n.get("page") is not None else 10 ** 6,
                n.get("position") if n.get("position") is not None else 10 ** 6)
    return sorted(norms, key=key)
