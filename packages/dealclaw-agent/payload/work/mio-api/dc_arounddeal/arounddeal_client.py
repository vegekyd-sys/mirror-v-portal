#!/usr/bin/env python3
"""
AroundDeal API Matrix 客户端 — Meorient
========================================
封装 15 个非 Risk 接口(Enrichment / Search / Identity / Company Intelligence)。

用法:
    from arounddeal_client import AroundDealClient
    client = AroundDealClient()

    # 公司画像 —— 务必优先传 linkedin_url,只传域名可能匹配到子品牌
    client.company_enrichment(linkedin_url="https://www.linkedin.com/company/microsoft/")

    # 搜公司里的采购决策人(按条计费 $0.50/人,必须显式 limit)
    client.search_sourcing_contacts(
        linkedin_url="https://www.linkedin.com/company/microsoft/", limit=5
    )

环境变量:
    AROUNDDEAL_API_KEY — Bearer Token (从 .env 自动加载)

计费要点:
    未命中(PROFILE:NOT_FOUND)不扣费;命中但返回空 list 照扣。
    company_contact_discovery 按「每条记录」计费,内置单次上限保护。
"""

import json
import os
import re
import sys
import time
import warnings
from typing import Any, Dict, List, Optional
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ── 复用 find-buyers 公共客户端（post_json / env，带 X-Feishu-Open-Id / X-Supplier-Id header）──
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

# ── 自动加载 .env ─────────────────────────────────────────
# 采用 skills/*/scripts/_client.py 的「向上遍历目录树」写法,而不是
# apollo_client.py 的「固定 3 目录」。放到 work/mio-api/ 下时两者等效,
# 但固定 3 目录隐含假设脚本就位于 <workspace>/work/mio-api/,脚本一旦
# 放在别处就一个 .env 都找不到;向上遍历两种位置都能工作。
_ENV_DIRS: List[str] = []
_d = os.path.dirname(os.path.abspath(__file__))
while _d and _d != os.path.dirname(_d):
    _ENV_DIRS.append(os.path.join(_d, "work", "mio-api"))
    _ENV_DIRS.append(_d)
    _d = os.path.dirname(_d)
_ENV_DIRS.append(os.path.join(os.environ.get("HOME", ""), ".openclaw"))
# 逃生口:显式指定 .env 所在目录,优先级最高
if os.environ.get("AROUNDDEAL_ENV_DIR"):
    _ENV_DIRS.insert(0, os.environ["AROUNDDEAL_ENV_DIR"])


def _load_env() -> None:
    """读取 .env 写入 os.environ(已存在的键不覆盖,进程 env 优先)。"""
    try:
        from _tenant_env import load_tenant_env
        load_tenant_env()
    except ImportError:
        pass
    for _dir in _ENV_DIRS:
        _env_file = os.path.join(_dir, ".env")
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


def _refresh_arounddeal_key() -> str:
    """动态读取最新 AROUNDDEAL_API_KEY:每次实例化重读 .env,覆盖旧值,不残留旧配置。"""
    key = ""
    for _dir in _ENV_DIRS:
        _env_file = os.path.join(_dir, ".env")
        if not os.path.exists(_env_file):
            continue
        try:
            with open(_env_file, encoding="utf-8") as _f:
                for _line in _f:
                    _line = _line.strip()
                    if _line.startswith("AROUNDDEAL_API_KEY="):
                        if not key:  # 靠近脚本的目录优先
                            key = _line.split("=", 1)[1].strip()
        except OSError:
            continue
    if key:
        os.environ["AROUNDDEAL_API_KEY"] = key
    return key or os.environ.get("AROUNDDEAL_API_KEY", "")


_load_env()

# ── 单价(USD),取自各接口详情页内嵌数据 ─────────────────────────────────
# 仅用于成本估算和费用保护的报错文案,不参与实际计费(钱由服务端扣)。
# ⚠️ 这是【上界】,实测偏高:$4.43 估 / $4.33 实扣、$0.81 估 / $0.61 实扣。
#    原因至少有 people_enrichment 的分档计价,未逐项测准。
PRICING: Dict[str, float] = {
    "contact_verification_email": 0.01,
    "contact_verification_phone": 0.02,
    "resume_enrichment": 0.10,
    "company_search": 0.10,
    "company_enrichment": 0.30,
    "people_search": 0.30,
    "company_clients": 0.30,
    "company_events": 0.30,
    "company_job": 0.30,
    "company_product": 0.30,
    "company_relationship_check": 0.30,
    "company_suppliers": 0.30,
    "orgchart": 0.30,
    "email_to_linkedin_profile": 0.50,
    "people_enrichment": 0.50,          # 分档:命中联系方式 0.50 / 未命中 0.10,此处取上界
    "company_contact_discovery": 0.50,  # 按「人」计费,实际 = 0.50 × 返回条数
}

# 按条计费的接口 -> 控制返回条数的参数名
PER_RECORD_BILLING = {"company_contact_discovery": ("limit", "size")}
CONTACT_DISCOVERY_MAX_RECORDS = 5  # 单次上限,约 $2.50

# ══════════════════════════════════════════════════════════════════════════
# 数据字典(枚举)
# 全部抓自 https://www.arounddeal.com/standard/*(快照日期 2026-08-19)。
# 既用于入参过滤值,也用于把出参里的 ID 翻回可读名称。
# ⚠️ 官方字典已知不完整,见文件末尾 UNDOCUMENTED_JOB_FUNCTIONS。
# ══════════════════════════════════════════════════════════════════════════

# ── Job Level(职级) ───────────────────────────────────────────
# /standard/job-levels — 11 项
# 入参:job_level(people_search / company_contact_discovery,string | array)
# 出参:job_level(people_enrichment / people_search / orgchart 等)
# ⚠️ 实测 Satya Nadella(Chairman and CEO)返回 OWNER 而非 CXO ——
#    按 CXO 筛会漏掉真 CEO,筛高管建议 CXO + OWNER + PARTNER 一起带。
# 已废弃入参 seniority 用的是同一套值,新代码一律用 job_level。
JOB_LEVELS: Dict[str, str] = {
    "PARTNER":     "合伙人",            # Partner —— 持股或战略合伙人,共担所有权与长期责任
    "OWNER":       "企业主",            # Owner —— 对公司经营与方向拥有完全或多数控制权
    "CXO":         "C 级高管",          # CXO —— CEO/CFO/CMO/CTO 等,最高层战略决策
    "VP":          "副总裁",            # VP —— 分管主要职能板块,直接向 C 级汇报
    "DIRECTOR":    "总监",             # Director —— 管理部门或业务单元,对长期目标与团队绩效负责
    "MANAGER":     "经理",             # Manager —— 带团队、管日常运营、推进业务目标落地
    "SENIOR":      "资深员工",           # Senior Level —— 有深度专长的资深个人贡献者,常承担非正式领导职责
    "ENTRY":       "初级员工",           # Entry Level —— 职业早期,正在积累基础技能与领域知识
    "ASSISTANT":   "助理",             # Assistant —— 支持类岗位,协助高级员工处理行政/运营/项目事务
    "TRAINEE":     "实习/培训生",         # Trainee —— 处于结构化培训、实习或学徒项目中
    "FREELANCER":  "自由职业者",          # Freelancer —— 独立承包方或自雇专业人士,按项目/合同参与
}

