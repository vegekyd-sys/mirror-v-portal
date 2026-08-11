#!/usr/bin/env python3
"""
DealClaw DC-LS 搜索执行引擎
=============================
封装米奥 CDP 开放接口 + DC-LS 标准输出格式。

支持的 CDP 接口:
    searchAIV2.json            搜买家公司
    getCdpDetails.json         按 companyCdpId 查详情 + 贸易统计
    AiSearchGetCdpContact.json 按 companyCdpId 查联系人（真实邮箱/手机）

快速上手:
    # 找买家：产品品类词走 --tag-keyword 或 --profile-keyword，不要走 --keyword
    python3 dealclaw_search.py --tag-keyword "Promotional Drinkware" --country AE --size 10
    python3 dealclaw_search.py --profile-keyword "vacuum flask" --country AE --size 10

    # 搜已知公司名才用 --keyword
    python3 dealclaw_search.py --keyword "Stanley" --country AE

    # 拿联系人（真实邮箱/手机，无需 Apollo reveal）
    python3 dealclaw_search.py --contact "CO4A78...,CO84D0..."


==============================================================================
搜索字段怎么选（最重要，选错等于白搜）
==============================================================================

三个文本字段搜的是**完全不同的对象**，不可互换：

  --keyword         → 匹配【公司名】
                      只适合搜已知公司/品牌名。产品品类词放这里基本搜不到：
                      库里没有公司叫 "drinkware"，所以 keyword=drinkware 返回 0 条。
                      而 keyword=insulated 会命中一堆建筑保温公司（STYRO INSULATION）。

  --profile-keyword → 匹配【公司简介】
                      公司自己写的业务描述。产品品类词的兜底选择。
                      profileKeyword=drinkware → 30 条，含 STANLEY MIDDLE EAST。

  --tag-keyword     → 匹配【采购品类标签】（推荐）
                      平台按实际采购行为打的四级标签，最贴近「这家公司买什么」。
                      只认英文标签名，中文返回 0 条。
                      层级越深越精准：
                          "Gifts & Crafts"        (t2 层) → 5629 条，铺量用
                          "Promotional Drinkware" (t4 层) →   85 条，精准用

怎么找到正确的标签名：
    1. 先用 --profile-keyword 搜个大概，拿到几家明显对的公司
    2. 用 --details <companyCdpId> 看它的 sortedT2TagInfo，取里面的 nameEn
    3. 拿这个精确标签名走 --tag-keyword

关键行为（实测，文档未写）：
    * 多词是 OR 不是 AND。"Promotional Drinkware" 与 "Promotional" 返回完全相同
      （均 214 条），而 "Drinkware" 单独为 0 —— 多余的词只会累加噪声。
      => 一次只传一个词或一个完整短语。
    * --keyword 与 --profile-keyword 同时传时是 AND（交集），会大幅收窄召回，
      但精度很高，可作为「高精度模式」使用。
    * --country 大小写敏感：AE 有结果，ae 和 Ae 均返回 0 条。
      本脚本已自动转大写，但调用方仍建议传大写。


==============================================================================
枚举参数取值表
==============================================================================
以下取值官方文档未提供，为 2026-08-05 对生产环境黑盒探测所得。
文档已给出 companyInfo 的 1=有官网、2=有座机，探测结果与之吻合，方法可信。
标 [待验证] 的项建议与米奥方核对后再依赖。

--company-attributes  公司属性（买家类型）
    入参传数字编码，接口返回的 companyAttributes 字段则是中文。
    传中文（如「分销商」）一律返回 0 条。10 及以上无效。
        1  生产商/制造商      —— 通常是同行，找买家时建议排除
        2  分销商
        3  零售商            ┐ 大买家常在这两类，且公司名里
        9  大型商超          ┘ 往往没有产品词，只能靠属性挖出来
        4  电商平台
        5  代理商/承包商
        6  物流服务商
        7  媒体/机构/政府
        8  咨询/金融服务

--company-info  公司层面的联系方式/信息完整度
        1  有官网       (文档已注明，探测吻合)
        2  有座机       (文档已注明，探测吻合)
        3  有邮箱
        4  有手机       [待验证]
        5  有WhatsApp   [待验证]
        6  有Facebook
        7  有LinkedIn
        8  有Twitter

--contact-info  联系人层面筛选
        2  有联系人姓名
        7  联系人有WhatsApp
        1/3/4/5 确有过滤效果但维度未识别 [待验证]
        6/8 结果集极小，疑似组合条件 [待验证]

多值语义：company-info / contact-info 多值是 AND（交集），不是 OR。
    --company-info 3,4  意思是「邮箱和手机都要有」，不是「至少有一个」。
    想要「至少有一个联系方式」请用 --require-contact（客户端过滤，语义精确）。

features 参数：实测 1,2,3,4,6,8,9,10 均不产生过滤，仅 5、7 有效果且含义未知，
    故本脚本不暴露该参数。


==============================================================================
输出
==============================================================================
JSON，含 summary(气泡摘要) + records(表格数据) + pagination + gate_report。
搜索结果中的 emailsValid / mobilesValid 等字段是**脱敏标记**（值为 ["1"]），
只表示「有没有」，不是真实邮箱手机。真实联系方式必须用 --contact 模式获取。
"""

import argparse

# Shadow billing: log credit estimation without deducting (内测期)
try:
    from dc_billing import billing
except ImportError:
    billing = None
import hashlib
import hmac
import json
import os
import re
import sys
import time
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError


