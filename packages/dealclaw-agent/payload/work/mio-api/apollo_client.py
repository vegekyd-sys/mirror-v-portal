#!/usr/bin/env python3
"""
Apollo.io API 客户端（走内部 blade-agent-adapter 网关）
==================================================
封装 People Search + People Enrichment + Contact Search + Organization Search，
底层走 https://micro.tradechina.com/blade-agent-adapter 的 /agent/apollo/* 端点，
鉴权用 X-Feishu-Open-Id + X-Supplier-Id header（与 CDP 一致），不再用 APOLLO_API_KEY，
防止 API key 泄漏。

对外接口与旧版兼容：
    from apollo_client import ApolloClient
    client = ApolloClient()

    # 按公司域名搜采购决策人
    people = client.search_people(
        domain="brumate.com",
        titles=["sourcing manager", "supply chain", "procurement", "buyer"],
        seniorities=["director", "manager", "head", "vp"]
    )

    # 解锁邮箱电话（消耗积分）
    contact = client.enrich_person(
        first_name="Dylan", last_name="Jacob",
        organization_name="BrüMate", domain="brumate.com"
    )

    # 兜底 Contact Search
    contacts = client.search_contacts(domain="brumate.com", titles=["sourcing", "buyer"])

环境变量（不再需要 APOLLO_API_KEY）:
    MIO_V_OPEN_ID — 飞书数字人 open_id（X-Feishu-Open-Id）
    MIO_CDP_SUPPLIER_ID — 供应商 id（X-Supplier-Id）
    MEO_ADAPTER_BASE_URL — 网关地址（默认 https://micro.tradechina.com/blade-agent-adapter）
"""

import os
import sys
from typing import Optional

# 复用 find-buyers 的公共客户端（_client.py：post_json / env，自动读 .env + 带 X-Feishu-Open-Id / X-Supplier-Id header）
_HERE = os.path.dirname(os.path.abspath(__file__))
_SKILL_SCRIPTS = os.path.normpath(
    os.path.join(_HERE, "..", "..", "skills", "dealclaw-find-buyers", "scripts")
)
if _SKILL_SCRIPTS not in sys.path:
    sys.path.insert(0, _SKILL_SCRIPTS)

from _client import post_json, env  # noqa: E402