# ── Job Function(职能) ────────────────────────────────────────
# /standard/job-functions — 29 项
# 入参:function(people_search / company_contact_discovery,string | array)
# 出参:function —— 注意类型不一致:people_* 返回 array,
#       email_to_linkedin_profile 返回 string。
JOB_FUNCTIONS: Dict[str, str] = {
    "ACCOUNTING":                      "会计",                   # Accounting —— 财务记账、审计、税务合规与报表
    "ADMINISTRATIVE":                  "行政",                   # Administrative —— 办公运营、日程、内部沟通与后勤
    "ARTS_DESIGN":                     "艺术与设计",                # Arts and Design —— 平面/UX/UI、插画、品牌视觉
    "BD":                              "商务拓展",                 # Business Development —— 拓新市场、找合作、驱动营收增长
    "COMMUNITY_SOCIAL":                "社区与社会服务",              # Community and Social Services —— 社会服务、社区外联、公益项目
    "CONSULTING":                      "咨询",                   # Consulting —— 为组织提供战略/运营/技术顾问服务
    "CUSTOM":                          "自定义",                  # Custom —— 未归入预设分类的自定义职能
    "EDUCATION":                       "教育",                   # Education —— 教师、培训师、教研设计等知识传递岗
    "ENGINEERING":                     "工程技术",                 # Engineering —— 软件、硬件、基础设施的设计与维护
    "FINANCE":                         "金融财务",                 # Finance —— 财务规划、投资分析、预算、风险与资本配置
    "HEALTHCARE":                      "医疗健康服务",               # Healthcare Services —— 临床与非临床的医疗服务、健康项目管理
    "HUMAN_RESOURCES":                 "人力资源",                 # Human Resources —— 招聘、员工关系、薪酬、组织发展
    "IT":                              "信息技术",                 # Information Technology —— 系统运维、网络安全、IT 支持
    "LEGAL":                           "法务",                   # Legal —— 律师、法务、合规,处理合同与监管事务
    "LOGISTICS_AND_SUPPLY_CHAIN":      "物流与供应链",               # Logistics and Supply Chain —— 端到端供应链、仓储、运输、履约
    "MARKETING":                       "市场营销",                 # Marketing —— 品牌、需求生成、内容策略、GTM
    "MEDIA_COMMUNICATION":             "媒体与传播",                # Media and Communication —— 记者、PR、内容创作、对外传播
    "MILITARY_PROTECTIVE":             "军事与安保",                # Military and Protective Services —— 国防、执法、安保、应急响应
    "OPERATIONS":                      "运营",                   # Operations —— 业务流程、效率、设施与跨部门协同
    "PRODUCT_MANAGEMENT":              "产品管理",                 # Product Management —— 路线图规划、优先级、产品生命周期
    "PROGRAM_AND_PROJECT_MANAGEMENT":  "项目/项目集管理",             # Program and Project Management —— 项目规划、执行、按期交付
    "PUBLIC_RELATIONS":                "公共关系",                 # Public Relations —— 媒体关系、企业传播、公众声誉
    "PURCHASING":                      "采购",                   # Purchasing —— 供应商选择与采购执行 ★外贸场景核心职能
    "QUALITY_ASSURANCE":               "质量保证",                 # Quality Assurance —— 质量标准、检验与流程管控
    "RD":                              "研发",                   # R&D —— 研究与开发
    "REAL_ESTATE":                     "房地产",                  # Real Estate —— 地产开发、经纪、物业
    "RESEARCH":                        "研究",                   # Research —— 学术或产业研究
    "SALES":                           "销售",                   # Sales —— 销售与客户成交
    "SUPPLY_CHAIN":                    "供应链",                  # Supply Chain —— 供应链管理 ★与 LOGISTICS_AND_SUPPLY_CHAIN 并存,筛选建议两个都带
}

# ── Employee Range(公司规模) ────────────────────────────────────
# /standard/employee-ranges — 9 档
# 入参:employee_range(company_search / people_search 等,string | array)
# 出参:employee_range_id + employee_range_name
# ⚠️ 字母序与规模同向:A 最小(自雇)→ I 最大(1 万人以上)。
# ⚠️ 实测 company_enrichment 的 employee_range_id 常为空字符串,
#    只有 employee_range_name 有值 —— 不要用 ID 做关联。
EMPLOYEE_RANGES: Dict[str, str] = {
    "A":     "自雇",                     # Self-employed —— 自由职业者、顾问、个体户
    "B":     "2 ~ 10 人",               # 微型企业或早期创业团队
    "C":     "11 ~ 50 人",              # 小型企业,已有职能分工
    "D":     "51 ~ 200 人",             # 中小型企业,部门与流程成型
    "E":     "201 ~ 500 人",            # 中型企业,多业务单元,区域或全国布局
    "F":     "501 ~ 1,000 人",          # 中大型企业,具备专职支撑部门
    "G":     "1,001 ~ 5,000 人",        # 大型企业,跨区域,组织层级复杂
    "H":     "5,001 ~ 10,000 人",       # 大型跨国公司,全球布局与多产品线
    "I":     "10,000 人以上",             # 超大型企业,跨行业跨洲经营
}

# ── Company Type(公司类型) ──────────────────────────────────────
# /standard/company-types — 8 项
# 出参:type_id + type_name(company_enrichment)。非入参过滤字段。
# ⚠️ 实测 type_id 常为空,只有 type_name 有值。
COMPANY_TYPES: Dict[str, str] = {
    "C":     "上市公司",           # Public Company —— 证券交易所上市,受披露与股东报告监管
    "D":     "教育机构",           # Educational —— 大学、学校、学院、研究院
    "E":     "自雇",             # Self Employed —— 独立工作,既是所有者也是唯一员工
    "G":     "政府机构",           # Government Agency —— 联邦/州/地方政府及公共部门
    "N":     "非营利组织",          # Non Profit —— 慈善、基金会等以公益使命为目标
    "O":     "独资经营",           # Self Owned —— 个人全资经营,未正式注册为公司
    "P":     "私营企业",           # Privately Held —— 私人持股,未公开上市
    "S":     "合伙企业",           # Partnership —— 两人及以上共享所有权、责任与利润
}

# ── Industry(行业)────────────────────────────────────────
# /standard/industries — 19 个父类 + 145 个子类,共 164 项
# 入参:industry(company_search / people_search 等,传【ID 字符串】,string | array)
# 出参:company_enrichment 给扁平的 industry_id + industry_name;
#      company_search / people_search 给 [{id, name}] 数组 —— 结构不一致。
# ⚠️ 实测 company_enrichment 的 industry_id 常为 0,只有 industry_name 有值。
INDUSTRY_PARENTS: Dict[str, str] = {
    "2190":  "Accommodation Services",
    "1912":  "Administrative and Support Services",
    "48":    "Construction",
    "91":    "Consumer Services",
    "1999":  "Education",
    "28":    "Entertainment Providers",
    "201":   "Farming, Ranching, Forestry",
    "43":    "Financial Services",
    "75":    "Government Administration",
    "14":    "Hospitals and Health Care",
    "25":    "Manufacturing",
    "332":   "Oil, Gas, and Mining",
    "1810":  "Professional Services",
    "1757":  "Real Estate and Equipment Rental Services",
    "27":    "Retail",
    "1594":  "Technology, Information and Media",
    "116":   "Transportation, Logistics, Supply Chain and Storage",
    "59":    "Utilities",
    "133":   "Wholesale",
}