# ── 配置 ──────────────────────────────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENV_KEYS = (
    "MIO_CDP_APP_KEY",
    "MIO_CDP_APP_SECRET",
    "MIO_CDP_BASE_URL",
    "MIO_CDP_SUPPLIER_ID",
    "MIO_CDP_PPS_ID",
)


def _parse_env_line(line: str) -> Optional[tuple]:
    """解析 .env 一行，剥掉包裹引号。

    带引号写法 KEY="value" 若不剥引号，引号会混进 HMAC 导致「签名校验失败」，
    而该报错很难联想到是 .env 写法问题，故在此统一处理。
    """
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        return None
    k, v = line.split("=", 1)
    return k.strip(), v.strip().strip('"').strip("'")


def _load_env_files() -> None:
    """从脚本同目录起向上查找 .env，逐个补齐所有 MIO_CDP_* 变量。

    原实现只在向上查找时捞 APP_KEY / APP_SECRET 两个键，导致 SUPPLIER_ID /
    PPS_ID 配在上级 .env 时永远读不到，静默回落到占位值。此处统一捞全部键。
    """
    for up in range(5):
        path = os.path.normpath(os.path.join(_HERE, *([".."] * up), ".env"))
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    kv = _parse_env_line(line)
                    if kv and kv[0] in _ENV_KEYS and not os.environ.get(kv[0]):
                        os.environ[kv[0]] = kv[1]
        except OSError:
            continue


_load_env_files()

APP_KEY = os.environ.get("MIO_CDP_APP_KEY", "")
APP_SECRET = os.environ.get("MIO_CDP_APP_SECRET", "")
BASE_URL = os.environ.get(
    "MIO_CDP_BASE_URL",
    "https://apidiscovery.datathink.com/meorient/openApi/cdp",
)

# supplierId / ppsId 由平台分配。接口仅做非空校验，取值不参与检索——任意非空
# 字符串返回的搜索结果完全相同。但使用无效值时，invitationFlag / checkFlag /
# unLockFlag 这三个绑定展商的状态过滤会被忽略（传 0 和传 1 结果一样），
# 即「排除已邀约买家」等能力失效。见 gate_preflight 中的告警。
_PLACEHOLDER_IDS = {"supplier-id-001", "pps-id-001", ""}
SUPPLIER_ID = os.environ.get("MIO_CDP_SUPPLIER_ID", "supplier-id-001")
PPS_ID = os.environ.get("MIO_CDP_PPS_ID", "pps-id-001")


# ── 参数字典（供 --codes 打印，也供调用方 import） ─────────

COMPANY_ATTRIBUTES = {
    1: "生产商/制造商", 2: "分销商", 3: "零售商", 4: "电商平台",
    5: "代理商/承包商", 6: "物流服务商", 7: "媒体/机构/政府",
    8: "咨询/金融服务", 9: "大型商超",
}

COMPANY_INFO = {
    1: "有官网", 2: "有座机", 3: "有邮箱", 4: "有手机[待验证]",
    5: "有WhatsApp[待验证]", 6: "有Facebook", 7: "有LinkedIn", 8: "有Twitter",
}

CONTACT_INFO = {2: "有联系人姓名", 7: "联系人有WhatsApp"}

# 搜索结果中表示「有无联系方式」的字段（值为脱敏标记，非真实联系方式）
CONTACT_FLAG_FIELDS = ("emailsValid", "mobilesValid", "phonesValid", "whatsappsValid")


# ── 🔒 硬编码守门人 Gate 0-3 (DC-LS v2.6) ─────────────────
# 违反任何一条 → GateError，硬停止
# 此段不是注解，是强制执行代码

EXHIBITION_13 = {
    "MX", "BR", "ZA", "VN", "ID", "AE", "SA",
    "IN", "PL", "JP", "DE", "TR", "EG"
}


class GateError(Exception):
    """硬编码守门人违反 — 不可恢复，必须硬停止"""
    pass


def normalize_country(raw: Optional[str]) -> Optional[list]:
    """把 --country 的原始输入转成大写 ISO2 列表。

    接口对 country 大小写敏感：["AE"] 有结果，["ae"] / ["Ae"] 均返回 0 条，
    且不报错。若不在此规范化，一个大小写笔误会被当成「该国没有买家」的
    业务结论（Gate 判定用了 .upper() 会照常 PASS，实际搜索却是空的）。
    """
    if not raw:
        return None
    out = [c.strip().upper() for c in raw.split(",") if c.strip()]
    return out or None


