#!/usr/bin/env python3
"""
Apollo.io API 客户端 — DealClaw DC-LS 联系人引擎
==================================================
封装 People Search + People Enrichment + Contact Search。

用法:
    from apollo_client import ApolloClient
    client = ApolloClient()

    # 搜公司里的采购决策人（需 Organization 套餐）
    people = client.search_people(
        domain="brumate.com",
        titles=["sourcing manager", "supply chain", "procurement", "buyer"],
        seniorities=["director", "manager", "head", "vp"]
    )

    # 解锁邮箱电话（需 Organization + 消耗积分）
    contact = client.enrich_person(
        first_name="Dylan", last_name="Jacob",
        organization_name="BrüMate", domain="brumate.com"
    )

    # 兜底：Contact Search（Free 套餐可用，数据较稀疏）
    contacts = client.search_contacts(
        domain="brumate.com",
        titles=["sourcing", "supply chain", "buyer"]
    )

环境变量:
    APOLLO_API_KEY — Master API Key (从 .env 自动加载)

套餐要求:
    Free     — Contact Search only
    Basic+   — People Search (免费) + People Match (消耗积分)
    Organization — 全部端点 + 更高额度
"""

import json
import os
import sys
from typing import Optional
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# ── 自动加载 .env（与 find-buyers/_client.py 一致：固定 3 目录）──────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ENV_DIRS = [
    _HERE,  # 脚本所在目录
    os.path.normpath(os.path.join(_HERE, "..", "..")),  # workspace 根（相对，同步安全）
    os.environ.get("HOME", "") + "/.openclaw",
]


def _load_env() -> None:
    """读取固定 3 目录的 .env 写入 os.environ（已存在的键不覆盖，进程 env 优先）。"""
    for _d in _ENV_DIRS:
        _env_file = os.path.join(_d, ".env")
        if not os.path.exists(_env_file):
            continue
        try:
            with open(_env_file, encoding="utf-8") as _f:
                for _line in _f:
                    _line = _line.strip()
                    if not _line or _line.startswith("#") or "=" not in _line:
                        continue
                    _k, _v = _line.split("=", 1)
                    if _k not in os.environ:
                        os.environ[_k] = _v.strip()
        except OSError:
            continue


def _refresh_apollo_key() -> str:
    """动态读取最新 APOLLO_API_KEY：每次实例化重读 .env，覆盖旧值，不残留旧配置。"""
    key = ""
    for _d in _ENV_DIRS:
        _env_file = os.path.join(_d, ".env")
        if not os.path.exists(_env_file):
            continue
        try:
            with open(_env_file, encoding="utf-8") as _f:
                for _line in _f:
                    _line = _line.strip()
                    if _line.startswith("APOLLO_API_KEY="):
                        if not key:  # 靠近脚本的目录优先
                            key = _line.split("=", 1)[1].strip()
        except OSError:
            continue
    if key:
        os.environ["APOLLO_API_KEY"] = key
    return key


_load_env()

# ── 采购/供应链决策人预设 ─────────────────────────────────
DEFAULT_SOURCING_TITLES = [
    "sourcing manager", "supply chain manager", "procurement manager",
    "buyer", "purchasing manager", "global sourcing", "vendor manager",
    "product sourcing", "strategic sourcing", "import manager",
    "supply chain director", "procurement director", "chief supply chain officer",
]

DEFAULT_SOURCING_SENIORITIES = [
    "director", "manager", "head", "vp", "c_suite"
]

DEFAULT_BRAND_TITLES = [
    "founder", "ceo", "coo", "product manager", "brand manager",
    "merchandising manager", "category manager", "ecommerce manager",
]