DEFAULT_BASE_URL = "https://micro.tradechina.com/blade-agent-adapter"

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
    """Apollo.io 客户端（经内部 blade-agent-adapter 网关，防 key 泄漏）"""

    def __init__(self):
        self.base_url = env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL)
        self.open_id = env("MIO_V_OPEN_ID", "")
        self.supplier_id = env("MIO_CDP_SUPPLIER_ID", "")

    # ── 内部方法 ──────────────────────────────────────────

    def _call(self, path: str, body: dict) -> dict:
        """统一调 blade-agent-adapter。失败返回 {"success": False, "error": ...}，成功解包 data。"""
        resp = post_json(
            base_url=self.base_url,
            path=path,
            body=body,
            open_id=self.open_id,
            supplier_id=self.supplier_id,
            timeout=60,
        )
        if not resp.get("success"):
            return {
                "success": False,
                "error": resp.get("msg") or "未知错误",
                "code": resp.get("code"),
            }
        data = resp.get("data") or {}
        return {"success": True, **data}

    @staticmethod
    def _map_person(p: dict) -> dict:
        """网关联系人卡片（camelCase）→ 旧版 snake_case，保持下游兼容。"""
        return {
            "id": p.get("apolloId", ""),
            "first_name": p.get("firstName", ""),
            "last_name": p.get("lastName", ""),
            "name": p.get("name", ""),
            "title": p.get("title", ""),
            "seniority": p.get("seniority", ""),
            "organization_name": p.get("organization", ""),
            "email": p.get("email", ""),
            "email_status": p.get("emailStatus", ""),
            "phone_numbers": p.get("phone", []) or [],
            "linkedin_url": p.get("linkedinUrl", ""),
            "has_email": p.get("hasEmail", False),
            "last_name_obfuscated": p.get("lastNameObfuscated", ""),
            "enrich_success": p.get("enrichSuccess", False),
        }

    @staticmethod
    def _map_org(o: dict) -> dict:
        """网关公司卡片（camelCase）→ 旧版 snake_case。"""
        return {
            "id": o.get("apolloId", ""),
            "name": o.get("name", ""),
            "primary_domain": o.get("primaryDomain", ""),
            "website_url": o.get("websiteUrl", ""),
            "industry": o.get("industry", ""),
            "linkedin_url": o.get("linkedinUrl", ""),
            "estimated_num_employees": o.get("estimatedNumEmployees", ""),
        }

    @classmethod
    def _map_people_search(cls, data: dict) -> dict:
        """search* 联系人响应 → {"people": [...], "pagination": {...}}（旧版格式）。"""
        people = [cls._map_person(p) for p in (data.get("people") or [])]
        return {
            "people": people,
            "pagination": {
                "page": data.get("page", 1),
                "per_page": data.get("perPage", 10),
                "total_entries": data.get("totalEntries", 0),
                "total_pages": data.get("totalPages", 0),
            },
        }

    @classmethod
    def _map_org_search(cls, data: dict) -> dict:
        """search* 公司响应 → {"organizations": [...], "pagination": {...}}。"""
        orgs = [cls._map_org(o) for o in (data.get("organizations") or [])]
        return {
            "organizations": orgs,
            "pagination": {
                "page": data.get("page", 1),
                "per_page": data.get("perPage", 10),
                "total_entries": data.get("totalEntries", 0),
                "total_pages": data.get("totalPages", 0),
            },
        }

    # ── People Search ─────────────────────────────────────

    def search_people(
        self,
        domain: str,
        titles: Optional[list] = None,
        seniorities: Optional[list] = None,
        per_page: int = 10,
        page: int = 1,
        locations: Optional[list] = None,
    ) -> dict:
        """按公司域名搜索联系人。返回 {"people": [...], "pagination": {...}}。"""
        body: dict = {"domain": domain, "page": page, "perPage": min(per_page, 100)}
        if titles:
            body["titles"] = titles
        if seniorities:
            body["seniorities"] = seniorities
        if locations:
            body["locations"] = locations
        result = self._call("/agent/apollo/searchPeople.json", body)
        if not result.get("success"):
            return result
        return {"success": True, **self._map_people_search(result)}

    def search_sourcing_contacts(self, domain: str, per_page: int = 10) -> dict:
        """快捷方法：搜公司的采购/供应链决策人。"""
        return self.search_people(
            domain=domain,
            titles=DEFAULT_SOURCING_TITLES,
            seniorities=DEFAULT_SOURCING_SENIORITIES,
            per_page=per_page,
        )

    def search_brand_contacts(self, domain: str, per_page: int = 10) -> dict:
        """快捷方法：搜公司的高管/品牌负责人。"""
        return self.search_people(
            domain=domain,
            titles=DEFAULT_BRAND_TITLES,
            seniorities=["owner", "founder", "c_suite", "vp", "director"],
            per_page=per_page,
        )

    # ── Email Reveal Pipeline ─────────────────────────────

    def reveal_contacts_emails(
        self,
        contacts: list,
        reveal_personal_emails: bool = True,
        reveal_phone_number: bool = False,
    ) -> dict:
        """批量解锁联系人邮箱/电话。contacts 每条需含 first_name + last_name + domain。"""
        payload = []
        for c in contacts:
            first = c.get("first_name", "")
            last = c.get("last_name", "")
            domain = c.get("domain", "")
            if not first or not last or not domain:
                payload.append({
                    "first_name": first, "last_name": last, "domain": domain,
                    "email": None, "email_status": "missing_name_or_domain", "phone_numbers": [],
                })
                continue
            payload.append({"firstName": first, "lastName": last, "domain": domain})
        # 网关批量解锁需要至少一条合法联系人，否则直接返回
        valid = [p for p in payload if "firstName" in p]
        if not valid:
            return {"contacts": payload}

        body = {
            "contacts": valid,
            "revealPersonalEmails": reveal_personal_emails,
            "revealPhoneNumber": reveal_phone_number,
        }
        result = self._call("/agent/apollo/revealEmails.json", body)
        if not result.get("success"):
            return {"contacts": payload, "error": result.get("error")}

        out = []
        for c in (result.get("contacts") or []):
            out.append(self._map_person(c))
        return {"contacts": out}

    # ── People Enrichment ─────────────────────────────────

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
        """根据姓名+公司信息解锁联系人邮箱/电话。返回的 email/phone 在 response['person']。"""
        body: dict = {}
        if first_name:
            body["firstName"] = first_name
        if last_name:
            body["lastName"] = last_name
        if full_name:
            body["fullName"] = full_name
        if organization_name:
            body["organizationName"] = organization_name
        if domain:
            body["domain"] = domain
        if email:
            body["email"] = email
        if linkedin_url:
            body["linkedinUrl"] = linkedin_url
        if reveal_personal_emails:
            body["revealPersonalEmails"] = True
        if reveal_phone_number:
            body["revealPhoneNumber"] = True

        if not body:
            return {"error": "至少提供 first_name+last_name / name / email 之一"}

        result = self._call("/agent/apollo/enrichPerson.json", body)
        if not result.get("success"):
            return result
        # enrichPerson 的 data 就是单张联系人卡片
        return {"success": True, "person": self._map_person(result)}

    # ── Contact Search ────────────────────────────────────

    def search_contacts(
        self,
        domain: Optional[str] = None,
        titles: Optional[list] = None,
        keywords: Optional[str] = None,
        per_page: int = 10,
        page: int = 1,
    ) -> dict:
        """搜索联系人（Contact Search）。"""
        body: dict = {"page": page, "perPage": min(per_page, 100)}
        if domain:
            body["domain"] = domain
        if titles:
            body["titles"] = titles
        if keywords:
            body["keywords"] = keywords
        result = self._call("/agent/apollo/searchContacts.json", body)
        if not result.get("success"):
            return result
        return {"success": True, **self._map_people_search(result)}

    # ── Organization Search ──────────────────────────────

    def search_organizations(
        self,
        keyword: Optional[str] = None,
        keyword_tags: Optional[list] = None,
        name: Optional[str] = None,
        industry: Optional[str] = None,
        locations: Optional[list] = None,
        employee_ranges: Optional[list] = None,
        per_page: int = 10,
        page: int = 1,
    ) -> dict:
        """搜索公司（不需要域名）。返回 {"organizations": [...], "pagination": {...}}。"""
        body: dict = {"page": page, "perPage": min(per_page, 100)}
        if keyword or name:
            body["keyword"] = keyword or name
        if keyword_tags:
            body["keywordTags"] = keyword_tags
        if industry:
            body["industry"] = industry
        if locations:
            body["locations"] = locations
        if employee_ranges:
            body["employeeRanges"] = employee_ranges
        result = self._call("/agent/apollo/searchOrganizations.json", body)
        if not result.get("success"):
            return result
        return {"success": True, **self._map_org_search(result)}

    def search_companies_by_keyword(
        self, keyword: str, country: str = "United States", per_page: int = 10
    ) -> dict:
        """快捷方法：按关键词+国家搜公司。"""
        body: dict = {"keyword": keyword, "country": country, "perPage": min(per_page, 100)}
        result = self._call("/agent/apollo/searchCompaniesByKeyword.json", body)
        if not result.get("success"):
            return result
        return {"success": True, **self._map_org_search(result)}


# ── DC-LS 集成 ────────────────────────────────────────────

def format_people_for_dc_ls(people: list) -> list:
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