#: 子类 ID -> 名称(145 项)
INDUSTRY_SUBS: Dict[str, str] = {
    "34":    "Food and Beverage Services",
    "31":    "Hospitality",
    "1938":  "Collection Agencies",
    "110":   "Events Services",
    "122":   "Facilities Services",
    "101":   "Fundraising",
    "1916":  "Office Administration",
    "121":   "Security and Investigations",
    "104":   "Staffing and Recruiting",
    "1931":  "Telephone Call Centers",
    "108":   "Translation and Localization",
    "30":    "Travel Arrangements",
    "103":   "Writing and Editing",
    "406":   "Building Construction",
    "51":    "Civil Engineering",
    "435":   "Specialty Trade Contractors",
    "90":    "Civic and Social Organizations",
    "2318":  "Household Services",
    "100":   "Non-profit Organizations",
    "2258":  "Personal and Laundry Services",
    "131":   "Philanthropic Fundraising Services",
    "89":    "Religious Institutions",
    "2225":  "Repair and Maintenance",
    "132":   "E-Learning Providers",
    "68":    "Higher Education",
    "67":    "Primary and Secondary Education",
    "105":   "Professional Training and Coaching",
    "2018":  "Technical and Vocational Training",
    "38":    "Artists and Writers",
    "37":    "Museums, Historical Sites, and Zoos",
    "115":   "Musicians",
    "2130":  "Performing Arts and Spectator Sports",
    "40":    "Recreational Facilities",
    "63":    "Farming",
    "298":   "Forestry and Logging",
    "256":   "Ranching and Fisheries",
    "129":   "Capital Markets",
    "1673":  "Credit Intermediation",
    "1742":  "Funds and Trusts",
    "42":    "Insurance",
    "73":    "Administration of Justice",
    "2375":  "Economic Programs",
    "388":   "Environmental Quality Programs",
    "2353":  "Health and Human Services",
    "2369":  "Housing and Community Development",
    "2391":  "Military and International Affairs",
    "79":    "Public Policy Offices",
    "3089":  "Space Research and Technology",
    "2115":  "Community Services",
    "2081":  "Hospitals",
    "88":    "Individual and Family Services",
    "13":    "Medical Practices",
    "2091":  "Nursing Homes and Residential Care Facilities",
    "598":   "Apparel Manufacturing",
    "112":   "Appliances, Electrical, and Electronics Manufacturing",
    "54":    "Chemical Manufacturing",
    "3251":  "Climate Technology Product Manufacturing",
    "24":    "Computers and Electronics Manufacturing",
    "840":   "Fabricated Metal Products",
    "23":    "Food and Beverage Manufacturing",
    "26":    "Furniture and Home Furnishings Manufacturing",
    "145":   "Glass, Ceramics and Concrete Manufacturing",
    "616":   "Leather Product Manufacturing",
    "55":    "Machinery Manufacturing",
    "17":    "Medical Equipment Manufacturing",
    "679":   "Oil and Coal Product Manufacturing",
    "61":    "Paper and Forest Product Manufacturing",
    "743":   "Plastics and Rubber Product Manufacturing",
    "807":   "Primary Metal Manufacturing",
    "83":    "Printing Services",
    "20":    "Sporting Goods Manufacturing",
    "60":    "Textile Manufacturing",
    "21":    "Tobacco Manufacturing",
    "1029":  "Transportation Equipment Manufacturing",
    "784":   "Wood Product Manufacturing",
    "56":    "Mining",
    "57":    "Oil and Gas",
    "47":    "Accounting",
    "80":    "Advertising Services",
    "50":    "Architecture and Planning",
    "11":    "Business Consulting and Services",
    "99":    "Design Services",
    "3242":  "Engineering Services",
    "96":    "IT Services and IT Consulting",
    "10":    "Legal Services",
    "136":   "Photography",
    "70":    "Research Services",
    "3243":  "Services for Renewable Energy",
    "16":    "Veterinary Services",
    "1779":  "Equipment Rental Services",
    "44":    "Real Estate",
    "1339":  "Food and Beverage Retail",
    "1445":  "Online and Mail Order Retail",
    "19":    "Retail Apparel and Fashion",
    "1319":  "Retail Appliances, Electrical, and Electronic Equipment",
    "3186":  "Retail Art Dealers",
    "111":   "Retail Art Supplies",
    "1409":  "Retail Books and Printed News",
    "1324":  "Retail Building Materials and Garden Equipment",
    "1423":  "Retail Florists",
    "1309":  "Retail Furniture and Home Furnishings",
    "1370":  "Retail Gasoline",
    "1359":  "Retail Health and Personal Care Products",
    "143":   "Retail Luxury Goods and Jewelry",
    "1292":  "Retail Motor Vehicles",
    "1407":  "Retail Musical Instruments",
    "138":   "Retail Office Equipment",
    "1424":  "Retail Office Supplies and Gifts",
    "1431":  "Retail Recyclable Materials & Used Merchandise",
    "3133":  "Media & Telecommunications",
    "6":     "Technology, Information and Internet",
    "94":    "Airlines and Aviation",
    "87":    "Freight and Package Transportation",
    "1495":  "Ground Passenger Transportation",
    "95":    "Maritime Transportation",
    "1520":  "Pipeline Transportation",
    "1573":  "Postal Services",
    "1481":  "Rail Transportation",
    "92":    "Truck Transportation",
    "93":    "Warehousing and Storage",
    "383":   "Electric Power Generation",
    "382":   "Electric Power Transmission, Control, and Distribution",
    "397":   "Natural Gas Distribution",
    "398":   "Water, Waste, Steam, and Air Conditioning Services",
    "1267":  "Wholesale Alcoholic Beverages",
    "1222":  "Wholesale Apparel and Sewing Supplies",
    "1171":  "Wholesale Appliances, Electrical, and Electronics",
    "49":    "Wholesale Building Materials",
    "1257":  "Wholesale Chemical and Allied Products",
    "1157":  "Wholesale Computer Equipment",
    "1221":  "Wholesale Drugs and Sundries",
    "1231":  "Wholesale Food and Beverage",
    "1230":  "Wholesale Footwear",
    "1137":  "Wholesale Furniture and Home Furnishings",
    "1178":  "Wholesale Hardware, Plumbing, Heating Equipment",
    "134":   "Wholesale Import and Export",
    "1208":  "Wholesale Luxury Goods and Jewelry",
    "1187":  "Wholesale Machinery",
    "1166":  "Wholesale Metals and Minerals",
    "1128":  "Wholesale Motor Vehicles and Parts",
    "1212":  "Wholesale Paper Products",
    "1262":  "Wholesale Petroleum and Petroleum Products",
    "1153":  "Wholesale Photography Equipment and Supplies",
    "1250":  "Wholesale Raw Farm Products",
    "1206":  "Wholesale Recyclable Materials",
}

#: 子类 ID -> 所属父类 ID,用于把细分行业上卷到大类
INDUSTRY_SUB_TO_PARENT: Dict[str, str] = {
    "34":    "2190",
    "31":    "2190",
    "1938":  "1912",
    "110":   "1912",
    "122":   "1912",
    "101":   "1912",
    "1916":  "1912",
    "121":   "1912",
    "104":   "1912",
    "1931":  "1912",
    "108":   "1912",
    "30":    "1912",
    "103":   "1912",
    "406":   "48",
    "51":    "48",
    "435":   "48",
    "90":    "91",
    "2318":  "91",
    "100":   "91",
    "2258":  "91",
    "131":   "91",
    "89":    "91",
    "2225":  "91",
    "132":   "1999",
    "68":    "1999",
    "67":    "1999",
    "105":   "1999",
    "2018":  "1999",
    "38":    "28",
    "37":    "28",
    "115":   "28",
    "2130":  "28",
    "40":    "28",
    "63":    "201",
    "298":   "201",
    "256":   "201",
    "129":   "43",
    "1673":  "43",
    "1742":  "43",
    "42":    "43",
    "73":    "75",
    "2375":  "75",
    "388":   "75",
    "2353":  "75",
    "2369":  "75",
    "2391":  "75",
    "79":    "75",
    "3089":  "75",
    "2115":  "14",
    "2081":  "14",
    "88":    "14",
    "13":    "14",
    "2091":  "14",
    "598":   "25",
    "112":   "25",
    "54":    "25",
    "3251":  "25",
    "24":    "25",
    "840":   "25",
    "23":    "25",
    "26":    "25",
    "145":   "25",
    "616":   "25",
    "55":    "25",
    "17":    "25",
    "679":   "25",
    "61":    "25",
    "743":   "25",
    "807":   "25",
    "83":    "25",
    "20":    "25",
    "60":    "25",
    "21":    "25",
    "1029":  "25",
    "784":   "25",
    "56":    "332",
    "57":    "332",
    "47":    "1810",
    "80":    "1810",
    "50":    "1810",
    "11":    "1810",
    "99":    "1810",
    "3242":  "1810",
    "96":    "1810",
    "10":    "1810",
    "136":   "1810",
    "70":    "1810",
    "3243":  "1810",
    "16":    "1810",
    "1779":  "1757",
    "44":    "1757",
    "1339":  "27",
    "1445":  "27",
    "19":    "27",
    "1319":  "27",
    "3186":  "27",
    "111":   "27",
    "1409":  "27",
    "1324":  "27",
    "1423":  "27",
    "1309":  "27",
    "1370":  "27",
    "1359":  "27",
    "143":   "27",
    "1292":  "27",
    "1407":  "27",
    "138":   "27",
    "1424":  "27",
    "1431":  "27",
    "3133":  "1594",
    "6":     "1594",
    "94":    "116",
    "87":    "116",
    "1495":  "116",
    "95":    "116",
    "1520":  "116",
    "1573":  "116",
    "1481":  "116",
    "92":    "116",
    "93":    "116",
    "383":   "59",
    "382":   "59",
    "397":   "59",
    "398":   "59",
    "1267":  "133",
    "1222":  "133",
    "1171":  "133",
    "49":    "133",
    "1257":  "133",
    "1157":  "133",
    "1221":  "133",
    "1231":  "133",
    "1230":  "133",
    "1137":  "133",
    "1178":  "133",
    "134":   "133",
    "1208":  "133",
    "1187":  "133",
    "1166":  "133",
    "1128":  "133",
    "1212":  "133",
    "1262":  "133",
    "1153":  "133",
    "1250":  "133",
    "1206":  "133",
}

#: 全部行业(父类 + 子类)ID -> 名称,共 164 项
INDUSTRIES: Dict[str, str] = {**INDUSTRY_PARENTS, **INDUSTRY_SUBS}