class ApolloClient:
    """Apollo.io API 客户端"""

    BASE = "https://api.apollo.io/api/v1"

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or _refresh_apollo_key()
        self._headers = {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "X-Api-Key": self.api_key,
        }

    # ── People Search ─────────────────────────────────────
    # 需要 Basic+ 套餐

    def search_people(
        self,
        domain: str,
        titles: Optional[list[str]] = None,
        seniorities: Optional[list[str]] = None,
        per_page: int = 10,
        page: int = 1,
        locations: Optional[list[str]] = None,
    ) -> dict:
        """
        按公司域名搜索联系人。

        Args:
            domain: 公司域名 (如 "brumate.com")
            titles: 职位关键词列表
            seniorities: 级别列表 (owner/founder/c_suite/partner/vp/head/director/manager/senior/entry/intern)
            per_page: 每页条数 (最大100)
            page: 页码

        Returns: {"people": [...], "pagination": {...}}
        """
        body = {
            "q_organization_domains": domain,
            "page": page,
            "per_page": min(per_page, 100),
        }
        if titles:
            body["person_titles"] = titles
        if seniorities:
            body["person_seniorities"] = seniorities
        if locations:
            body["person_locations"] = locations

        return self._call("POST", "/mixed_people/api_search", body)

    def search_sourcing_contacts(self, domain: str, per_page: int = 10) -> dict:
        """快捷方法：搜公司的采购/供应链决策人"""
        return self.search_people(
            domain=domain,
            titles=DEFAULT_SOURCING_TITLES,
            seniorities=DEFAULT_SOURCING_SENIORITIES,
            per_page=per_page,
        )

    def search_brand_contacts(self, domain: str, per_page: int = 10) -> dict:
        """快捷方法：搜公司的高管/品牌负责人"""
        return self.search_people(
            domain=domain,
            titles=DEFAULT_BRAND_TITLES,
            seniorities=["owner", "founder", "c_suite", "vp", "director"],
            per_page=per_page,
        )

    # ── Email Reveal Pipeline ───────────────────────────
    # 两步流程: search_sourcing → 交叉验证姓氏 → reveal_contacts_emails

    def reveal_contacts_emails(
        self,
        contacts: list[dict],
        reveal_personal_emails: bool = True,
        reveal_phone_number: bool = False,
    ) -> dict:
        """
        批量解锁联系人邮箱和电话。
        contacts 中每条需包含: first_name, last_name, domain, organization_name(可选)

        消耗 Apollo 积分(1-9积分/人)。返回每条记录的 email、email_status、phone。
        """
        results = []
        for c in contacts:
            first = c.get("first_name", "")
            last = c.get("last_name", "")
            domain = c.get("domain", "")
            org = c.get("organization_name", "")

            if not first or not last or not domain:
                results.append({**c, "email": None, "email_status": "missing_name_or_domain", "phone": []})
                continue

            enriched = self.enrich_person(
                first_name=first,
                last_name=last,
                domain=domain,
                organization_name=org,
                reveal_personal_emails=reveal_personal_emails,
                reveal_phone_number=reveal_phone_number,
            )
            person = enriched.get("person", {})
            results.append({
                **c,
                "email": person.get("email"),
                "email_status": person.get("email_status"),
                "phone": person.get("phone_numbers", []),
                "apollo_id": person.get("id", ""),
                "enrich_success": enriched.get("success", False),
            })

        return {"contacts": results}

    # ── People Enrichment ─────────────────────────────────
    # 需要 Basic+ 套餐 + 消耗积分

    def enrich_person(
        self,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        full_name: Optional[str] = None,
        organization_name: Optional[str] = None,
        domain: Optional[str] = None,
        email: Optional[str] = None,
        linkedin_url: Optional[str] = None,
        reveal_personal_emails: bool = False,
        reveal_phone_number: bool = False,
    ) -> dict:
        """
        根据姓名+公司信息解锁联系人邮箱和电话。
        消耗 1-9 积分/人。返回的 email/phone 在 response['person'] 中。

        至少提供: first_name+last_name 或 full_name 或 email
        建议同时提供: organization_name 或 domain (提高匹配率)
        """
        body = {}
        if first_name:
            body["first_name"] = first_name
        if last_name:
            body["last_name"] = last_name
        if full_name:
            body["name"] = full_name
        if organization_name:
            body["organization_name"] = organization_name
        if domain:
            body["domain"] = domain
        if email:
            body["email"] = email
        if linkedin_url:
            body["linkedin_url"] = linkedin_url
        if reveal_personal_emails:
            body["reveal_personal_emails"] = True
        if reveal_phone_number:
            body["reveal_phone_number"] = True

        if not body:
            return {"error": "至少提供 first_name+last_name / name / email 之一"}

        return self._call("POST", "/people/match", body)

    # ── Contact Search ────────────────────────────────────
    # Free 套餐可用，但数据较稀疏

    def search_contacts(
        self,
        domain: Optional[str] = None,
        titles: Optional[list[str]] = None,
        keywords: Optional[str] = None,
        per_page: int = 10,
        page: int = 1,
    ) -> dict:
        """
        搜索已保存的联系人（Free 套餐可用）。

        Args:
            domain: 公司域名过滤
            titles: 职位过滤
            keywords: 关键词搜索
        """
        body = {"page": page, "per_page": min(per_page, 100)}
        if domain:
            body["q_organization_domains"] = [domain]
        if titles:
            body["contact_titles"] = titles
        if keywords:
            body["q_keywords"] = keywords

        return self._call("POST", "/contacts/search", body)

    # ── Organization Search ──────────────────────────────
    # 按行业/关键词/地区搜公司，不需要先有域名

    def search_organizations(
        self,
        keyword: Optional[str] = None,
        keyword_tags: Optional[list[str]] = None,
        name: Optional[str] = None,
        industry: Optional[str] = None,
        locations: Optional[list[str]] = None,
        employee_ranges: Optional[list[str]] = None,
        per_page: int = 10,
        page: int = 1,
    ) -> dict:
        """
        搜索公司（不需要域名）。端点: /mixed_companies/search。

        Args:
            keyword: 公司名模糊匹配 (q_organization_name)
            keyword_tags: 关键词标签数组 (q_organization_keyword_tags[])
            name: 公司名精确片段 (等同于 keyword)
            industry: 行业 (organization_industries[]), 大小写敏感
            locations: 地区数组 (organization_locations[])
            employee_ranges: 员工规模数组 (organization_num_employees_ranges[])
                如 ["1,10", "11,50", "51,200"]
            per_page: 每页条数 (最大100, 消耗1积分/页)

        Returns: {"organizations": [...], "pagination": {...}}
        """
        body = {"page": page, "per_page": min(per_page, 100)}
        if keyword or name:
            body["q_organization_name"] = keyword or name
        if keyword_tags:
            body["q_organization_keyword_tags"] = keyword_tags
        if industry:
            body["organization_industries"] = [industry]
        if locations:
            body["organization_locations"] = locations
        if employee_ranges:
            body["organization_num_employees_ranges"] = employee_ranges

        return self._call("POST", "/organizations/search", body)

    def search_companies_by_keyword(
        self, keyword: str, country: str = "United States", per_page: int = 10
    ) -> dict:
        """快捷方法：按关键词标签+国家搜公司"""
        return self.search_organizations(
            keyword_tags=[keyword], locations=[country], per_page=per_page
        )

    # ── 内部方法 ──────────────────────────────────────────

    def _call(self, method: str, path: str, body: dict) -> dict:
        url = f"{self.BASE}{path}"
        data = json.dumps(body, ensure_ascii=False).encode()
        req = Request(url, data=data, headers=self._headers, method=method)
        try:
            with urlopen(req, timeout=30) as resp:
                return {"success": True, **json.loads(resp.read().decode())}
        except HTTPError as e:
            err_body = e.read().decode()
            try:
                err = json.loads(err_body)
            except json.JSONDecodeError:
                err = {"error": err_body[:200]}
            return {
                "success": False,
                "http_status": e.code,
                **err,
            }


