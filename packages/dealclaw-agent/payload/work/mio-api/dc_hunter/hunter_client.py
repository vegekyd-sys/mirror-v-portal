#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hunter.io API v2 客户端 — 邮箱查找/验证/富化/公司发现

参考 dc_arounddeal 的接入方式。封装 Hunter.io 核心端点：
  domain_search    域名搜邮箱（某公司所有人的邮箱 + 来源）
  email_finder     邮箱查找（域名 + 姓名 → 最可能邮箱）
  email_verifier   邮箱验证（可投递性 / score / smtp）
  people_find      人富化（email / linkedin → 个人信息）
  companies_find   公司富化（domain / company → 公司信息）
  discover         搜公司（自然语言 query 或过滤条件）

鉴权：HUNTER_API_KEY（走 query param `api_key`）。
环境变量：HUNTER_API_KEY（从 .env 自动加载）。

用法:
    from hunter_client import HunterClient
    c = HunterClient()
    c.domain_search(domain="stripe.com")
    c.email_finder(domain="stripe.com", first_name="Alexis", last_name="Ohanian")
    c.email_verifier(email="patrick@stripe.com")
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE_URL = "https://api.hunter.io/v2/"

# ── .env 加载（向上遍历目录树，复用 dc_arounddeal 的写法）────
_ENV_DIRS: List[str] = []
_d = os.path.dirname(os.path.abspath(__file__))
while _d and _d != os.path.dirname(_d):
    _ENV_DIRS.append(os.path.join(_d, "work", "mio-api"))
    _ENV_DIRS.append(_d)
    _d = os.path.dirname(_d)
_ENV_DIRS.append(os.path.join(os.environ.get("HOME", ""), ".openclaw"))
if os.environ.get("HUNTER_ENV_DIR"):
    _ENV_DIRS.insert(0, os.environ["HUNTER_ENV_DIR"])


def _load_env() -> None:
    for _dir in _ENV_DIRS:
        f = os.path.join(_dir, ".env")
        if os.path.exists(f):
            with open(f, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        if k not in os.environ:
                            os.environ[k] = v.strip()


class HunterError(Exception):
    """缺 key / 参数错等可预见的错误。"""


def _norm(resp: Dict[str, Any]) -> Dict[str, Any]:
    """把 Hunter 响应统一成 {success, data, error}（与 dc_arounddeal 一致）。"""
    errors = resp.get("errors")
    if errors:
        e = errors[0] if isinstance(errors, list) and errors else errors
        return {"success": False,
                "error": {"code": e.get("code", "?"), "detail": e.get("details", "")}}
    return {"success": True, "data": resp.get("data"), "meta": resp.get("meta")}


def _parse(raw: str) -> Dict[str, Any]:
    try:
        return json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return {}


class HunterClient:
    def __init__(self, api_key: Optional[str] = None, timeout: int = 30):
        _load_env()
        self.api_key = (api_key or os.environ.get("HUNTER_API_KEY", "")).strip()
        self.timeout = timeout
        if not self.api_key:
            raise HunterError("缺少 HUNTER_API_KEY，请在 .env 配置后重试")

    def _get(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        params = {k: v for k, v in (params or {}).items() if v is not None}
        params["api_key"] = self.api_key
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        url = BASE_URL + path + "?" + qs
        req = Request(url, method="GET", headers={"Accept": "application/json"})
        try:
            with urlopen(req, timeout=self.timeout) as resp:
                return _norm(_parse(resp.read().decode()))
        except HTTPError as e:
            return _norm(_parse(e.read().decode()))
        except URLError as e:
            return {"success": False, "error": {"code": -1, "detail": str(e.reason)}}

    def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        body = {k: v for k, v in (body or {}).items() if v is not None}
        body["api_key"] = self.api_key
        req = Request(BASE_URL + path, method="POST",
                      data=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urlopen(req, timeout=self.timeout) as resp:
                return _norm(_parse(resp.read().decode()))
        except HTTPError as e:
            return _norm(_parse(e.read().decode()))
        except URLError as e:
            return {"success": False, "error": {"code": -1, "detail": str(e.reason)}}

    # ── 核心端点 ────────────────────────────────────────────

    def domain_search(self, domain: Optional[str] = None, company: Optional[str] = None,
                      limit: int = 10, offset: int = 0, type: Optional[str] = None,
                      seniority: Optional[str] = None, department: Optional[str] = None,
                      decision_maker: Optional[bool] = None, required_field: Optional[str] = None,
                      verification_status: Optional[str] = None) -> Dict[str, Any]:
        """域名搜邮箱：某公司所有人的邮箱 + 来源。domain 优先于 company。"""
        return self._get("domain-search", {
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
        return self._get("email-finder", {
            "domain": domain, "company": company, "linkedin_handle": linkedin_handle,
            "first_name": first_name, "last_name": last_name, "full_name": full_name,
            "max_duration": max_duration,
        })

    def email_verifier(self, email: str) -> Dict[str, Any]:
        """邮箱验证：可投递性 / score / smtp。"""
        return self._get("email-verifier", {"email": email})

    def people_find(self, email: Optional[str] = None,
                    linkedin_handle: Optional[str] = None) -> Dict[str, Any]:
        """人富化：email / linkedin → 个人信息（姓名/职位/公司/地点）。"""
        return self._get("people/find", {"email": email, "linkedin_handle": linkedin_handle})

    def companies_find(self, domain: Optional[str] = None,
                       company: Optional[str] = None) -> Dict[str, Any]:
        """公司富化：domain / company → 公司信息。"""
        return self._get("companies/find", {"domain": domain, "company": company})

    def discover(self, query: Optional[str] = None,
                 filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """搜公司：自然语言 query 或结构化 filters（industry/headcount/company_type 等）。"""
        body: Dict[str, Any] = {}
        if query:
            body["query"] = query
        if filters:
            body.update(filters)
        return self._post("discover", body)