def gate_preflight(
    search_term: str,
    country: Optional[list] = None,
    field: str = "keyword",
) -> dict:
    """
    Gate 0 + Gate 1 + Gate 2 前置检查。
    在搜索执行前调用，不通过则抛出 GateError。
    """
    report: dict = {
        "gate": "preflight",
        "passed": True,
        "checks": [],
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    country_list = country or []
    is_exhibition = any(c.upper() in EXHIBITION_13 for c in country_list)

    # ═══ Gate 1: CDP 可用性强制声明 ═══
    # 绝对禁止"无CDP"/"无数据库"/"只能web搜索"等说法
    if not APP_KEY or not APP_SECRET:
        raise GateError(
            "🔒 Gate 1 FAILED: CDP 不可用。\n"
            "   MIO_CDP_APP_KEY / MIO_CDP_APP_SECRET 未设置。\n"
            "   CDP 是一级数据源，不可跳过。请检查环境变量后重试。"
        )
    report["checks"].append({
        "gate": 1, "check": "CDP可用性(APP_KEY+APP_SECRET)",
        "result": "PASS",
    })

    # Gate 1b: supplierId / ppsId 有效性。
    # 不阻断——搜索本身用占位值也能返回完整真实数据；只是状态过滤会失效。
    if SUPPLIER_ID in _PLACEHOLDER_IDS or PPS_ID in _PLACEHOLDER_IDS:
        report["checks"].append({
            "gate": 1, "check": "supplierId/ppsId 有效性",
            "result": "WARN",
            "detail": (
                "仍为占位值。搜索结果不受影响，但 invitationFlag/checkFlag/"
                "unLockFlag 状态过滤会被接口忽略，「排除已邀约买家」等能力失效。"
                "请配置 MIO_CDP_SUPPLIER_ID / MIO_CDP_PPS_ID。"
            ),
        })
    else:
        report["checks"].append({
            "gate": 1, "check": "supplierId/ppsId 有效性", "result": "PASS",
        })

    # ═══ Gate 0: 搜索前置断言 ═══
    # 0a: 搜索词非空
    if not search_term or not search_term.strip():
        raise GateError(
            "🔒 Gate 0 FAILED: 搜索词为空。\n"
            "   必须提供 --tag-keyword / --profile-keyword / --keyword 之一。"
        )
    report["checks"].append({
        "gate": 0, "check": "搜索词有效",
        "result": "PASS", "term": search_term, "field": field,
    })

    # 0b: 目标国判定
    if not country_list:
        report["checks"].append({
            "gate": 0, "check": "目标国判定",
            "result": "WARN",
            "detail": "未指定目标国，将搜索全部国家。建议明确指定。",
        })
    else:
        report["checks"].append({
            "gate": 0, "check": "目标国判定",
            "result": "PASS",
            "countries": country_list,
        })

    # 0c: 13展会国判定
    exhibition_matched = [c for c in country_list if c.upper() in EXHIBITION_13]
    report["checks"].append({
        "gate": 0, "check": "13展会国判定",
        "result": "PASS" if is_exhibition else "INFO",
        "is_exhibition_13": is_exhibition,
        "exhibition_matched": exhibition_matched,
    })

    # ═══ Gate 2: 13展会国 CDP 强制路径 ═══
    # 目标国∈13展会国 → 必须走 CDP，禁止用 web_search 替代
    if is_exhibition:
        report["checks"].append({
            "gate": 2, "check": "13展会国CDP强制调用",
            "result": "PASS",
            "detail": (
                f"目标国 {exhibition_matched} 属于13展会国。"
                f"CDP searchAIV2 为强制路径，web_search 已禁止。"
            ),
        })
    else:
        report["checks"].append({
            "gate": 2, "check": "非展会国 — Apollo优先",
            "result": "INFO",
            "detail": "目标国非13展会国，Apollo 为一级路径。当前走 CDP 补充/兜底。",
        })

    report["passed"] = True
    return report


def gate_postflight(result: dict, country: Optional[list] = None) -> dict:
    """
    Gate 3: 搜索后自检。
    检查实际调用链是否符合数据源铁律路由。
    """
    country_list = country or []
    is_exhibition = any(c.upper() in EXHIBITION_13 for c in country_list)

    post: dict = {"gate": "postflight", "passed": True, "checks": []}

    if result.get("status") == "error":
        post["checks"].append({
            "gate": 3, "check": "搜索执行状态",
            "result": "FAIL",
            "error": result.get("message", "未知错误"),
        })
        post["passed"] = False
        return post

    total = result.get("pagination", {}).get("total", 0)
    check = {
        "gate": 3, "check": "CDP searchAIV2 执行完成",
        "result": "PASS",
        "total_results": total,
        "route": (
            "CDP 强制路径 (13展会国)" if is_exhibition
            else "CDP 补充路径 (非展会国)"
        ),
    }
    # 零结果不等于「该国没有买家」，常见成因是搜索词进错了字段。
    # 不加这条提示，模型容易把配置/用法问题当成业务结论汇报给用户。
    if total == 0:
        check["zero_result_hint"] = (
            "返回 0 条。请先排查用法再下业务结论："
            "①产品品类词是否误放进 --keyword（应走 --tag-keyword/--profile-keyword）；"
            "②是否多个词堆在一次调用（多词为 OR，且拼写需精确）；"
            "③--tag-keyword 是否用了中文（只认英文标签名）。"
        )
    post["checks"].append(check)
    return post


def format_gate_report(preflight: dict, postflight: dict) -> str:
    """生成守门人检查摘要（用于日志/stdout）"""
    lines = ["── 🔒 Gate 0-3 硬编码守门人检查 ──"]
    for c in preflight.get("checks", []):
        icon = "✅" if c["result"] == "PASS" else ("⚠️" if c["result"] == "WARN" else "ℹ️")
        lines.append(f"  {icon} G{c['gate']} {c['check']}: {c['result']}")
    for c in postflight.get("checks", []):
        icon = "✅" if c["result"] == "PASS" else "❌"
        lines.append(f"  {icon} G{c['gate']} {c['check']}: {c['result']}")
    lines.append("──")
    return "\n".join(lines)


# ── 签名 & 请求 ───────────────────────────────────────────

def _sign(content: str) -> tuple:
    """sign = HMAC_SHA256(appSecret, appKey + time + signContent) 转大写十六进制。"""
    ts = int(time.time() * 1000)
    message = f"{APP_KEY}{ts}{content or ''}"
    mac = hmac.new(APP_SECRET.encode(), message.encode(), hashlib.sha256)
    return ts, mac.hexdigest().upper()


def _call(path: str, data: dict, sign_content: str) -> dict:
    """调用 CDP 接口。

    失败时统一返回 {"error": ...}；调用方必须检查该键——searchAIV2 与
    AiSearchGetCdpContact 的成功响应结构不同，不检查会把接口报错
    当成「查无数据」。

    注意：接口成功时 code 实测为 0 而非文档所述的 200，故以 success 字段为准。
    """
    ts, sign = _sign(sign_content)
    body = {"appKey": APP_KEY, "time": ts, "sign": sign, "data": data}

    req = Request(
        f"{BASE_URL}{path}",
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json;charset=UTF-8"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode())
    except HTTPError as e:
        # 网关异常时响应体可能是 HTML 而非 JSON，直接 json.loads 会抛未捕获异常
        try:
            raw = json.loads(e.read().decode())
        except (ValueError, OSError):
            return {"error": f"HTTP {e.code}: 响应非 JSON（疑似网关错误）"}
    except URLError as e:
        return {"error": f"网络错误: {e.reason}"}
    except ValueError:
        return {"error": "响应解析失败：返回内容不是合法 JSON"}

    if not raw.get("success"):
        return {"error": raw.get("msg", "未知错误"), "code": raw.get("code")}
    return raw.get("data") or {}


# ── 搜索核心 ──────────────────────────────────────────────

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
    invitation_flag: int = 0,
    check_flag: int = 0,
    un_lock_flag: int = 0,
    sort_type: int = 2,
    search_similarity: bool = False,
    backend_param: Optional[str] = None,
    supplier_id: Optional[str] = None,
    pps_id: Optional[str] = None,
) -> dict:
    """执行 searchAIV2 搜索。

    keyword / profile_keyword / tag_keyword 三选一或组合（详见模块顶部说明）：
        keyword         匹配公司名——只适合搜已知公司，产品品类词搜不到
        profile_keyword 匹配公司简介
        tag_keyword     匹配采购品类标签（英文），最贴近实际采购行为

    签名内容固定取 data.keyword（接口规则），未传 keyword 时按空字符串参与计算。
    """
    data: dict = {
        "supplierId": supplier_id or SUPPLIER_ID,
        "ppsId": pps_id or PPS_ID,
        "pageNum": page_num,
        "pageSize": page_size,
        "invitationFlag": invitation_flag,
        "checkFlag": check_flag,
        "unLockFlag": un_lock_flag,
        "sortType": sort_type,
        "searchSimilarity": search_similarity,
    }

    if keyword:
        data["keyword"] = keyword
    if profile_keyword:
        data["profileKeyword"] = profile_keyword
    if tag_keyword:
        data["tagKeyword"] = tag_keyword
    if country:
        data["country"] = country
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
    # 翻页必须回传上一次响应里的 backendParam：searchAIV2 是有状态深分页，
    # 只递增 pageNum 而不带 backendParam 拿不到正确的下一页。
    if backend_param:
        data["backendParam"] = backend_param

    return _call("/searchAIV2.json", data, keyword or "")


def get_details(company_cdp_id: str) -> dict:
    """获取 CDP 买家详情（含 tradeOverView 贸易统计、四级采购标签）。"""
    return _call("/getCdpDetails.json", {"companyCdpId": company_cdp_id}, company_cdp_id)


def get_contacts(
    company_cdp_ids: list,
    *,
    page_num: int = 1,
    page_size: int = 10,
    is_kp: Optional[bool] = None,
    is_this_exhibition_pre_buyer: Optional[bool] = None,
    is_previous_on_exhibition_buyer: Optional[bool] = None,
) -> dict:
    """获取 CDP 联系人详情（AiSearchGetCdpContact）。

    返回的是**真实**邮箱/手机/WhatsApp，不需要 Apollo reveal，也不消耗
    Apollo 额度。入参是 companyCdpId 而非域名，所以没有官网的买家也能查。

    三个筛选参数均为三态：None 表示不按该条件筛选，不可写成 False。
        is_kp                            是否关键决策人
        is_this_exhibition_pre_buyer     是否本届展会已报名
        is_previous_on_exhibition_buyer  是否历届到过展
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
    return _call("/AiSearchGetCdpContact.json", data, "")


# ── 格式化输出 ────────────────────────────────────────────

def strip_html(text: Optional[str]) -> str:
    """去掉搜索高亮的 <em> 标签。

    接口会在命中词上加高亮，且高亮只出现在被匹配的字段上——这也是判断
    keyword 匹配公司名的直接证据。公司名、简介都可能带标记，需一并清洗。
    """
    if not text:
        return ""
    return re.sub(r"</?em>", "", text)


def has_any_contact(rec: dict) -> bool:
    """判断记录是否至少有一种联系方式。

    接口的 companyInfo 多值是 AND（[3,4] = 邮箱和手机都要有），无法表达
    「至少有一个」，故在客户端判断。
    """
    return any(rec.get(f) not in (None, "", 0, [], "0") for f in CONTACT_FLAG_FIELDS)


def extract_purchase_tags(rec: dict) -> list:
    """从 sortedT2TagInfo 抽出采购品类标签名，供 --tag-keyword 使用。

    该字段只在 searchAIV2 的记录里，getCdpDetails 不返回它。
    结构是两层：外层是 t2（二级大类），其 tagInfo 里是 t4（四级细类）。
    t4 更精确，用它做 tagKeyword 召回更准，故排在前面。
    """
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
        # 买家类型：接口返回中文，便于直接展示
        "companyAttributes": rec.get("companyAttributes") or [],
        # 有无联系方式。真实联系方式需再调 --contact 模式获取
        "hasContact": has_any_contact(rec),
        # 采购品类标签名，t4（精确）在前、t2（宽泛）在后。
        # 取 name 字段的值回填 --tag-keyword，即可用精确标签重搜。
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
            # 翻页必须把这个值原样回传给下一次调用的 --backend-param
            "backendParam": raw.get("backendParam"),
        },
    }
    if require_contact:
        out["contactFilter"] = {"dropped": dropped, "kept": len(formatted)}
    # 兼容旧调用方
    out["keyword"] = term
    return out


# ── CLI ───────────────────────────────────────────────────

def split_ints(raw: Optional[str], name: str) -> Optional[list]:
    if not raw:
        return None
    try:
        return [int(x.strip()) for x in raw.split(",") if x.strip()] or None
    except ValueError:
        print(json.dumps({"error": f"{name} 只接受逗号分隔的整数，收到: {raw}"},
                         ensure_ascii=False))
        sys.exit(1)


def _buyer_type_text(record: dict) -> str:
    attrs = record.get("companyAttributes") or []
    if isinstance(attrs, str):
        attrs = [attrs]
    return " ".join([
        *[str(v) for v in attrs],
        str(record.get("companyName", "")),
        str(record.get("companyProfile", "")),
        str(record.get("buyerIntroduce", "")),
    ]).lower()


def _buyer_type_aliases(label: str) -> list[str]:
    aliases = {
        "品牌商": ["品牌商", "品牌", "brand", "brand owner"],
        "分销商": ["分销商", "经销商", "distributor", "distribution"],
        "经销商": ["分销商", "经销商", "distributor", "distribution"],
        "零售商": ["零售商", "retailer", "retail chain"],
        "进口商": ["进口商", "importer"],
        "批发商": ["批发商", "wholesaler", "wholesale"],
        "制造商": ["制造商", "生产商", "manufacturer", "factory"],
        "工程商": ["工程商", "承包商", "contractor", "project"],
        "代理商": ["代理商", "agent"],
        "电商": ["电商", "ecommerce", "e-commerce"],
    }
    return aliases.get(label.lower(), aliases.get(label, [label.lower()]))


def apply_buyer_type_calibration(records: list[dict], plan: dict) -> tuple[list[dict], dict]:
    """Apply current-turn avoid rules and preference ranking to search results."""
    avoided = plan.get("avoided_buyer_types") or []
    preferred = plan.get("preferred_buyer_types") or []
    kept = []
    dropped = []
    for record in records:
        text = _buyer_type_text(record)
        matched_avoid = next((label for label in avoided
                              if any(alias.lower() in text
                                     for alias in _buyer_type_aliases(label))), None)
        if matched_avoid:
            dropped.append({"company": record.get("companyName", ""),
                            "matched": matched_avoid})
        else:
            kept.append(record)

    def preference_score(record: dict) -> int:
        text = _buyer_type_text(record)
        return sum(1 for label in preferred
                   if any(alias.lower() in text for alias in _buyer_type_aliases(label)))

    if preferred:
        kept.sort(key=preference_score, reverse=True)
    return kept, {
        "avoided_removed": len(dropped),
        "avoided_details": dropped[:10],
        "preferred_reranked": bool(preferred),
    }


def apply_calibration_to_args(args, plan: dict):
    """Mutate parsed search args so the stored profile changes the API request."""
    if plan.get("countries"):
        args.country = ",".join(plan["countries"])
    elif plan.get("excluded_countries") and args.country:
        requested = normalize_country(args.country) or []
        remaining = [c for c in requested if c not in plan["excluded_countries"]]
        if not remaining:
            raise ValueError("当前搜索国家已被本轮画像排除，但没有替代国家")
        args.country = ",".join(remaining)
    if plan.get("products"):
        args.keyword = None
        args.tag_keyword = None
        args.profile_keyword = plan["products"][0]
    if plan.get("company_attributes"):
        args.company_attributes = ",".join(str(v) for v in plan["company_attributes"])
    return args


def print_codes() -> None:
    print("searchAIV2 枚举参数取值（2026-08-05 生产环境探测，非官方文档）\n")
    for title, table in [("--company-attributes  买家类型", COMPANY_ATTRIBUTES),
                         ("--company-info        公司联系方式", COMPANY_INFO),
                         ("--contact-info        联系人筛选", CONTACT_INFO)]:
        print(title)
        for k, v in sorted(table.items()):
            print(f"    {k}  {v}")
        print()
    print("多值为 AND（交集）；「至少有一个联系方式」请用 --require-contact")
    print("\n三个文本字段：")
    print("    --keyword         匹配公司名      产品品类词搜不到")
    print("    --profile-keyword 匹配公司简介")
    print("    --tag-keyword     匹配采购品类标签  仅认英文，推荐")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="DealClaw DC-LS 搜索引擎（米奥 CDP）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
字段选择速查:
  产品/品类词  → --tag-keyword（首选，英文标签名）或 --profile-keyword
  公司/品牌名  → --keyword
  一次只传一个词：多词是 OR，只会累加噪声

常用组合:
  # 找 AE 的保温杯买家，只要零售商和大型商超，且必须有联系方式
  %(prog)s --tag-keyword "Promotional Drinkware" --country AE \\
           --company-attributes 3,9 --require-contact --size 20

  # 拿真实邮箱手机（无需 Apollo reveal）
  %(prog)s --contact "CO4A78...,CO84D0..." --kp

  # 查取值表
  %(prog)s --codes
""",
    )

    g = p.add_argument_group("搜索字段（三选一或组合，同时传 keyword 与 profile 为 AND）")
    g.add_argument("--keyword", "-k",
                   help="匹配【公司名】。只适合搜已知公司/品牌名。"
                        "产品品类词放这里搜不到（如 drinkware 返回 0 条），"
                        "且易命中噪声（insulated 会搜出建筑保温公司）")
    g.add_argument("--profile-keyword", "--profileKeyword", dest="profile_keyword",
                   help="匹配【公司简介】。产品品类词的兜底选择")
    g.add_argument("--tag-keyword", "--tagKeyword", dest="tag_keyword",
                   help="匹配【采购品类标签】，推荐。仅认英文标签名（中文返回 0 条）。"
                        "层级越深越精准：'Gifts & Crafts' 宽，'Promotional Drinkware' 精准")

    g = p.add_argument_group("筛选")
    g.add_argument("--country", "-c",
                   help="国家 ISO2 码，逗号分隔（如 AE,DE）。接口大小写敏感，"
                        "本脚本会自动转大写")
    g.add_argument("--company-attributes", "--attrs", dest="company_attributes",
                   help="买家类型编码，逗号分隔。1制造商 2分销商 3零售商 4电商 "
                        "5代理商 6物流 7媒体 8咨询 9大型商超。"
                        "找买家建议排除 1；大买家常在 3 和 9")
    g.add_argument("--company-info", dest="company_info",
                   help="公司联系方式编码，逗号分隔。1有官网 2有座机 3有邮箱 4有手机 "
                        "5WhatsApp 6Facebook 7LinkedIn 8Twitter。"
                        "多值是 AND（都要有），不是 OR")
    g.add_argument("--contact-info", dest="contact_info",
                   help="联系人筛选编码，逗号分隔。2有联系人姓名 7有WhatsApp"
                        "（其余维度未识别）。多值是 AND")
    g.add_argument("--revenue", help="年营业额等级，逗号分隔整数（等级划分未知，慎用）")
    g.add_argument("--staff", help="人员规模等级，逗号分隔整数（等级划分未知，慎用）")
    g.add_argument("--trade-scale", dest="trade_scale",
                   help="贸易规模等级，逗号分隔整数（等级划分未知，慎用）")
    g.add_argument("--require-contact", action="store_true",
                   help="只保留邮箱/手机/座机/WhatsApp 至少有一个的记录。"
                        "接口的 company-info 多值是 AND 无法表达「至少一个」，故在本地过滤")
    g.add_argument("--similar", action="store_true",
                   help="同时搜相似列表，扩大召回（对应 searchSimilarity）")

    g = p.add_argument_group("分页")
    g.add_argument("--page", "-p", type=int, default=1, help="页码，默认 1")
    g.add_argument("--size", "-s", type=int, default=10, help="每页条数，默认 10")
    g.add_argument("--backend-param", dest="backend_param",
                   help="翻页透传参数。searchAIV2 是有状态深分页，取第 2 页起"
                        "必须回传上一次响应 pagination.backendParam 的原值")

    g = p.add_argument_group("其它模式")
    g.add_argument("--details", "-d", metavar="CDP_ID",
                   help="查买家详情 + 贸易统计（传 companyCdpId）")
    g.add_argument("--contact", "--contacts", metavar="CDP_IDS",
                   help="查联系人，返回真实邮箱/手机/WhatsApp（传 companyCdpId，逗号分隔）。"
                        "不消耗 Apollo 额度，不需要域名")
    g.add_argument("--kp", action="store_true", help="仅拉 KP（关键决策人），需配合 --contact")
    g.add_argument("--pre-buyer", action="store_true", dest="pre_buyer",
                   help="仅拉本届展会已报名的联系人，需配合 --contact")
    g.add_argument("--on-exhibition", action="store_true", dest="on_exhibition",
                   help="仅拉历届到过展的联系人，需配合 --contact")
    g.add_argument("--codes", action="store_true", help="打印枚举参数取值表后退出")

    g = p.add_argument_group("去重与排序")
    g.add_argument("--user", "-u", help="当前用户 open_id（启用去重，须同时传 --enterprise）")
    g.add_argument("--enterprise", "-e", help="企业/租户域名（启用去重或标签重排序时必填）")
    g.add_argument("--tags", "-t", action="store_true",
                   help="启用历史客户标签重排序（需先导入历史客户）")
    g.add_argument("--jsonl", action="store_true", help="JSONL 输出，每行一条记录")

    g = p.add_argument_group("企业线索池（传 --enterprise 时默认自动同步）")
    g.add_argument("--company-name", help="企业展示名；未传时使用 --enterprise")
    g.add_argument("--chat-id", help="飞书群 chat_id；新建线索池时用于授权群成员")
    g.add_argument("--lead-source", default="引擎搜索",
                   help="线索来源，默认：引擎搜索")
    g.add_argument("--no-lead-pool", action="store_true",
                   help="仅限诊断：不把最终搜索结果同步到企业线索池")
    g.add_argument("--ignore-calibration", action="store_true",
                   help="仅限诊断/新任务：忽略已保存的当前搜索画像")

    return p