# ── DC-LS 集成 ────────────────────────────────────────────

def format_people_for_dc_ls(people: list[dict]) -> list[dict]:
    """将 Apollo People 结果格式化为 DC-LS 联系人卡片"""
    cards = []
    for p in people:
        cards.append({
            "name": f"{p.get('first_name', '')} {p.get('last_name', '')}".strip(),
            "title": p.get("title", ""),
            "organization": p.get("organization_name", ""),
            "seniority": p.get("seniority", ""),
            "linkedin_url": p.get("linkedin_url", ""),
            "email": p.get("email", ""),
            "phone": p.get("phone_numbers", []),
            "apollo_id": p.get("id", ""),
        })
    return cards


def format_contact_for_dc_ls(contact: dict) -> dict:
    """将 Apollo Enrichment 结果格式化为 DC-LS 联系人卡片"""
    return {
        "name": f"{contact.get('first_name', '')} {contact.get('last_name', '')}".strip(),
        "title": contact.get("title", ""),
        "organization": contact.get("organization_name", ""),
        "email": contact.get("email", ""),
        "email_status": contact.get("email_status", ""),
        "phone": contact.get("phone_numbers", []),
        "linkedin_url": contact.get("linkedin_url", ""),
        "apollo_id": contact.get("id", ""),
    }