# ── Country / Region(国家地区)──────────────────────────────
# /standard/countries — 241 项,ISO 3166-1 alpha-2
# 入参:country_code(人所在地)、company_hq_country_code(公司总部所在地)
# 出参:location_country_code / hq_country_code + 对应的 _name
COUNTRIES: Dict[str, str] = {
    "AF": "Afghanistan", "AX": "Aland Islands", "AL": "Albania", "DZ": "Algeria",
    "AS": "American Samoa", "AD": "Andorra", "AO": "Angola", "AI": "Anguilla",
    "AG": "Antigua and Barbuda", "AR": "Argentina", "AM": "Armenia", "AW": "Aruba",
    "AU": "Australia", "AT": "Austria", "AZ": "Azerbaijan", "BS": "Bahamas", "BH": "Bahrain",
    "BD": "Bangladesh", "BB": "Barbados", "BY": "Belarus", "BE": "Belgium", "BZ": "Belize",
    "BJ": "Benin", "BM": "Bermuda", "BT": "Bhutan", "BO": "Bolivia",
    "BA": "Bosnia and Herzegovina", "BW": "Botswana", "BR": "Brazil",
    "VG": "British Virgin Islands", "BN": "Brunei", "BG": "Bulgaria", "BF": "Burkina Faso",
    "BI": "Burundi", "CV": "Cabo Verde", "KH": "Cambodia", "CM": "Cameroon", "CA": "Canada",
    "KY": "Cayman Islands", "CF": "Central African Republic", "TD": "Chad", "CL": "Chile",
    "CN": "China", "CX": "Christmas Island", "CC": "Cocos Islands", "CO": "Colombia",
    "KM": "Comoros", "CK": "Cook Islands", "CR": "Costa Rica", "HR": "Croatia", "CU": "Cuba",
    "CW": "Curacao", "CY": "Cyprus", "CZ": "Czechia", "CD": "Democratic Republic of the Congo",
    "DK": "Denmark", "DJ": "Djibouti", "DM": "Dominica", "DO": "Dominican Republic",
    "EC": "Ecuador", "EG": "Egypt", "SV": "El Salvador", "GQ": "Equatorial Guinea",
    "ER": "Eritrea", "EE": "Estonia", "SZ": "Eswatini", "ET": "Ethiopia",
    "FK": "Falkland Islands", "FO": "Faroe Islands", "FJ": "Fiji", "FI": "Finland",
    "FR": "France", "GF": "French Guiana", "PF": "French Polynesia",
    "TF": "French Southern Territories", "GA": "Gabon", "GM": "Gambia", "GE": "Georgia",
    "DE": "Germany", "GH": "Ghana", "GI": "Gibraltar", "GR": "Greece", "GL": "Greenland",
    "GD": "Grenada", "GP": "Guadeloupe", "GU": "Guam", "GT": "Guatemala", "GG": "Guernsey",
    "GN": "Guinea", "GW": "Guinea-Bissau", "GY": "Guyana", "HT": "Haiti", "HN": "Honduras",
    "HK": "Hong Kong SAR", "HU": "Hungary", "IS": "Iceland", "IN": "India", "ID": "Indonesia",
    "IR": "Iran", "IQ": "Iraq", "IE": "Ireland", "IM": "Isle of Man", "IL": "Israel",
    "IT": "Italy", "CI": "Ivory Coast", "JM": "Jamaica", "JP": "Japan", "JE": "Jersey",
    "JO": "Jordan", "KZ": "Kazakhstan", "KE": "Kenya", "KI": "Kiribati", "XK": "Kosovo",
    "KW": "Kuwait", "KG": "Kyrgyzstan", "LA": "Laos", "LV": "Latvia", "LB": "Lebanon",
    "LS": "Lesotho", "LR": "Liberia", "LY": "Libya", "LI": "Liechtenstein", "LT": "Lithuania",
    "LU": "Luxembourg", "MO": "Macao SAR", "MG": "Madagascar", "MW": "Malawi",
    "MY": "Malaysia", "MV": "Maldives", "ML": "Mali", "MT": "Malta", "MH": "Marshall Islands",
    "MQ": "Martinique", "MR": "Mauritania", "MU": "Mauritius", "YT": "Mayotte", "MX": "Mexico",
    "FM": "Micronesia", "MD": "Moldova", "MC": "Monaco", "MN": "Mongolia", "ME": "Montenegro",
    "MS": "Montserrat", "MA": "Morocco", "MZ": "Mozambique", "MM": "Myanmar", "NA": "Namibia",
    "NR": "Nauru", "NP": "Nepal", "NL": "Netherlands", "NC": "New Caledonia",
    "NZ": "New Zealand", "NI": "Nicaragua", "NE": "Niger", "NG": "Nigeria", "NU": "Niue",
    "NF": "Norfolk Island", "KP": "North Korea", "MK": "North Macedonia",
    "MP": "Northern Mariana Islands", "NO": "Norway", "OM": "Oman", "PK": "Pakistan",
    "PW": "Palau", "PA": "Panama", "PG": "Papua New Guinea", "PY": "Paraguay", "PE": "Peru",
    "PH": "Philippines", "PN": "Pitcairn", "PL": "Poland", "PT": "Portugal",
    "PR": "Puerto Rico", "QA": "Qatar", "CG": "Republic of the Congo", "RE": "Reunion",
    "RO": "Romania", "RU": "Russia", "RW": "Rwanda", "BL": "Saint Barthelemy",
    "SH": "Saint Helena", "KN": "Saint Kitts and Nevis", "LC": "Saint Lucia",
    "MF": "Saint Martin", "PM": "Saint Pierre and Miquelon",
    "VC": "Saint Vincent and the Grenadines", "WS": "Samoa", "SM": "San Marino",
    "ST": "Sao Tome and Principe", "SA": "Saudi Arabia", "SN": "Senegal", "RS": "Serbia",
    "SC": "Seychelles", "SL": "Sierra Leone", "SG": "Singapore", "SX": "Sint Maarten",
    "SK": "Slovakia", "SI": "Slovenia", "SB": "Solomon Islands", "SO": "Somalia",
    "ZA": "South Africa", "GS": "South Georgia and the South Sandwich Islands",
    "KR": "South Korea", "SS": "South Sudan", "ES": "Spain", "LK": "Sri Lanka", "SD": "Sudan",
    "SR": "Suriname", "SJ": "Svalbard and Jan Mayen", "SE": "Sweden", "CH": "Switzerland",
    "SY": "Syria", "TW": "Taiwan", "TJ": "Tajikistan", "TZ": "Tanzania", "TH": "Thailand",
    "TL": "Timor Leste", "TG": "Togo", "TO": "Tonga", "TT": "Trinidad and Tobago",
    "TN": "Tunisia", "TR": "Turkey", "TM": "Turkmenistan", "TC": "Turks and Caicos Islands",
    "TV": "Tuvalu", "VI": "U.S. Virgin Islands", "UG": "Uganda", "UA": "Ukraine",
    "AE": "United Arab Emirates", "GB": "United Kingdom", "US": "United States",
    "UY": "Uruguay", "UZ": "Uzbekistan", "VU": "Vanuatu", "VA": "Vatican", "VE": "Venezuela",
    "VN": "Vietnam", "WF": "Wallis and Futuna", "YE": "Yemen", "ZM": "Zambia",
    "ZW": "Zimbabwe",
}

# ── 字典之外的已知取值 ────────────────────────────────────
#: 实测在出参里出现、但不在官方 29 项 job-functions 字典中的值。
#: 未验证能否作为入参过滤条件使用,当过滤条件前请自行实测。
UNDOCUMENTED_JOB_FUNCTIONS = {"GENERAL_MANAGEMENT"}  # people_enrichment 返回过

#: 校验用的宽松集合 = 官方字典 + 实测已知的额外值
KNOWN_JOB_FUNCTIONS = set(JOB_FUNCTIONS) | UNDOCUMENTED_JOB_FUNCTIONS

#: 入参字段 -> 合法取值集合。供 validate_enums() 使用。
ENUM_FIELDS: Dict[str, set] = {
    "job_level":               set(JOB_LEVELS),
    "function":                KNOWN_JOB_FUNCTIONS,
    "employee_range":          set(EMPLOYEE_RANGES),
    "industry":                set(INDUSTRIES),
    "country_code":            set(COUNTRIES),
    "company_hq_country_code": set(COUNTRIES),
}


def check_enum_values(body: dict) -> List[str]:
    """检查入参里的枚举字段取值是否落在字典内,返回问题描述列表。

    只做提示、不抛异常 —— 官方字典已知不完整(实测出现过字典外的
    GENERAL_MANAGEMENT),硬拦截会误伤合法取值。
    """
    problems = []
    for field, allowed in ENUM_FIELDS.items():
        raw = body.get(field)
        if raw is None:
            continue
        values = raw if isinstance(raw, (list, tuple)) else [raw]
        for v in values:
            if str(v) not in allowed:
                problems.append("{}={!r} 不在字典内".format(field, v))
    return problems



# ═══════════════════════════════════════════════════════════════════════════
# 参数校验层(给大模型/Agent 调用用)
# 大模型会写人话(job_level="CEO"、industry="Technology"、employee_range="51-200"),
# 而 AroundDeal 要的是代码。这些错误语法合法、请求发得出去、钱照扣,
# 但结果是空的或错的 —— 所以在发请求【之前】拦下来,并给出可纠正的提示。
# ═══════════════════════════════════════════════════════════════════════════

class AroundDealParamError(ValueError):
    """入参不合法。消息体是给大模型读的,包含合法取值与修正建议。"""


def _norm(v) -> str:
    """归一化:大写、去掉非字母数字,便于宽松匹配。"""
    return re.sub(r"[^A-Z0-9]", "", str(v).upper())


#: 常见错写 -> 正确值。key 已 _norm 处理。
_ALIAS_JOB_LEVEL = {
    "CEO": "CXO", "CTO": "CXO", "CFO": "CXO", "CMO": "CXO", "COO": "CXO",
    "CIO": "CXO", "CSO": "CXO", "CHIEF": "CXO", "CSUITE": "CXO", "CLEVEL": "CXO",
    "EXECUTIVE": "CXO", "EXEC": "CXO", "CHAIRMAN": "CXO", "PRESIDENT": "CXO",
    "FOUNDER": "OWNER", "COFOUNDER": "OWNER", "BOSS": "OWNER", "PROPRIETOR": "OWNER",
    "VICEPRESIDENT": "VP", "SVP": "VP", "EVP": "VP",
    "HEAD": "DIRECTOR", "HEADOF": "DIRECTOR", "LEAD": "MANAGER", "SUPERVISOR": "MANAGER",
    "INTERN": "TRAINEE", "INTERNSHIP": "TRAINEE", "APPRENTICE": "TRAINEE", "JUNIOR": "ENTRY",
    "STAFF": "SENIOR", "CONTRACTOR": "FREELANCER", "SELFEMPLOYED": "FREELANCER",
}

