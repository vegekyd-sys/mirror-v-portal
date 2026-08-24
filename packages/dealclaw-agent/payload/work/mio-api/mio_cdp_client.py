#!/usr/bin/env python3
# =============================================================================
# DEPRECATED — 已废弃，勿再用于新代码。
#
# 买家搜索已改走 agent 的 buyer adapter：
#   dc_buyer_adapter.py  →  POST /agent/buyer/searchAIV2.json
#   dealclaw-find-buyers/scripts/search_aiv2.py
#
# 本文件是旧的米奥 CDP HMAC-SHA256 直连客户端，仅作历史参考保留。
# MIO_CDP_APP_SECRET / PPS_ID 凭证已从 .env 移除且未恢复，直接运行会鉴权失败。
# =============================================================================
"""
米奥兰特 OpenApi-CDP 客户端（DEPRECATED）
=========================================
封装 CDP 开放平台的 6 个接口，HMAC-SHA256 鉴权。

⚠️ 已废弃：买家搜索请改用 dc_buyer_adapter.py（POST /agent/buyer/searchAIV2.json）。
本模块保留仅作历史参考，请勿在新代码中 import。

用法:
    from mio_cdp_client import MioCdpClient

    client = MioCdpClient(app_key="tradechina", app_secret="...", env="test")
    result = client.search_company("ABC Company")
    result = client.search_ai_v2(keyword="LED light", supplier_id="...", pps_id="...")
    result = client.get_details("1234567890")
    result = client.list_exhibitions(page=1, size=10)
    result = client.search_onsite_buyers(exhibition_id="...", supplier_id="...", keywords=["LED"])
    result = client.get_contact(company_cdp_ids=["1234567890"])
"""

import hashlib
import hmac
import json
import time
import warnings
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

warnings.warn(
    "mio_cdp_client is deprecated — buyer search now goes through "
    "dc_buyer_adapter.py (POST /agent/buyer/searchAIV2.json). Do not import "
    "this module in new code.",
    DeprecationWarning,
    stacklevel=2,
)

# ── 环境配置 ──────────────────────────────────────────────
BASE_URLS = {
    "test": "https://testapidiscovery.datathink.com/meorient/openApi/cdp",
    "prod": "https://apidiscovery.datathink.com/meorient/openApi/cdp",
}


class MioCdpError(Exception):
    """CDP API 错误"""

    def __init__(self, code: int, msg: str, raw: Optional[dict] = None):
        self.code = code
        self.msg = msg
        self.raw = raw or {}
        super().__init__(f"CDP Error [{code}]: {msg}")