# ── CLI ───────────────────────────────────────────────────
if __name__ == "__main__":
    client = ApolloClient()

    if len(sys.argv) < 2:
        print("用法:")
        print("  python apollo_client.py <domain> [--sourcing|--brand|--contacts]")
        print("    搜公司联系人（需域名）")
        print("  python apollo_client.py --companies <keyword> [--country US] [--industry ...] [--employees 51,200]")
        print("    按关键词标签搜公司（不需要域名）")
        print("  python apollo_client.py <domain> --reveal '<FirstName LastName>' ['<FirstName2 LastName2>' ...]")
        print("    解锁联系人邮箱（需提供全名，消耗积分）")
        print("示例:")
        print("  python apollo_client.py brumate.com --sourcing")
        print("  python apollo_client.py --companies 'smart glasses' --country US --employees 51,200")
        print("  python apollo_client.py brumate.com --reveal 'Chase Cunningham' 'Anna Elovitz'")
        sys.exit(1)

    # ── 公司搜索模式 ──
    if sys.argv[1] == "--companies":
        if len(sys.argv) < 3:
            print("❌ 缺少关键词: python apollo_client.py --companies <keyword> [--country US] [--industry ...] [--employees 51,200]")
            sys.exit(1)
        keyword = sys.argv[2]
        country = "United States"
        industry = None
        per_page = 10
        employees = None
        i = 3
        while i < len(sys.argv):
            if sys.argv[i] == "--country" and i + 1 < len(sys.argv):
                country = sys.argv[i + 1]
                i += 2
            elif sys.argv[i] == "--industry" and i + 1 < len(sys.argv):
                industry = sys.argv[i + 1]
                i += 2
            elif sys.argv[i] == "--employees" and i + 1 < len(sys.argv):
                employees = [sys.argv[i + 1]]
                i += 2
            elif sys.argv[i] == "--size" and i + 1 < len(sys.argv):
                per_page = int(sys.argv[i + 1])
                i += 2
            else:
                i += 1
        result = client.search_organizations(
            keyword_tags=[keyword],
            locations=[country],
            industry=industry,
            employee_ranges=employees,
            per_page=per_page,
        )
        if result.get("success"):
            orgs = result.get("organizations", [])
            pag = result.get("pagination", {})
            filters = [f"'{keyword}'", country]
            if industry: filters.append(f"industry={industry}")
            if employees: filters.append(f"size={employees[0]}")
            print(f"✅ {', '.join(filters)}: {len(orgs)} companies (total: {pag.get('total_entries', '?')})")
            for org in orgs:
                name = org.get("name", "?")
                domain = org.get("primary_domain", "—")
                ind = org.get("industry", "—")
                emp = org.get("estimated_num_employees", "—")
                print(f"  {name} | {domain} | {ind} | ~{emp} employees")
        else:
            error = result.get("error", result.get("message", "unknown"))
            print(f"❌ '{keyword}': {error}")
        sys.exit(0)

    # ── 邮箱解锁模式 ──
    if len(sys.argv) >= 3 and sys.argv[2] == "--reveal":
        domain = sys.argv[1]
        names = sys.argv[3:]
        contacts = []
        for full_name in names:
            parts = full_name.strip().split()
            if len(parts) >= 2:
                contacts.append({
                    "first_name": parts[0],
                    "last_name": " ".join(parts[1:]),
                    "domain": domain,
                })
        if not contacts:
            print("❌ 缺少全名: python apollo_client.py <domain> --reveal 'First Last' ['First2 Last2' ...]")
            sys.exit(1)
        result = client.reveal_contacts_emails(contacts)
        for c in result.get("contacts", []):
            name = f"{c.get('first_name','')} {c.get('last_name','')}".strip()
            email = c.get("email", "—")
            status = c.get("email_status", "—")
            print(f"  {name} | {email} | {status}")
        sys.exit(0)

    # ── 域名联系人搜索模式 ──
    domain = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "--sourcing"

    if mode == "--sourcing":
        result = client.search_sourcing_contacts(domain)
    elif mode == "--brand":
        result = client.search_brand_contacts(domain)
    elif mode == "--contacts":
        result = client.search_contacts(domain=domain, keywords="sourcing buyer purchasing")
    else:
        result = client.search_people(domain=domain)

    if result.get("success"):
        people = result.get("people", []) or result.get("contacts", [])
        pag = result.get("pagination", {})
        print(f"✅ {domain}: {len(people)} people (total: {pag.get('total_entries', '?')})")
        for p in people:
            name = f"{p.get('first_name','')} {p.get('last_name','')}".strip()
            title = p.get("title", "?")
            email = p.get("email", "—")
            has_e = p.get("has_email", False)
            obf = p.get("last_name_obfuscated", "")
            email_flag = "📧" if has_e else "✗"
            obf_str = f" obfuscated: {obf}" if obf else ""
            print(f"  {name} | {title} | {email} | has_email={email_flag}{obf_str}")
    else:
        error = result.get("error", result.get("message", "unknown"))
        print(f"❌ {domain}: {error}")