_ALIAS_FUNCTION = {
    "PROCUREMENT": "PURCHASING", "BUYER": "PURCHASING", "BUYING": "PURCHASING",
    "SOURCING": "PURCHASING", "PURCHASE": "PURCHASING", "VENDORMANAGEMENT": "PURCHASING",
    "SUPPLYCHAIN": "SUPPLY_CHAIN", "LOGISTICS": "LOGISTICS_AND_SUPPLY_CHAIN",
    "HR": "HUMAN_RESOURCES", "PEOPLE": "HUMAN_RESOURCES", "RECRUITING": "HUMAN_RESOURCES",
    "RND": "RD", "RANDD": "RD", "RESEARCHANDDEVELOPMENT": "RD",
    "BUSINESSDEVELOPMENT": "BD", "BIZDEV": "BD",
    "ENG": "ENGINEERING", "SOFTWARE": "ENGINEERING", "DEV": "ENGINEERING",
    "PM": "PRODUCT_MANAGEMENT", "PRODUCT": "PRODUCT_MANAGEMENT",
    "PROJECTMANAGEMENT": "PROGRAM_AND_PROJECT_MANAGEMENT",
    "QA": "QUALITY_ASSURANCE", "QC": "QUALITY_ASSURANCE",
    "INFORMATIONTECHNOLOGY": "IT", "TECH": "IT",
    "PR": "PUBLIC_RELATIONS", "COMMS": "MEDIA_COMMUNICATION",
    "GENERALMANAGEMENT": "GENERAL_MANAGEMENT",  # 字典外但实测存在
    "OPS": "OPERATIONS", "DESIGN": "ARTS_DESIGN", "MARKETINGS": "MARKETING",
}

_ALIAS_COUNTRY = {
    "UK": "GB", "ENGLAND": "GB", "BRITAIN": "GB", "UNITEDKINGDOM": "GB",
    "USA": "US", "UNITEDSTATES": "US", "AMERICA": "US",
    "UAE": "AE", "SOUTHKOREA": "KR", "KOREA": "KR", "NORTHKOREA": "KP",
    "RUSSIA": "RU", "VIETNAM": "VN", "IRAN": "IR", "SYRIA": "SY",
    "TAIWAN": "TW", "HONGKONG": "HK", "MACAU": "MO", "MACAO": "MO",
    "CZECHREPUBLIC": "CZ", "HOLLAND": "NL", "NETHERLAND": "NL",
}

#: 员工规模档位的数值边界,用于把 "51-200" 这类写法映射到字母 ID
_EMP_BOUNDS = [
    ("A", 1, 1), ("B", 2, 10), ("C", 11, 50), ("D", 51, 200), ("E", 201, 500),
    ("F", 501, 1000), ("G", 1001, 5000), ("H", 5001, 10000), ("I", 10001, 10**9),
]


#: 由字典自身生成的「归一化形式 -> 规范 ID」映射。
#: 手写别名表只管语义映射(CEO->CXO),这张表管书写差异
#: ("supply chain" / "SUPPLY-CHAIN" / "supply_chain" 都能落到 SUPPLY_CHAIN)。
#: 注意 _norm() 只保留 A-Z0-9,中文会被剥成空串 —— 必须过滤掉空 key,
#: 否则所有中文名都会撞进同一个桶。中文走下面的 _LABEL_* 精确表。
_NORM_JOB_LEVEL = {_norm(k): k for k in JOB_LEVELS if _norm(k)}
_NORM_FUNCTION = {_norm(k): k for k in KNOWN_JOB_FUNCTIONS if _norm(k)}

#: 中文名 -> ID 的精确映射(中文无法归一化,只能精确匹配)
_LABEL_JOB_LEVEL = {v: k for k, v in JOB_LEVELS.items()}
_LABEL_FUNCTION = {v: k for k, v in JOB_FUNCTIONS.items()}


def _suggest_employee_range(value) -> Optional[str]:
    v = str(value).strip()
    if _norm(v) in ("SELFEMPLOYED", "FREELANCER", "SOLO", "1"):
        return "A"
    nums = [int(x) for x in re.findall(r"\d+", v.replace(",", ""))]
    if not nums:
        return None
    open_ended = len(nums) == 1 and re.search(r"[+]|以上|over|above|more than|\bplus\b", v, re.I)
    if open_ended:
        # "10000+" 表示大于一万 -> 落到包含 10001 的那一档(I)
        target = nums[0] + 1
        for rid, blo, bhi in _EMP_BOUNDS:
            if blo <= target <= bhi:
                return rid
        return _EMP_BOUNDS[-1][0]
    if len(nums) == 1:
        # 单个数字按人数落桶:"2" -> B(2~10),"500" -> E(201~500)
        n = nums[0]
        for rid, blo, bhi in _EMP_BOUNDS:
            if blo <= n <= bhi:
                return rid
        return _EMP_BOUNDS[-1][0]
    lo = nums[0]
    hi = nums[1]
    best, score = None, None
    for rid, blo, bhi in _EMP_BOUNDS:
        d = abs(blo - lo) + abs(min(bhi, 10 ** 5) - min(hi, 10 ** 5))
        if score is None or d < score:
            best, score = rid, d
    return best


def suggest(field: str, value) -> Optional[str]:
    """把大模型写的人话映射回合法枚举值,映射不出来返回 None。

    >>> suggest("job_level", "CEO")
    'CXO'
    >>> suggest("industry", "Technology, Information and Media")
    '1594'
    """
    raw = str(value).strip()
    n = _norm(value)
    if field == "job_level":
        if raw in JOB_LEVELS:                      # 已经是规范值,原样返回
            return raw
        if raw in _LABEL_JOB_LEVEL:                # 中文名
            return _LABEL_JOB_LEVEL[raw]
        if not n:                                  # 归一化后为空,无从判断
            return None
        return _NORM_JOB_LEVEL.get(n) or _ALIAS_JOB_LEVEL.get(n)
    if field == "function":
        if raw in KNOWN_JOB_FUNCTIONS:
            return raw
        if raw in _LABEL_FUNCTION:
            return _LABEL_FUNCTION[raw]
        if not n:
            return None
        return _NORM_FUNCTION.get(n) or _ALIAS_FUNCTION.get(n)
    if field == "employee_range":
        return str(value) if str(value) in EMPLOYEE_RANGES else _suggest_employee_range(value)
    if field in ("country_code", "company_hq_country_code"):
        if str(value).upper() in COUNTRIES:
            return str(value).upper()
        if n and n in _ALIAS_COUNTRY:
            return _ALIAS_COUNTRY[n]
        for code, name in COUNTRIES.items():          # 全名反查
            if n and _norm(name) == n:
                return code
        return None
    if field == "industry":
        if str(value) in INDUSTRIES:
            return str(value)
        for iid, name in INDUSTRIES.items():          # 行业名反查 ID
            if n and _norm(name) == n:
                return iid
        for iid, name in INDUSTRIES.items():          # 退一步:包含匹配
            if n and n in _norm(name):
                return iid
        return None
    return None


#: 每个接口的必填输入组合。列表内任一「组」被满足即可;组内字段需全部提供。
REQUIRED_INPUTS: Dict[str, List[tuple]] = {
    "company_enrichment":        [("linkedin_url",), ("website",), ("name",)],
    "orgchart":                  [("linkedin_url",), ("website",), ("name",)],
    "company_job":               [("linkedin_url",), ("website",), ("name",)],
    "company_contact_discovery": [("linkedin_url",), ("website",), ("name",)],
    "company_clients":           [("name",), ("website",)],
    "company_suppliers":         [("name",), ("website",)],
    "company_events":            [("name",), ("website",)],
    "company_product":           [("name",), ("website",)],
    "people_enrichment":         [("linkedin_url",), ("email",), ("name", "company")],
    "resume_enrichment":         [("linkedin_url",), ("email",)],
    "email_to_linkedin_profile": [("email",)],
    "contact_verification_email": [("email",)],
    "contact_verification_phone": [("phone",)],
    "company_relationship_check": [("name_a", "name_b"), ("website_a", "website_b")],
}

#: 参数上限。(字段, 最大值),超限报错。
#: ⚠️ 服务端超限时【不报错、静默截断】—— company_search 传 size=100 返回 10 条且
#: success=True;people_search 传 limit=100 返回 10 条且把 limit 回显成 10。
#: 本地拦住是为了让调用方(尤其是大模型)知道要翻页,而不是误以为只有 10 条数据。
PARAM_LIMITS: Dict[str, Dict[str, int]] = {
    "company_search": {"size": 10, "page": 1000},
    "people_search":  {"size": 10, "limit": 10},
}

