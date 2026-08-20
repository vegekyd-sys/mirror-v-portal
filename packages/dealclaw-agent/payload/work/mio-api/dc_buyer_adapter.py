#!/usr/bin/env python3
"""DC 买家搜索适配器。

走最新买家 skill（blade-agent-adapter /agent/buyer/*），
鉴权用 X-Feishu-Open-Id + X-Supplier-Id header（不再用旧 CDP 的 HMAC appKey/sign）。
对外接口：search / get_contacts / get_details / format_results，
格式化函数（format_record / extract_purchase_tags 等）是纯函数。
"""

from __future__ import annotations

import os
import re
import sys
from typing import Any, Optional

# 复用最新买家 skill 的公共客户端（_client.py：post_json / env）
_HERE = os.path.dirname(os.path.abspath(__file__))
_SKILL_SCRIPTS = os.path.normpath(
    os.path.join(_HERE, "..", "..", "skills", "dealclaw-find-buyers", "scripts")
)
if _SKILL_SCRIPTS not in sys.path:
    sys.path.insert(0, _SKILL_SCRIPTS)

from _client import post_json, env  # noqa: E402

DEFAULT_BASE_URL = "https://micro.tradechina.com/blade-agent-adapter"


def _post(path: str, body: dict, supplier_id: Optional[str] = None) -> dict:
    """统一调用 blade-agent-adapter。失败返回 {"error": ...}，成功返回 data 字段。"""
    resp = post_json(
        base_url=env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL),
        path=path,
        body=body,
        open_id=env("MIO_V_OPEN_ID", ""),
        supplier_id=supplier_id or env("MIO_CDP_SUPPLIER_ID", ""),
        timeout=60,
    )
    if not resp.get("success"):
        return {"error": resp.get("msg") or "未知错误", "code": resp.get("code")}
    return resp.get("data") or {}


def search(
    keyword: Optional[str] = None,
    *,
    profile_keyword: Optional[str] = None,
    tag_keyword: Optional[str] = None,
    country: Optional[list] = None,
    page_num: int = 1,
    page_size: int = 10,
    company_attributes: Optional[list] = None,
    company_info: Optional[list] = None,
    contact_info: Optional[list] = None,
    annual_revenue_level: Optional[list] = None,
    staff_size_level: Optional[list] = None,
    trade_scale_level: Optional[list] = None,
    invitation_flag: Optional[int] = None,
    check_flag: Optional[int] = None,
    un_lock_flag: Optional[int] = None,
    sort_type: int = 2,
    search_similarity: bool = False,
    backend_param: Optional[str] = None,
    supplier_id: Optional[str] = None,
) -> dict:
    """searchAIV2 搜买家。

    keyword        匹配公司名（→ companyName）
    tag_keyword    匹配采购品类标签（→ tagKeyword，最贴近实际采购行为）
    profile_keyword 匹配公司简介（→ profileKeyword）
    """
    data: dict = {
        "pageNum": page_num,
        "pageSize": page_size,
        "sortType": sort_type,
        "searchSimilarity": search_similarity,
    }
    if keyword:
        data["companyName"] = keyword
    if profile_keyword:
        data["profileKeyword"] = profile_keyword
    if tag_keyword:
        data["tagKeyword"] = tag_keyword
    if country:
        data["countries"] = country
    if company_attributes:
        data["companyAttributes"] = company_attributes
    if company_info:
        data["companyInfo"] = company_info
    if contact_info:
        data["contactInfo"] = contact_info
    if annual_revenue_level:
        data["annualRevenueLevel"] = annual_revenue_level
    if staff_size_level:
        data["staffSizeLevel"] = staff_size_level
    if trade_scale_level:
        data["tradeScaleLevel"] = trade_scale_level
    if invitation_flag is not None:
        data["invitationFlag"] = invitation_flag
    if check_flag is not None:
        data["checkFlag"] = check_flag
    if un_lock_flag is not None:
        data["unLockFlag"] = un_lock_flag
    if backend_param:
        data["backendParam"] = backend_param

    return _post("/agent/buyer/searchAIV2.json", data, supplier_id)


def get_details(company_cdp_id: str) -> dict:
    """获取 CDP 买家详情（含 tradeOverView 贸易统计、四级采购标签）。"""
    return _post("/agent/buyer/getCdpDetails.json", {"companyCdpId": company_cdp_id})


