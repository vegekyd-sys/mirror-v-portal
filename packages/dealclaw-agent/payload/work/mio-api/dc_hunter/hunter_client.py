#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hunter.io 客户端（走内部 blade-agent-adapter 网关）

封装 Hunter.io 核心端点，底层走 https://micro.tradechina.com/blade-agent-adapter 的
/agent/hunter/* 端点，鉴权用 X-Feishu-Open-Id + X-Supplier-Id header（与 CDP 一致），
不再用 HUNTER_API_KEY，防止 key 泄漏。

对外接口与旧版兼容：
  domain_search    域名搜邮箱
  email_finder     邮箱查找（域名 + 姓名 → 最可能邮箱）
  email_verifier   邮箱验证
  people_find      人富化
  companies_find   公司富化
  discover         搜公司

环境变量（不再需要 HUNTER_API_KEY）:
  MIO_V_OPEN_ID — 飞书数字人 open_id（X-Feishu-Open-Id）
  MIO_CDP_SUPPLIER_ID — 供应商 id（X-Supplier-Id）
  MEO_ADAPTER_BASE_URL — 网关地址（默认 https://micro.tradechina.com/blade-agent-adapter）
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, Optional

# ── 复用 find-buyers 公共客户端（_client.py：post_json / env，带 X-Feishu-Open-Id / X-Supplier-Id header）──
_HERE = os.path.dirname(os.path.abspath(__file__))
_SKILL_SCRIPTS = os.path.normpath(os.path.join(
    _HERE, "..", "..", "..", "skills", "dealclaw-find-buyers", "scripts"))
if not os.path.isdir(_SKILL_SCRIPTS):
    _SKILL_SCRIPTS = os.path.normpath(os.path.join(
        _HERE, "..", "..", "skills", "dealclaw-find-buyers", "scripts"))
if _SKILL_SCRIPTS not in sys.path:
    sys.path.insert(0, _SKILL_SCRIPTS)

from _client import post_json, env  # noqa: E402

DEFAULT_BASE_URL = "https://micro.tradechina.com/blade-agent-adapter"

# ── 内部网关端点映射 ─────────────────────────────────────────
# 旧 function_name → (gateway path, body 字段映射, 需转逗号串的字段)
_GATEWAY: Dict[str, Dict[str, Any]] = {
    "domain_search": {
        "path": "/agent/hunter/domainSearch.json",
        "fields": {
            "domain": "domain", "company": "company", "limit": "limit", "offset": "offset",
            "type": "type", "seniority": "seniority", "department": "department",
            "decision_maker": "decisionMaker", "required_field": "requiredField",
            "verification_status": "verificationStatus",
        },
    },
    "email_finder": {
        "path": "/agent/hunter/emailFinder.json",
        "fields": {
            "domain": "domain", "company": "company", "linkedin_handle": "linkedinHandle",
            "first_name": "firstName", "last_name": "lastName", "full_name": "fullName",
            "max_duration": "maxDuration",
        },
    },
    "email_verifier": {
        "path": "/agent/hunter/emailVerifier.json",
        "fields": {"email": "email"},
    },
    "people_find": {
        "path": "/agent/hunter/peopleFind.json",
        "fields": {"email": "email", "linkedin_handle": "linkedinHandle"},
    },
    "companies_find": {
        "path": "/agent/hunter/companiesFind.json",
        "fields": {"domain": "domain", "company": "company"},
    },
    "discover": {
        "path": "/agent/hunter/discover.json",
        "fields": {
            "query": "query", "industry": "industry", "headcount": "headcount",
            "company_type": "companyType", "country": "country", "limit": "limit",
        },
        "csv_fields": {"industry", "headcount", "companyType", "country"},
    },
}


def _to_csv(v: Any) -> Any:
    """列表/元组 → 逗号分隔字符串（网关枚举字段用）；标量原样返回。"""
    if isinstance(v, (list, tuple)):
        return ",".join(str(x) for x in v)
    return v


def _transform_body(cfg: Dict[str, Any], body: dict) -> dict:
    """snake_case 入参 → 网关 camelCase body。None/未知字段丢弃。"""
    out: Dict[str, Any] = {}
    fields = cfg.get("fields", {})
    csv_fields = cfg.get("csv_fields", set())
    for k, v in body.items():
        if v is None:
            continue
        ck = fields.get(k)
        if ck is None:
            continue
        out[ck] = _to_csv(v) if ck in csv_fields else v
    return out


class HunterError(Exception):
    """缺 key / 参数错等可预见的错误。"""


class HunterClient:
    def __init__(self, api_key: Optional[str] = None, timeout: int = 30):
        # api_key 参数保留以兼容旧调用方（_hunter.py 的 --api-key），底层已改走网关，忽略。
        self.base_url = env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL)
        self.open_id = env("MIO_V_OPEN_ID", "") or ""
        self.supplier_id = env("MIO_CDP_SUPPLIER_ID", "") or ""
        self.timeout = timeout
        if not self.open_id or not self.supplier_id:
            raise HunterError("缺少 MIO_V_OPEN_ID / MIO_CDP_SUPPLIER_ID，请在 .env 配置后重试")

    def _call(self, function_name: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """统一调网关。返回 {success, data, meta} / {success, error}，与旧版契约一致。"""
        cfg = _GATEWAY.get(function_name)
        if cfg is None:
            return {"success": False,
                    "error": {"code": "UNSUPPORTED", "detail": "未映射到内部网关: " + function_name}}
        gw_body = _transform_body(cfg, body)
        resp = post_json(base_url=self.base_url, path=cfg["path"], body=gw_body,
                         open_id=self.open_id, supplier_id=self.supplier_id, timeout=self.timeout)
        if not resp.get("success"):
            msg = resp.get("msg") or ""
            if ": " in msg:
                code, detail = msg.split(": ", 1)
            else:
                code, detail = str(resp.get("code", "?")), msg or "(无 detail)"
            return {"success": False, "error": {"code": code, "detail": detail}}
        data = resp.get("data") or {}
        return {"success": True, "data": data.get("data"), "meta": data.get("meta")}

    # ── 核心端点 ────────────────────────────────────────────

    def domain_search(self, domain: Optional[str] = None, company: Optional[str] = None,
                      limit: int = 10, offset: int = 0, type: Optional[str] = None,
                      seniority: Optional[str] = None, department: Optional[str] = None,
                      decision_maker: Optional[bool] = None, required_field: Optional[str] = None,
                      verification_status: Optional[str] = None) -> Dict[str, Any]:
        """域名搜邮箱：某公司所有人的邮箱 + 来源。domain 优先于 company。"""
        return self._call("domain_search", {
            "domain": domain, "company": company, "limit": limit, "offset": offset,
            "type": type, "seniority": seniority, "department": department,
            "decision_maker": decision_maker, "required_field": required_field,
            "verification_status": verification_status,
        })

    def email_finder(self, domain: Optional[str] = None, company: Optional[str] = None,
                     linkedin_handle: Optional[str] = None, first_name: Optional[str] = None,
                     last_name: Optional[str] = None, full_name: Optional[str] = None,
                     max_duration: Optional[int] = None) -> Dict[str, Any]:
        """邮箱查找：域名 + 姓名 → 最可能邮箱。找不到不扣费。"""
        return self._call("email_finder", {
            "domain": domain, "company": company, "linkedin_handle": linkedin_handle,
            "first_name": first_name, "last_name": last_name, "full_name": full_name,
            "max_duration": max_duration,
        })

    def email_verifier(self, email: str) -> Dict[str, Any]:
        """邮箱验证：可投递性 / score / smtp。"""
        return self._call("email_verifier", {"email": email})

    def people_find(self, email: Optional[str] = None,
                    linkedin_handle: Optional[str] = None) -> Dict[str, Any]:
        """人富化：email / linkedin → 个人信息（姓名/职位/公司/地点）。"""
        return self._call("people_find", {"email": email, "linkedin_handle": linkedin_handle})

    def companies_find(self, domain: Optional[str] = None,
                       company: Optional[str] = None) -> Dict[str, Any]:
        """公司富化：domain / company → 公司信息。"""
        return self._call("companies_find", {"domain": domain, "company": company})

    def discover(self, query: Optional[str] = None,
                 filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """搜公司：自然语言 query 或结构化 filters（industry/headcount/company_type/country）。

        旧 Hunter 的嵌套 filter 结构会拍平成网关的扁平字段（逗号分隔）。
        """
        body: Dict[str, Any] = {}
        if query:
            body["query"] = query
        if filters:
            ind = filters.get("industry")
            if isinstance(ind, dict):
                ind = ind.get("include")
            if ind:
                body["industry"] = ind
            hc = filters.get("headcount")
            if hc:
                body["headcount"] = hc
            ct = filters.get("company_type")
            if isinstance(ct, dict):
                ct = ct.get("include")
            if ct:
                body["company_type"] = ct
            hq = filters.get("headquarters_location")
            if isinstance(hq, dict):
                hq = hq.get("include")
            if hq:
                body["country"] = [x.get("country") for x in hq
                                   if isinstance(x, dict) and x.get("country")]
            if filters.get("limit"):
                body["limit"] = int(filters["limit"])
        return self._call("discover", body)