#: 已废弃参数 -> 应改用的新参数
DEPRECATED_PARAMS = {"role": "title", "seniority": "job_level", "region": "location"}

#: 两套分页参数,同时给会以 start+limit 为准
_PAGINATION_A = ("start", "limit")
_PAGINATION_B = ("page", "size")



#: 枚举字段 -> 可读名称字典,用于把报错里的 ID 翻成人能看懂的样子
_ENUM_LABELS = {
    "job_level": JOB_LEVELS, "function": JOB_FUNCTIONS,
    "employee_range": EMPLOYEE_RANGES, "industry": INDUSTRIES,
    "country_code": COUNTRIES, "company_hq_country_code": COUNTRIES,
}


def _enum_help(field: str, allowed) -> str:
    """生成给大模型看的合法取值说明。

    小字典(<=30 项)全列;大字典只给几个样例并说明去哪查,
    避免把 241 个国家码糊进报错里。
    """
    labels = _ENUM_LABELS.get(field, {})
    items = sorted(allowed)
    if len(items) <= 30:
        return "合法取值({} 个):{}".format(
            len(items), ", ".join("{}({})".format(k, labels.get(k, "?")) for k in items))
    sample = [k for k in items if k in labels][:6]
    return "合法取值共 {} 个,须传 ID 而非名称。示例:{}。完整字典见 {}。".format(
        len(items),
        ", ".join("{}={}".format(labels[k], k) for k in sample),
        "COUNTRIES" if field.endswith("country_code") else "INDUSTRIES")


def validate_request(function_name: str, body: dict) -> List[str]:
    """发请求前做完整校验,返回错误列表(空 = 通过)。

    覆盖 5 类:枚举取值、必填组合、参数上限、废弃参数、分页混用。
    消息面向大模型,带合法取值与修正建议。
    """
    errors: List[str] = []

    # 1. 枚举取值 + 修正建议
    for field, allowed in ENUM_FIELDS.items():
        raw = body.get(field)
        if raw is None:
            continue
        for v in (raw if isinstance(raw, (list, tuple)) else [raw]):
            if str(v) in allowed:
                continue
            fix = suggest(field, v)
            hint = "你应该用 {!r}。".format(fix) if fix else ""
            errors.append("{}={!r} 不是合法值。{}{}".format(
                field, v, hint, _enum_help(field, allowed)))

    # 2. 必填输入组合
    groups = REQUIRED_INPUTS.get(function_name)
    if groups and not any(all(body.get(f) for f in g) for g in groups):
        opts = " 或 ".join("+".join(g) for g in groups)
        errors.append("{} 缺少必填输入,至少提供:{}".format(function_name, opts))

    # 3. 参数上限
    for field, cap in PARAM_LIMITS.get(function_name, {}).items():
        v = body.get(field)
        if v is not None and int(v) > cap:
            errors.append(
                "{}={} 超过上限 {}(服务端会静默截断到 {},不会报错)。"
                "要更多结果请翻页:{}".format(
                    field, v, cap, cap,
                    "page 递增" if function_name == "company_search" else "start 按 limit 递增"))

    # 4. 废弃参数
    for old, new in DEPRECATED_PARAMS.items():
        if body.get(old) is not None:
            errors.append("{} 已废弃,请改用 {}。".format(old, new))

    # 5. 分页混用
    if any(body.get(f) is not None for f in _PAGINATION_A) and \
       any(body.get(f) is not None for f in _PAGINATION_B):
        errors.append("同时给了 start+limit 和 page+size;服务端以 start+limit 为准,请只用一套。")

    return errors


def describe(field: str, value: str) -> str:
    """把出参里的枚举 ID 翻成可读名称,查不到就原样返回。

    >>> describe("job_level", "CXO")
    'C 级高管'
    """
    table = {
        "job_level": JOB_LEVELS, "function": JOB_FUNCTIONS,
        "employee_range": EMPLOYEE_RANGES, "employee_range_id": EMPLOYEE_RANGES,
        "type_id": COMPANY_TYPES, "industry": INDUSTRIES, "industry_id": INDUSTRIES,
        "country_code": COUNTRIES, "hq_country_code": COUNTRIES,
        "location_country_code": COUNTRIES, "company_hq_country_code": COUNTRIES,
    }.get(field, {})
    return table.get(str(value), str(value))


# ── 采购/供应链决策人预设(对应 apollo_client 的 DEFAULT_SOURCING_*)──────────
# AroundDeal 用结构化枚举,不用 title 关键词列表;字典见 /standard/job-levels、/job-functions
# 取值均来自上面的 JOB_LEVELS / JOB_FUNCTIONS,改动前先对照字典
DEFAULT_SOURCING_JOB_LEVELS = ["CXO", "VP", "DIRECTOR", "MANAGER"]
DEFAULT_SOURCING_FUNCTIONS = [
    "PURCHASING", "SUPPLY_CHAIN", "LOGISTICS_AND_SUPPLY_CHAIN", "OPERATIONS",
]

DEFAULT_BRAND_JOB_LEVELS = ["OWNER", "PARTNER", "CXO", "VP", "DIRECTOR"]
DEFAULT_BRAND_FUNCTIONS = [
    "MARKETING", "PRODUCT_MANAGEMENT", "BD", "SALES",
    # 见 UNDOCUMENTED_JOB_FUNCTIONS:GENERAL_MANAGEMENT 实测在出参出现过,
    # 但不在官方 29 项字典里,也未验证能否当入参过滤。需要时放开并实测。
    # "GENERAL_MANAGEMENT",
]

# 采购类职位关键词(people_search 的 title 是自由文本,可与枚举叠加使用)
DEFAULT_SOURCING_TITLES = [
    "sourcing manager", "supply chain manager", "procurement manager",
    "buyer", "purchasing manager", "vendor manager", "strategic sourcing",
]