def main():
    args = build_parser().parse_args()

    # Shadow billing (内测期只记录预估，不扣费)
    tenant = os.environ.get("DC_TENANT_ID") or os.environ.get("DEALCLAW_TENANT_ID", "")
    if billing and tenant:
        try:
            billing.configure(tenant)
            billing.estimate("dealclaw-find-buyers", quantity=1)
        except Exception:
            pass  # billing is best-effort in shadow mode

    if args.codes:
        print_codes()
        return

    if not APP_SECRET:
        print(json.dumps({"error": "MIO_CDP_APP_SECRET 未设置"}, ensure_ascii=False))
        sys.exit(1)

    # ── 联系人模式 ────────────────────────────────────
    if args.contact:
        ids = [i.strip() for i in args.contact.split(",") if i.strip()]
        raw = get_contacts(
            ids,
            page_num=args.page,
            page_size=args.size,
            is_kp=True if args.kp else None,
            is_this_exhibition_pre_buyer=True if args.pre_buyer else None,
            is_previous_on_exhibition_buyer=True if args.on_exhibition else None,
        )
        # 必须先判错：接口失败时 raw 是 {"error": ...}，直接取 page 会得到空列表，
        # 把「鉴权失败/限流/服务端异常」输出成「0 联系人」。
        if "error" in raw:
            print(json.dumps({
                "status": "error",
                "mode": "contact",
                "message": raw["error"],
                "code": raw.get("code"),
                "hint": "接口调用失败，这不代表该公司没有联系人。请勿据此判断。",
            }, ensure_ascii=False, indent=2))
            sys.exit(1)

        page = raw.get("page") or {}
        records = page.get("records") or []
        print(json.dumps({
            "status": "success",
            "summary": f"📇 {len(records)} 联系人 | 共 {page.get('total', 0)} 条",
            "contacts": [
                {
                    "contactName": r.get("contactName", ""),
                    "jobTitle": r.get("jobTitle", ""),
                    "companyCdpId": r.get("companyCdpId", ""),
                    "isKp": r.get("isKp", False),
                    "isThisExhibitionPreBuyer": r.get("isThisExhibitionPreBuyer", False),
                    "isPreviousOnExhibitionBuyer": r.get("isPreviousOnExhibitionBuyer", False),
                    # 以下为真实联系方式（逗号分隔），非脱敏标记
                    "emailsValid": r.get("emailsValid", ""),
                    "mobilesValid": r.get("mobilesValid", ""),
                    "whatsappsValid": r.get("whatsappsValid", ""),
                    "phonesValid": r.get("phonesValid", ""),
                    "linkedinValid": r.get("linkedinValid", ""),
                }
                for r in records
            ],
            "pagination": {
                "total": page.get("total", 0),
                "current": page.get("current", 1),
                "size": page.get("size", args.size),
                "pages": page.get("pages", 1),
            },
        }, indent=2, ensure_ascii=False))
        return

    # ── 详情模式 ──────────────────────────────────────
    if args.details:
        raw = get_details(args.details)
        if "error" in raw:
            print(json.dumps({"status": "error", "mode": "details",
                              "message": raw["error"], "code": raw.get("code")},
                             ensure_ascii=False, indent=2))
            sys.exit(1)
        print(json.dumps({"status": "success", "data": raw}, indent=2, ensure_ascii=False))
        return

    # ── 搜索模式：读取上轮纠偏形成的可执行参数 ─────────
    calibration_plan = {}
    if args.enterprise and args.user and not args.ignore_calibration:
        try:
            from dc_buyer_state import BuyerState
            calibration_plan = BuyerState().get_search_plan(args.enterprise, args.user)
            apply_calibration_to_args(args, calibration_plan)
        except (ImportError, OSError, ValueError, TypeError) as exc:
            print(json.dumps({
                "status": "calibration_blocked",
                "error": str(exc),
                "hint": "请补充一个替代国家，或明确开启全新搜索任务。",
            }, ensure_ascii=False))
            sys.exit(2)

    term = args.tag_keyword or args.profile_keyword or args.keyword
    field = ("tagKeyword" if args.tag_keyword
             else "profileKeyword" if args.profile_keyword else "keyword")
    if not term:
        print(json.dumps({
            "error": "搜索模式需要 --tag-keyword / --profile-keyword / --keyword 之一",
            "hint": "产品品类词用 --tag-keyword（英文标签名）或 --profile-keyword；"
                    "公司名才用 --keyword",
        }, ensure_ascii=False))
        sys.exit(1)

    country = normalize_country(args.country)

    # ═══ 🔒 Gate 0+1+2 前置检查（硬编码，不可跳过） ═══
    try:
        gate_pre = gate_preflight(term, country, field)
    except GateError as e:
        print(json.dumps({"status": "gate_blocked", "gate": "preflight",
                          "error": str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)

    raw = search(
        keyword=args.keyword,
        profile_keyword=args.profile_keyword,
        tag_keyword=args.tag_keyword,
        country=country,
        page_num=args.page,
        page_size=args.size,
        company_attributes=split_ints(args.company_attributes, "--company-attributes"),
        company_info=split_ints(args.company_info, "--company-info"),
        contact_info=split_ints(args.contact_info, "--contact-info"),
        annual_revenue_level=split_ints(args.revenue, "--revenue"),
        staff_size_level=split_ints(args.staff, "--staff"),
        trade_scale_level=split_ints(args.trade_scale, "--trade-scale"),
        search_similarity=args.similar,
        backend_param=args.backend_param,
    )

    result = format_results(raw, term, country, field, args.require_contact)

    if calibration_plan:
        calibrated, report = apply_buyer_type_calibration(
            result.get("records", []), calibration_plan
        )
        result["records"] = calibrated
        result["calibration"] = {"plan": calibration_plan, **report}
        if report["avoided_removed"]:
            result["summary"] += f" (本轮画像排除 {report['avoided_removed']} 条)"

    # ═══ 🔒 Gate 3 后置自检 ═══
    result["gate_report"] = {
        "preflight": gate_pre,
        "postflight": gate_postflight(result, country),
    }

    if result["status"] == "error":
        print(json.dumps(result, indent=2, ensure_ascii=False))
        sys.exit(1)

    # ── 去重集成 ──────────────────────────────────────
    if args.user:
        if not args.enterprise:
            print(json.dumps({"error": "启用 --user 去重时必须传 --enterprise，避免跨企业数据探测"},
                             ensure_ascii=False))
            sys.exit(1)
        try:
            from dc_ls_store import LeadStore
            store = LeadStore()
            records = result.get("records", [])
            filtered = store.filter_duplicates(records, args.user, args.enterprise)
            removed = len(records) - len(filtered)
            result["records"] = filtered
            result["dedup"] = {"removed": removed, "kept": len(filtered),
                               "user": args.user, "enterprise": args.enterprise}
            if removed > 0:
                result["summary"] += f" (去重 {removed} 条)"

            # 应用歧义排除偏好（dc_ls_store.py exclude 持久化的那些）。
            # apply_exclusion_filter 按 company_name / industry 字段判断，
            # 本脚本记录用的是 companyName / companyProfile，故先补上别名。
            for r in result["records"]:
                r.setdefault("company_name", r.get("companyName", ""))
                r.setdefault("industry", r.get("companyProfile", ""))
            kept, excluded_cnt, details = store.apply_exclusion_filter(
                result["records"], args.user, args.enterprise)
            for r in kept:
                r.pop("company_name", None)
                r.pop("industry", None)
            result["records"] = kept
            result["exclusion"] = {"excluded": excluded_cnt, "kept": len(kept),
                                   "details": details[:10]}
            if excluded_cnt > 0:
                result["summary"] += f" (排除偏好命中 {excluded_cnt} 条)"
        except ImportError:
            # 去重模块不可用。必须显式标注，否则调用方会误以为已去重。
            result["dedup"] = {"status": "skipped", "reason": "dc_ls_store 模块不可用"}
            result["summary"] += " | ⚠️ [去重待验证]"
    else:
        result["dedup"] = {"status": "not_requested",
                           "reason": "未传 --user/--enterprise，本次未执行企业级去重"}

    # ── 标签重排序 ───────────────────────────────────
    if args.tags:
        if not args.enterprise:
            print(json.dumps({"error": "启用 --tags 重排序时必须传 --enterprise"},
                             ensure_ascii=False))
            sys.exit(1)
        try:
            from dc_customer_import import load_tags, buyer_similarity
            tags_data = load_tags(args.enterprise)
            if tags_data and tags_data.get("persona"):
                persona = tags_data["persona"]
                scored = []
                for r in result.get("records", []):
                    buyer = {
                        "company_name": r.get("companyName", ""),
                        "country": r.get("country", ""),
                        "keywords": f"{r.get('companyProfile', '')} {r.get('buyerIntroduce', '')}",
                    }
                    score, reasons = buyer_similarity(buyer, persona)
                    r["tag_score"] = score
                    r["tag_reasons"] = reasons
                    scored.append(r)
                scored.sort(key=lambda r: r.get("tag_score", 0), reverse=True)
                result["records"] = scored
                result["reranked"] = True
                result["tag_source"] = f"{tags_data['customer_count']} 个历史客户"
                result["summary"] += " | 标签重排序 ✅"
            else:
                result["reranked"] = False
                result["summary"] += " | ⚠️ 未找到历史客户标签，请先导入"
        except ImportError:
            result["reranked"] = False
            result["summary"] += " | ⚠️ 重排序模块不可用"

    # ── 企业线索池：最终展示结果自动入池，并把链接交给 Agent ──
    if args.enterprise and not args.no_lead_pool:
        try:
            from dc_company_registry import sync_leads_to_pool
            sync_result = sync_leads_to_pool(
                company_id=args.enterprise,
                company_name=args.company_name or args.enterprise,
                records=result.get("records", []),
                source=args.lead_source,
                chat_id=args.chat_id,
            )
            result["lead_pool"] = sync_result
            result["summary"] += (
                f" | 已同步线索池 {sync_result['created'] + sync_result['updated']} 条"
            )
        except Exception as e:
            # 线索搜索结果仍返回，但绝不假装已写入。
            result["lead_pool"] = {
                "status": "error",
                "message": str(e)[:300],
            }
            result["summary"] += " | ⚠️ 线索池同步失败"
    elif not args.enterprise:
        result["lead_pool"] = {
            "status": "skipped",
            "reason": "未传 --enterprise，无法确定企业线索池",
        }
    else:
        result["lead_pool"] = {
            "status": "skipped",
            "reason": "--no-lead-pool diagnostic mode",
        }

    if args.jsonl:
        for r in result.get("records", []):
            print(json.dumps(r, ensure_ascii=False))
    else:
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