def get_contacts(
    company_cdp_ids: list,
    *,
    page_num: int = 1,
    page_size: int = 10,
    is_kp: Optional[bool] = None,
    is_this_exhibition_pre_buyer: Optional[bool] = None,
    is_previous_on_exhibition_buyer: Optional[bool] = None,
) -> dict:
    """获取 CDP 联系人详情（aiSearchGetCdpContact）。

    返回的是**真实**邮箱/手机/WhatsApp，不需要 Apollo reveal，也不消耗 Apollo 额度。
    入参是 companyCdpId 而非域名，所以没有官网的买家也能查。
    """
    data: dict = {
        "companyCdpIds": company_cdp_ids,
        "pageNum": page_num,
        "pageSize": page_size,
    }
    if is_kp is not None:
        data["isKp"] = is_kp
    if is_this_exhibition_pre_buyer is not None:
        data["isThisExhibitionPreBuyer"] = is_this_exhibition_pre_buyer
    if is_previous_on_exhibition_buyer is not None:
        data["isPreviousOnExhibitionBuyer"] = is_previous_on_exhibition_buyer
    return _post("/agent/buyer/aiSearchGetCdpContact.json", data)


# ── 格式化输出（纯函数）──────────

CONTACT_FLAG_FIELDS = ("emailsValid", "mobilesValid", "phonesValid", "whatsappsValid")


def strip_html(text: Optional[str]) -> str:
    """去掉搜索高亮的 <em> 标签。"""
    if not text:
        return ""
    return re.sub(r"</?em>", "", text)


def has_any_contact(rec: dict) -> bool:
    """判断记录是否至少有一种联系方式。"""
    return any(rec.get(f) not in (None, "", 0, [], "0") for f in CONTACT_FLAG_FIELDS)


def extract_purchase_tags(rec: dict) -> list:
    """从 sortedT2TagInfo 抽出采购品类标签名。t4（精确）在前、t2（宽泛）在后。"""
    out = []
    for t2 in rec.get("sortedT2TagInfo") or []:
        if not isinstance(t2, dict):
            continue
        for t4 in (t2.get("tagInfo") or []):
            if isinstance(t4, dict) and t4.get("nameEn"):
                out.append({"name": t4["nameEn"], "nameCn": t4.get("nameCn"),
                            "level": 4, "score": round(t4.get("score") or 0, 3)})
        if t2.get("nameEn"):
            out.append({"name": t2["nameEn"], "nameCn": t2.get("nameCn"),
                        "level": 2, "score": round(t2.get("score") or 0, 3)})
    out.sort(key=lambda t: (-t["level"], -t["score"]))
    return out


def format_record(rec: dict) -> dict:
    """将 searchAIV2 单条记录转为 DC-LS 表格行。"""
    return {
        "companyName": strip_html(rec.get("companyName", "")),
        "companyCdpId": rec.get("companyCdpId", ""),
        "country": rec.get("country", ""),
        "countryCnName": rec.get("countryCnName", ""),
        "website": rec.get("website", ""),
        "companySize": rec.get("companySize", ""),
        "companyRevenue": rec.get("companyRevenue", ""),
        "tradeVl": rec.get("tradeVl", 0),
        "tradeCnt": rec.get("tradeCnt", 0),
        "companyProfile": strip_html(rec.get("companyProfile", "")),
        "buyerIntroduce": strip_html(rec.get("buyerIntroduce", "")),
        "companyAttributes": rec.get("companyAttributes") or [],
        "hasContact": has_any_contact(rec),
        "purchaseTags": extract_purchase_tags(rec),
    }


def format_results(
    raw: dict,
    term: str,
    country: Optional[list],
    field: str = "keyword",
    require_contact: bool = False,
) -> dict:
    """将 searchAIV2 原始响应转为 DC-LS 标准输出。"""
    if "error" in raw:
        return {"status": "error", "message": raw["error"]}

    page = raw.get("page") or {}
    records = page.get("records") or []
    total = page.get("total", 0)

    formatted = [format_record(r) for r in records]
    dropped = 0
    if require_contact:
        before = len(formatted)
        formatted = [r for r in formatted if r["hasContact"]]
        dropped = before - len(formatted)

    country_str = ", ".join(country) if country else "全部国家"
    summary = f"📊 {term} [{field}] ({country_str}) — {len(formatted)} 条入库 | 共 {total} 条匹配"
    if dropped:
        summary += f" (过滤无联系方式 {dropped} 条)"

    out = {
        "status": "success",
        "summary": summary,
        "searchTerm": term,
        "searchField": field,
        "country": country or [],
        "records": formatted,
        "pagination": {
            "total": total,
            "allTotal": raw.get("allTotal", total),
            "current": page.get("current", 1),
            "size": page.get("size", 10),
            "hasNext": raw.get("hasNext", False),
            "backendParam": raw.get("backendParam"),
        },
    }
    if require_contact:
        out["contactFilter"] = {"dropped": dropped, "kept": len(formatted)}
    # 兼容旧调用方
    out["keyword"] = term
    return out