# ── 内部网关端点映射 ─────────────────────────────────────────
# 旧 function_name → (gateway path, body 字段映射, 需转逗号串的字段, 额外固定字段)。
# 语义与旧 AroundDeal 直连保持一致，仅底层换成 blade-agent-adapter（防 key 泄漏）。
_GATEWAY: Dict[str, Dict[str, Any]] = {
    "company_enrichment": {
        "path": "/agent/arounddeal/companyEnrichment.json",
        "fields": {"linkedin_url": "linkedinUrl", "website": "website", "name": "name"},
    },
    "people_enrichment": {
        "path": "/agent/arounddeal/enrichPerson.json",
        "fields": {"linkedin_url": "linkedinUrl", "email": "email", "name": "name", "company": "company"},
    },
    "resume_enrichment": {
        "path": "/agent/arounddeal/resumeEnrichment.json",
        "fields": {"linkedin_url": "linkedinUrl", "email": "email"},
    },
    "company_contact_discovery": {
        "path": "/agent/arounddeal/findContacts.json",
        "fields": {
            "linkedin_url": "linkedinUrl", "website": "website", "name": "name",
            "job_level": "jobLevel", "function": "function", "country_code": "countryCode",
            "industry": "industry", "employee_range": "employeeRange",
            "company_hq_country_code": "companyHqCountryCode",
            "require_email_business": "requireEmailBusiness",
            "start": "start", "limit": "limit", "page": "page", "size": "size",
        },
        "csv_fields": {"jobLevel", "function", "countryCode", "industry", "employeeRange", "companyHqCountryCode"},
    },
    "company_search": {
        "path": "/agent/arounddeal/searchCompanies.json",
        "fields": {"keyword": "keyword", "country_code": "countryCode", "industry": "industry",
                   "employee_range": "employeeRange", "page": "page", "size": "size"},
        "csv_fields": {"countryCode", "industry", "employeeRange"},
    },
    "people_search": {
        "path": "/agent/arounddeal/searchPeople.json",
        "fields": {"title": "title", "job_level": "jobLevel", "function": "function",
                   "country_code": "countryCode", "location": "location", "industry": "industry",
                   "employee_range": "employeeRange", "company_hq_country_code": "companyHqCountryCode",
                   "start": "start", "limit": "limit", "page": "page", "size": "size"},
        "csv_fields": {"jobLevel", "function", "countryCode", "industry", "employeeRange", "companyHqCountryCode"},
    },
    "contact_verification_email": {
        "path": "/agent/arounddeal/verifyContact.json",
        "fields": {"email": "email"},
    },
    "contact_verification_phone": {
        "path": "/agent/arounddeal/verifyContact.json",
        "fields": {"phone": "phone"},
    },
    "email_to_linkedin_profile": {
        "path": "/agent/arounddeal/emailToLinkedin.json",
        "fields": {"email": "email"},
    },
    "company_clients": {
        "path": "/agent/arounddeal/companyIntel.json",
        "fields": {"name": "name", "website": "website"},
        "extra": {"type": "clients"},
    },
    "company_suppliers": {
        "path": "/agent/arounddeal/companyIntel.json",
        "fields": {"name": "name", "website": "website"},
        "extra": {"type": "suppliers"},
    },
    "company_events": {
        "path": "/agent/arounddeal/companyIntel.json",
        "fields": {"name": "name", "website": "website"},
        "extra": {"type": "events"},
    },
    "company_product": {
        "path": "/agent/arounddeal/companyIntel.json",
        "fields": {"name": "name", "website": "website"},
        "extra": {"type": "products"},
    },
    "company_job": {
        "path": "/agent/arounddeal/companyIntel.json",
        "fields": {"linkedin_url": "linkedinUrl", "website": "website", "name": "name"},
        "extra": {"type": "jobs"},
    },
    "orgchart": {
        "path": "/agent/arounddeal/companyIntel.json",
        "fields": {"linkedin_url": "linkedinUrl", "website": "website", "name": "name"},
        "extra": {"type": "orgchart"},
    },
    "company_relationship_check": {
        "path": "/agent/arounddeal/checkRelationship.json",
        "fields": {"name_a": "nameA", "website_a": "websiteA",
                   "name_b": "nameB", "website_b": "websiteB"},
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
    out.update(cfg.get("extra", {}))
    return out


class AroundDealClient:
    """AroundDeal 客户端（经内部 blade-agent-adapter 网关，防 key 泄漏）"""

    def __init__(self, api_key: Optional[str] = None, timeout: int = 60,
                 max_retries: int = 3, strict: bool = True):
        # api_key 参数保留以兼容旧调用方（_ad.py 的 --api-key），但底层已改走内部网关，
        # 不再需要 AroundDeal 的 Bearer key，此处忽略。
        self.base_url = env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL)
        self.open_id = env("MIO_V_OPEN_ID", "") or ""
        self.supplier_id = env("MIO_CDP_SUPPLIER_ID", "") or ""
        self.timeout = timeout
        self.max_retries = max_retries
        #: True(默认):参数不合法时在【发请求前】抛 AroundDealParamError,
        #: 不产生任何费用,报错文案面向大模型、带修正建议。Agent 场景务必保持 True。
        #: False:降级为 warnings,请求照发(旧行为)。
        #: 注意官方枚举字典已知不完整(见 UNDOCUMENTED_JOB_FUNCTIONS),
        #: 若确认某个字典外取值合法,加进对应集合而不是关掉 strict。
        self.strict = strict
        #: 本实例累计的估算花费(USD)。【上界,实测偏高约 2~25%】,
        #: 只用于粗略感知,不可当账。
        self.estimated_spend = 0.0
        #: 最近一次调用的完整响应包,排查用
        self.last_raw: Any = None

    # ── Enrichment ────────────────────────────────────────

    def company_enrichment(self, linkedin_url: Optional[str] = None,
                           website: Optional[str] = None,
                           name: Optional[str] = None) -> dict:
        """公司画像(39 字段)。优先级 linkedin_url > website > name。

        ⚠️ 只传 website/name 可能匹配到子品牌(实测 www.microsoft.com 命中
        "Microsoft for Startups"),务必校验返回的 linkedin_identifier。
        """
        return self._call("company_enrichment", _compact(
            linkedin_url=linkedin_url, website=website, name=name))

    def people_enrichment(self, linkedin_url: Optional[str] = None,
                          email: Optional[str] = None,
                          name: Optional[str] = None,
                          company: Optional[str] = None) -> dict:
        """人物联系方式 + 当前职位(14 字段)。不含履历,履历用 resume_enrichment。"""
        return self._call("people_enrichment", _compact(
            linkedin_url=linkedin_url, email=email, name=name, company=company))

    def resume_enrichment(self, linkedin_url: Optional[str] = None,
                          email: Optional[str] = None) -> dict:
        """人物履历/教育/技能(实测 23 字段)。不含邮箱电话。"""
        return self._call("resume_enrichment", _compact(
            linkedin_url=linkedin_url, email=email))

    def company_contact_discovery(self, linkedin_url: Optional[str] = None,
                                  website: Optional[str] = None,
                                  name: Optional[str] = None,
                                  job_level: Optional[List[str]] = None,
                                  function: Optional[List[str]] = None,
                                  country_code: Optional[List[str]] = None,
                                  industry: Optional[List[str]] = None,
                                  employee_range: Optional[List[str]] = None,
                                  company_hq_country_code: Optional[List[str]] = None,
                                  require_email_business: Optional[bool] = None,
                                  start: Optional[int] = None,
                                  limit: Optional[int] = None,
                                  page: Optional[int] = None,
                                  size: Optional[int] = None) -> dict:
        """按 persona 找公司内联系人。返回 {count, start, limit, list}。

        ⚠️ 按「每条记录」计费 $0.50/人,必须显式传 limit(或 size)。
        """
        return self._call("company_contact_discovery", _compact(
            linkedin_url=linkedin_url, website=website, name=name,
            job_level=job_level, function=function, country_code=country_code,
            industry=industry, employee_range=employee_range,
            company_hq_country_code=company_hq_country_code,
            require_email_business=require_email_business,
            start=start, limit=limit, page=page, size=size))

    def search_sourcing_contacts(self, linkedin_url: Optional[str] = None,
                                 website: Optional[str] = None,
                                 name: Optional[str] = None,
                                 limit: int = 5) -> dict:
        """快捷方法:找公司的采购/供应链决策人。"""
        return self.company_contact_discovery(
            linkedin_url=linkedin_url, website=website, name=name,
            job_level=DEFAULT_SOURCING_JOB_LEVELS,
            function=DEFAULT_SOURCING_FUNCTIONS,
            limit=limit)

    def search_brand_contacts(self, linkedin_url: Optional[str] = None,
                              website: Optional[str] = None,
                              name: Optional[str] = None,
                              limit: int = 5) -> dict:
        """快捷方法:找公司的高管/品牌负责人。"""
        return self.company_contact_discovery(
            linkedin_url=linkedin_url, website=website, name=name,
            job_level=DEFAULT_BRAND_JOB_LEVELS,
            function=DEFAULT_BRAND_FUNCTIONS,
            limit=limit)

    # ── Search ────────────────────────────────────────────

    def company_search(self, keyword: Optional[str] = None,
                       country_code: Optional[List[str]] = None,
                       industry: Optional[List[str]] = None,
                       employee_range: Optional[List[str]] = None,
                       page: Optional[int] = None,
                       size: Optional[int] = None) -> dict:
        """搜公司。size 最大 10,page 最大 1000;count 封顶 10001。"""
        return self._call("company_search", _compact(
            keyword=keyword, country_code=country_code, industry=industry,
            employee_range=employee_range, page=page, size=size))

    def people_search(self, title: Optional[str] = None,
                      job_level: Optional[List[str]] = None,
                      function: Optional[List[str]] = None,
                      country_code: Optional[List[str]] = None,
                      location: Optional[str] = None,
                      industry: Optional[List[str]] = None,
                      employee_range: Optional[List[str]] = None,
                      company_hq_country_code: Optional[List[str]] = None,
                      start: Optional[int] = None,
                      limit: Optional[int] = None,
                      page: Optional[int] = None,
                      size: Optional[int] = None) -> dict:
        """搜人。实测返回 {count, start, limit, list}(不是文档写的 page)。"""
        return self._call("people_search", _compact(
            title=title, job_level=job_level, function=function,
            country_code=country_code, location=location, industry=industry,
            employee_range=employee_range,
            company_hq_country_code=company_hq_country_code,
            start=start, limit=limit, page=page, size=size))

    # ── Identity ──────────────────────────────────────────

    def verify_email(self, email: str) -> dict:
        return self._call("contact_verification_email", {"email": email})

    def verify_phone(self, phone: str) -> dict:
        return self._call("contact_verification_phone", {"phone": phone})

    def email_to_linkedin_profile(self, email: str) -> dict:
        return self._call("email_to_linkedin_profile", {"email": email})

    # ── Company Intelligence ──────────────────────────────

    def company_clients(self, name: Optional[str] = None,
                        website: Optional[str] = None) -> dict:
        return self._call("company_clients", _compact(name=name, website=website))

    def company_suppliers(self, name: Optional[str] = None,
                          website: Optional[str] = None) -> dict:
        return self._call("company_suppliers", _compact(name=name, website=website))

    def company_events(self, name: Optional[str] = None,
                       website: Optional[str] = None) -> dict:
        return self._call("company_events", _compact(name=name, website=website))

    def company_product(self, name: Optional[str] = None,
                        website: Optional[str] = None) -> dict:
        return self._call("company_product", _compact(name=name, website=website))

    def company_job(self, linkedin_url: Optional[str] = None,
                    website: Optional[str] = None,
                    name: Optional[str] = None) -> dict:
        """公司在招职位。实测返回 {time, list};命中但 list 为空仍扣费。"""
        return self._call("company_job", _compact(
            linkedin_url=linkedin_url, website=website, name=name))

    def orgchart(self, linkedin_url: Optional[str] = None,
                 website: Optional[str] = None,
                 name: Optional[str] = None) -> dict:
        return self._call("orgchart", _compact(
            linkedin_url=linkedin_url, website=website, name=name))

    def company_relationship_check(self, name_a: Optional[str] = None,
                                   website_a: Optional[str] = None,
                                   name_b: Optional[str] = None,
                                   website_b: Optional[str] = None) -> dict:
        return self._call("company_relationship_check", _compact(
            name_a=name_a, website_a=website_a, name_b=name_b, website_b=website_b))

    # ── 内部方法 ──────────────────────────────────────────

    def _guard_per_record_billing(self, function_name: str, body: dict) -> None:
        """按条计费的接口必须显式限流,防止一次调用烧掉大额余额。"""
        params = PER_RECORD_BILLING.get(function_name)
        if not params:
            return
        if not any(body.get(p) for p in params):
            raise ValueError(
                "{} 按条返回,必须显式指定 {}(上限 {})".format(
                    function_name, " 或 ".join(params), CONTACT_DISCOVERY_MAX_RECORDS))
        for p in params:
            v = body.get(p)
            if v is not None and int(v) > CONTACT_DISCOVERY_MAX_RECORDS:
                raise ValueError(
                    "{} 的 {}={} 超过单次上限 {}。"
                    "确需放开请调整 CONTACT_DISCOVERY_MAX_RECORDS。".format(
                        function_name, p, v, CONTACT_DISCOVERY_MAX_RECORDS))

    def _call(self, function_name: str, body: dict) -> dict:
        """统一调用。返回 {"success": bool, ...},业务失败不抛异常。

        成功: {"success": True, "status": "SUCCESS", "data": ..., "hint": ...}
        失败: {"success": False, "status": "ERROR", "error": {"code","detail"}, ...}
        """
        cfg = _GATEWAY.get(function_name)
        if cfg is None:
            return {"success": False,
                    "error": {"code": "UNSUPPORTED",
                              "detail": "未映射到内部网关: {}".format(function_name)}}
        if not self.open_id or not self.supplier_id:
            return {"success": False,
                    "error": {"code": "AUTH:NO_ID",
                              "detail": "缺少 MIO_V_OPEN_ID / MIO_CDP_SUPPLIER_ID(检查 .env)"}}

        self._guard_per_record_billing(function_name, body)

        problems = validate_request(function_name, body)
        if problems:
            if self.strict:
                raise AroundDealParamError(
                    "[{}] 参数不合法,请求未发出(未产生费用):\n  - {}".format(
                        function_name, "\n  - ".join(problems)))
            for problem in problems:
                warnings.warn("[{}] {}".format(function_name, problem), stacklevel=3)

        gw_body = _transform_body(cfg, body)

        resp: Dict[str, Any] = {}
        for attempt in range(self.max_retries):
            resp = post_json(
                base_url=self.base_url,
                path=cfg["path"],
                body=gw_body,
                open_id=self.open_id,
                supplier_id=self.supplier_id,
                timeout=self.timeout,
            )
            # 仅传输层失败(网络 -1 / 服务端 >=500)才重试；业务失败不重试
            code = resp.get("code")
            transport_fail = (not resp.get("success")) and (
                code == -1 or (isinstance(code, int) and code >= 500))
            if transport_fail and attempt < self.max_retries - 1:
                time.sleep(1.5 ** attempt)
                continue
            break

        self.last_raw = resp
        if not resp.get("success"):
            return {"success": False,
                    "error": {"code": str(resp.get("code", "?")),
                              "detail": resp.get("msg") or "(无 detail)"}}

        inner = resp.get("data") or {}
        status = inner.get("status")
        ok = status == "SUCCESS"
        if ok:
            # 未命中(PROFILE:NOT_FOUND)实测不扣费,只在成功时累计
            self.estimated_spend += PRICING.get(function_name, 0.0)
            return {"success": True, "status": status,
                    "data": inner.get("data"), "hint": inner.get("hint", "")}
        return {"success": False, "status": status,
                "error": inner.get("error") or {"code": "UNKNOWN",
                                               "detail": inner.get("msg", "")}}


def _compact(**kwargs) -> dict:
    """丢掉 None,AroundDeal 对空值不友好。"""
    return {k: v for k, v in kwargs.items() if v is not None}


# ── DC-LS 集成(卡片结构与 apollo_client.format_*_for_dc_ls 对齐)────────────

def format_people_for_dc_ls(people: List[dict]) -> List[dict]:
    """将 AroundDeal people 结果(people_search / company_contact_discovery 的
    list 项)格式化为 DC-LS 联系人卡片。"""
    cards = []
    for p in people:
        phones = [x for x in (p.get("phone_mobile"), p.get("phone_tel")) if x]
        cards.append({
            "name": p.get("name", "") or "{} {}".format(
                p.get("first_name", ""), p.get("last_name", "")).strip(),
            "title": p.get("title", ""),
            "organization": p.get("company_name", ""),
            "seniority": p.get("job_level", ""),
            "linkedin_url": p.get("linkedin_url", ""),
            "email": p.get("email_business", "") or p.get("email_personal", ""),
            "phone": phones,
            # AroundDeal 无稳定 person id,用 linkedin_url 作身份键
            "source": "arounddeal",
        })
    return cards


def format_contact_for_dc_ls(contact: dict) -> dict:
    """将单条 AroundDeal people_enrichment / email_to_linkedin 结果格式化为卡片。"""
    return format_people_for_dc_ls([contact])[0]


# ── CLI ───────────────────────────────────────────────────
if __name__ == "__main__":
    client = AroundDealClient()

    if len(sys.argv) < 2:
        print("用法:")
        print("  python arounddeal_client.py <linkedin_url|domain> [--enrich|--sourcing|--brand|--orgchart]")
        print("    公司画像 / 找采购决策人 / 找高管 / 组织架构")
        print("  python arounddeal_client.py --companies <keyword> [--country US] [--employees D]")
        print("    按关键词搜公司")
        print("示例:")
        print("  python arounddeal_client.py https://www.linkedin.com/company/microsoft/ --sourcing")
        print("  python arounddeal_client.py --companies Technology --country US --employees D")
        sys.exit(1)

    def _fail(r: dict) -> str:
        e = r.get("error") or {}
        return "{}: {}".format(e.get("code", "?"), e.get("detail", "") or "(无 detail)")

    # ── 公司搜索 ──
    if sys.argv[1] == "--companies":
        if len(sys.argv) < 3:
            print("❌ 缺少关键词")
            sys.exit(1)
        keyword, country, employees, size = sys.argv[2], "US", None, 10
        i = 3
        while i < len(sys.argv):
            if sys.argv[i] == "--country" and i + 1 < len(sys.argv):
                country = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--employees" and i + 1 < len(sys.argv):
                employees = [sys.argv[i + 1]]; i += 2
            elif sys.argv[i] == "--size" and i + 1 < len(sys.argv):
                size = int(sys.argv[i + 1]); i += 2
            else:
                i += 1
        r = client.company_search(keyword=keyword, country_code=[country],
                                  employee_range=employees, size=size)
        if r.get("success"):
            d = r["data"]
            print("✅ '{}' {}: {} 家 (total: {})".format(
                keyword, country, len(d.get("list", [])), d.get("count", "?")))
            for c in d.get("list", []):
                print("  {} | {} | {} | {}".format(
                    c.get("name", "?"), c.get("website_url") or "—",
                    (c.get("industry") or [{}])[0].get("name", "—"),
                    c.get("employee_range_name", "—")))
        else:
            print("❌ '{}': {}".format(keyword, _fail(r)))
        sys.exit(0)

    # ── 公司维度 ──
    target = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "--enrich"
    kw = {"linkedin_url": target} if "linkedin.com" in target else {"website": target}

    if mode == "--sourcing":
        r = client.search_sourcing_contacts(**kw)
    elif mode == "--brand":
        r = client.search_brand_contacts(**kw)
    elif mode == "--orgchart":
        r = client.orgchart(**kw)
    else:
        r = client.company_enrichment(**kw)

    if not r.get("success"):
        print("❌ {}: {}".format(target, _fail(r)))
        sys.exit(1)

    d = r["data"]
    if mode in ("--sourcing", "--brand"):
        print("✅ {}: {}/{} 人".format(target, len(d.get("list", [])), d.get("count", "?")))
        for card in format_people_for_dc_ls(d.get("list", [])):
            print("  {} | {} | {} | {} | {}".format(
                card["name"], card["title"], card["seniority"],
                card["email"] or "—", card["linkedin_url"] or "—"))
    elif mode == "--orgchart":
        print("✅ {} | 高管 {} 人 | 部门 {} 个".format(
            (d.get("profile") or {}).get("name", "?"),
            len(d.get("executives", [])), len(d.get("departments", []))))
        for e in d.get("executives", []):
            print("  [高管] {} | {}".format(e.get("name", "?"), e.get("title", "")))
    else:
        print("✅ {} | {} | {} | {}".format(
            d.get("name", "?"), d.get("industry_name", "—"),
            d.get("employee_range_name", "—"), d.get("hq_country_name", "—")))
        print("   linkedin_identifier={}  ← 务必校验是否为目标实体".format(
            d.get("linkedin_identifier", "—")))