class MioCdpClient:
    """米奥 CDP 开放接口客户端"""

    def __init__(
        self,
        app_key: str,
        app_secret: str,
        env: str = "test",
        timeout: int = 30,
    ):
        if env not in BASE_URLS:
            raise ValueError(f"env must be one of {list(BASE_URLS.keys())}, got {env!r}")
        self.app_key = app_key
        self.app_secret = app_secret
        self.base_url = BASE_URLS[env]
        self.timeout = timeout

    # ── 签名 ──────────────────────────────────────────────

    def _sign(self, sign_content: str) -> tuple[int, str]:
        """生成 HMAC-SHA256 签名，返回 (timestamp_ms, sign_hex_upper)"""
        ts = int(time.time() * 1000)
        content = sign_content or ""
        message = f"{self.app_key}{ts}{content}"
        mac = hmac.new(
            self.app_secret.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        )
        return ts, mac.hexdigest().upper()

    # ── 请求 ──────────────────────────────────────────────

    def _post(self, path: str, data: dict, sign_content: str) -> dict:
        """统一 POST 请求"""
        ts, sign = self._sign(sign_content)

        body = {
            "appKey": self.app_key,
            "time": ts,
            "sign": sign,
            "data": data,
        }

        url = f"{self.base_url}{path}"
        req = Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json;charset=UTF-8"},
            method="POST",
        )

        try:
            with urlopen(req, timeout=self.timeout) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            body_bytes = e.read()
            try:
                raw = json.loads(body_bytes.decode("utf-8"))
            except Exception:
                raise MioCdpError(e.code, f"HTTP {e.code}: {body_bytes.decode('utf-8', errors='replace')[:200]}")
        except URLError as e:
            raise MioCdpError(-1, f"网络错误: {e.reason}")

        code = raw.get("code")
        if not raw.get("success"):
            raise MioCdpError(code if code is not None else -1, raw.get("msg", "未知错误"), raw)

        return raw.get("data", {})

    # ── 4.1 按公司名搜索 + 贸易统计 ─────────────────────────

    def search_company(self, company_name: str) -> list[dict]:
        """
        根据公司名称搜索买家并返回贸易统计。

        返回 list[dict]，每个元素含 buyerInfo + tradeOverView。
        未匹配时返回空列表 []。
        """
        data = {"companyName": company_name}
        sign_content = company_name or ""
        return self._post("/searchCompanyNameWithTrade.json", data, sign_content)

    # ── 4.2 AI 搜索 v2 ─────────────────────────────────────

    def search_ai_v2(
        self,
        supplier_id: str,
        pps_id: str,
        keyword: str = "",
        *,
        contact_id: Optional[str] = None,
        role_code: Optional[str] = None,
        tag_keyword: Optional[str] = None,
        profile_keyword: Optional[str] = None,
        page_num: int = 1,
        page_size: int = 10,
        invitation_flag: int = 0,
        check_flag: int = 0,
        un_lock_flag: int = 0,
        country: Optional[list[str]] = None,
        company_info: Optional[list[int]] = None,
        contact_info: Optional[list[int]] = None,
        company_attributes: Optional[list[str]] = None,
        annual_revenue_level: Optional[list[int]] = None,
        staff_size_level: Optional[list[int]] = None,
        trade_scale_level: Optional[list[int]] = None,
        features: Optional[list[int]] = None,
        sort_type: int = 2,
        search_similarity: bool = False,
        backend_param: Optional[str] = None,
    ) -> dict:
        """
        AI 智能搜索买家，支持多维度筛选与分页。

        必填：supplier_id, pps_id

        返回含 page (分页对象) 的响应 dict。
        """
        data: dict[str, Any] = {
            "supplierId": supplier_id,
            "ppsId": pps_id,
            "keyword": keyword,
            "pageNum": page_num,
            "pageSize": page_size,
            "invitationFlag": invitation_flag,
            "checkFlag": check_flag,
            "unLockFlag": un_lock_flag,
            "sortType": sort_type,
            "searchSimilarity": search_similarity,
        }

        if contact_id:
            data["contactId"] = contact_id
        if role_code:
            data["roleCode"] = role_code
        if tag_keyword:
            data["tagKeyword"] = tag_keyword
        if profile_keyword:
            data["profileKeyword"] = profile_keyword
        if country:
            data["country"] = country
        if company_info:
            data["companyInfo"] = company_info
        if contact_info:
            data["contactInfo"] = contact_info
        if company_attributes:
            data["companyAttributes"] = company_attributes
        if annual_revenue_level:
            data["annualRevenueLevel"] = annual_revenue_level
        if staff_size_level:
            data["staffSizeLevel"] = staff_size_level
        if trade_scale_level:
            data["tradeScaleLevel"] = trade_scale_level
        if features:
            data["features"] = features
        if backend_param:
            data["backendParam"] = backend_param

        sign_content = keyword or ""
        return self._post("/searchAIV2.json", data, sign_content)

    # ── 4.3 按 CDP ID 获取详情 ──────────────────────────────

    def get_details(self, company_cdp_id: str) -> list[dict]:
        """
        按 CDP ID 查询买家详情及贸易统计。

        返回 list[dict]，每个元素含 buyerInfo + tradeOverView。
        """
        data = {"companyCdpId": company_cdp_id}
        sign_content = company_cdp_id or ""
        return self._post("/getCdpDetails.json", data, sign_content)

    # ── 4.4 展会列表 ────────────────────────────────────────

    def list_exhibitions(
        self,
        page: int = 1,
        size: int = 10,
        states: Optional[list[int]] = None,
    ) -> dict:
        """
        分页查询展会列表。

        states: 0=未发布 1=未开始 2=展前 3=展中 4=展后 5=结束
        返回分页对象 {records, total, size, current, pages}
        """
        data: dict[str, Any] = {"page": page, "size": size}
        if states is not None:
            data["states"] = states
        sign_content = ""
        return self._post("/selectAll.json", data, sign_content)

    # ── 4.5 现场买家搜索 ────────────────────────────────────

    def search_onsite_buyers(
        self,
        exhibition_id: str,
        supplier_id: str,
        *,
        keywords: Optional[list[str]] = None,
        exact_match_state: int = 0,
        page_no: int = 1,
        page_size: int = 10,
    ) -> dict:
        """
        按展会与关键词搜索到场买家。

        必填：exhibition_id, supplier_id
        返回分页对象 {records, total, size, current, pages}
        """
        data: dict[str, Any] = {
            "exhibitionId": exhibition_id,
            "supplierId": supplier_id,
            "exactMatchState": exact_match_state,
            "pageNo": page_no,
            "pageSize": page_size,
        }
        if keywords:
            data["keywords"] = keywords

        sign_content = exhibition_id or ""
        return self._post("/onsite/buyer/search", data, sign_content)

    # ── 4.6 AI Search 获取联系人详情 ──────────────────────────

    def get_contact(
        self,
        company_cdp_ids: list[str],
        *,
        page_num: int = 1,
        page_size: int = 10,
        is_kp: Optional[bool] = None,
        is_this_exhibition_pre_buyer: Optional[bool] = None,
        is_previous_on_exhibition_buyer: Optional[bool] = None,
    ) -> dict:
        """
        按公司 CDP ID 分页查询联系人详情。

        返回 {page: {records, total, ...}, thisExhibitionPreBuyerCn, previousOnExhibitionBuyerCn}
        records 元素含: contactName, jobTitle, emailsValid, mobilesValid,
                       whatsappsValid, isKp, 等
        """
        data: dict[str, Any] = {
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

        sign_content = ""
        return self._post("/AiSearchGetCdpContact.json", data, sign_content)


# ── 简易测试 ──────────────────────────────────────────────
if __name__ == "__main__":
    import os

    app_key = os.environ.get("MIO_CDP_APP_KEY", "tradechina")
    app_secret = os.environ.get("MIO_CDP_APP_SECRET", "")
    env = os.environ.get("MIO_CDP_ENV", "test")

    if not app_secret:
        print("请设置环境变量 MIO_CDP_APP_SECRET")
        exit(1)

    client = MioCdpClient(app_key=app_key, app_secret=app_secret, env=env)

    # 测试 1: 公司搜索
    print("=== search_company ===")
    try:
        result = client.search_company("")
        print(json.dumps(result, indent=2, ensure_ascii=False)[:500])
    except MioCdpError as e:
        print(f"Error: {e}")

    # 测试 2: 展会列表
    print("\n=== list_exhibitions (展中) ===")
    try:
        result = client.list_exhibitions(page=1, size=5, states=[3])
        print(f"total={result.get('total')}, records={len(result.get('records', []))}")
    except MioCdpError as e:
        print(f"Error: {e}")
