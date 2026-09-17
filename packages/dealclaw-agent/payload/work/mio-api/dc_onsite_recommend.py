#!/usr/bin/env python3
# -- coding: UTF-8 --
"""dc_onsite_recommend.py — 展会现场「未邀约匹配买家」推荐

场景：展前已邀约一批买家（邀约名单），展会开展期间定时把「已到场、但没邀约、
且产品对路」的买家捞出来推荐，现场补枪。

流程：
  1. 确定当前正在开展的展会（orderRecords state=3 → selectAllExhibition 对账 inshow 日期）
  2. 拿产品词（企业画像 kb.json profile.products）
  3. 拉现场买家（buyer onsite --exhibition-id --keywords）
  4. 剔除已邀约（邀约名单 companyCdpId）+ 剔除 excluded（黑名单/明确拒绝，排除不落）
  5. 分层推荐（主推/跟进）+ 理由
  6. 落本展会线索池（来源「展中推荐」，与企业主池分开）
  7. 分批气泡推群（复用 dc_notify routes chat_id；明细分批全发，不折叠；总>10 先发汇总+池入口）

触发：cron 每小时跑一次并带 --slot-gate，由本脚本用【展会当地时间】判断是否到点。
判断顺序（2026-09-16 调整）：
  ① 有没有 state=3 的在售展会 → 没有就 NO_RUN
  ② 取展会国家 → 映射 IANA 时区
  ③ 用展会【当地日期】判断今天是否在展期内（不能用容器的北京日期，展期尾日下午会误判成已结束）
  ④ 展会当地小时是否落在推荐时点（默认 10/14/16）→ 不是就 NO_RUN
  ⑤ 命中才跑真正的推荐（拉现场买家、落池、发卡）

--slot-gate 只给 cron 用。skill 手动触发（skills/dealclaw-onsite-recommend）不带这个
参数，任何时间都能跑，行为和改造前一致。

用法：
  python3 dc_onsite_recommend.py run [--company-id <sid>] [--dry-run] [--exhibition-id <id>]
  python3 dc_onsite_recommend.py run --slot-gate            # cron 用：不到点就 NO_RUN
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

_XIAOYUAN = shutil.which("xiaoyuan") or "/opt/xiaoyuan-venv/bin/xiaoyuan"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _tenant_env import load_tenant_env

load_tenant_env()

try:
    from enterprise_ids import canonical_company_id
except ImportError:  # 兜底
    def canonical_company_id(cid: str) -> str:
        return (cid or "").strip() or os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()

try:
    from dc_notify import get_default_target
except ImportError:
    def get_default_target() -> str:
        return ""

# 落池基建（每届展会一个独立池）复用企业线索池的 ensure / sync 写路径
try:
    import dc_company_registry as dcr
except ImportError:  # 兔底：无基建时不落池，明细不受影响
    dcr = None

# 展后推荐的「不再推荐」判定（denied / blacklisted / 明确拒绝等），现场落池复用同一口径
try:
    from dc_after_exhibition_recommend import is_suppressed as _is_recommend_suppressed
except ImportError:
    def _is_recommend_suppressed(buyer: dict) -> bool:
        return False


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _xiaoyuan(*args: str) -> dict:
    cmd = [
        _XIAOYUAN,
        "--open-id", os.environ.get("MIO_V_OPEN_ID", ""),
        "--supplier-id", os.environ.get("MIO_CDP_SUPPLIER_ID", ""),
        *args,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    try:
        return json.loads(proc.stdout or proc.stderr)
    except Exception:
        return {"_raw": (proc.stdout or proc.stderr)[:500]}


# ── 0. 展会时区 / 时点闸门 ──────────────────────────────────────

# 国家 → IANA 时区。原先这张表在 runtime/dc-cron-onsite-recommend.sh 里，用于把当地
# 10/14/16 点换算成北京时间注册 cron；换算写死 1 月 1 日，美国/欧洲夏令时会偏 1 小时。
# 改成运行时判断后表搬到这里，换算整段删除，夏令时由 ZoneInfo 自动处理。
COUNTRY_TZ = {
    "Brazil": "America/Sao_Paulo",
    "India": "Asia/Kolkata",
    "Saudi Arabia": "Asia/Riyadh",
    "Indonesia": "Asia/Jakarta",
    "Vietnam": "Asia/Ho_Chi_Minh",
    "South Africa": "Africa/Johannesburg",
    "Mexico": "America/Mexico_City",
    "Poland": "Europe/Warsaw",
    "United Arab Emirates": "Asia/Dubai",
    "Dubai": "Asia/Dubai",
    "Japan": "Asia/Tokyo",
    "United States": "America/New_York",
    "Germany": "Europe/Berlin",
    "Turkey": "Europe/Istanbul",
    "Russia": "Europe/Moscow",
    "Egypt": "Africa/Cairo",
    "Kazakhstan": "Asia/Almaty",
}

DEFAULT_SLOTS = (10, 14, 16)
FALLBACK_TZ = "Asia/Shanghai"


def tz_for_country(country: str) -> str:
    """国家名 → IANA 时区；未收录的国家兜底回 Asia/Shanghai 并出提示。"""
    name = (country or "").strip()
    tz = COUNTRY_TZ.get(name)
    if tz:
        return tz
    if name:
        print(f"[dc_onsite_recommend] 国家未收录于 COUNTRY_TZ: {name!r}，按 {FALLBACK_TZ} 处理",
              file=sys.stderr)
    return FALLBACK_TZ


def local_now(tz_name: str) -> datetime:
    try:
        return datetime.now(ZoneInfo(tz_name))
    except Exception:  # noqa: BLE001 — 非法时区不该让整条链路挂掉
        print(f"[dc_onsite_recommend] 非法时区 {tz_name!r}，按 {FALLBACK_TZ} 处理", file=sys.stderr)
        return datetime.now(ZoneInfo(FALLBACK_TZ))


def parse_slots(raw: str) -> tuple[int, ...]:
    if not (raw or "").strip():
        return DEFAULT_SLOTS
    out = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isdigit() or not (0 <= int(part) <= 23):
            raise SystemExit(f"[dc_onsite_recommend] 非法推荐时点: {part!r}（应为 0-23 的整数）")
        out.append(int(part))
    return tuple(dict.fromkeys(out)) or DEFAULT_SLOTS


# ── 1. 当前开展展会 ─────────────────────────────────────────────

_RECORDS_CACHE_TTL_S = 6 * 3600


def _records_cache_path(company_id: str) -> Path:
    return _workspace_root() / "data" / "memory" / company_id / "onsite-exhibitions-cache.json"


def _load_records_cache(company_id: str) -> list[dict] | None:
    """缓存的是 state=3 展会的原始记录（国家、展期），不含日期过滤结果。

    展期和国家几乎不变，但「今天是否在展期内」每次都要按展会当地日期现算，
    所以只缓存原始记录。cron 每小时跑一次，6 小时 TTL 把 API 调用压到 ~4 次/天，
    和改造前 3 次/天基本持平。空结果同样缓存 —— 绝大多数时候租户没有在展展会，
    不缓存的话这条路径会白打 24 次 API。
    """
    if not company_id:
        return None
    path = _records_cache_path(company_id)
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — 缓存不可读一律当未命中
        return None
    if not isinstance(d, dict):
        return None
    fetched_at = d.get("fetchedAt")
    if not isinstance(fetched_at, (int, float)):
        return None
    if datetime.now(timezone.utc).timestamp() - fetched_at > _RECORDS_CACHE_TTL_S:
        return None
    records = d.get("records")
    return records if isinstance(records, list) else None


def _save_records_cache(company_id: str, records: list[dict]) -> None:
    if not company_id:
        return
    path = _records_cache_path(company_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"fetchedAt": datetime.now(timezone.utc).timestamp(), "records": records},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as e:  # noqa: BLE001 — 缓存写不了不该影响主流程
        print(f"[dc_onsite_recommend] 展会缓存写入失败（不影响本次）: {e}", file=sys.stderr)


def current_exhibitions(company_id: str = "", use_cache: bool = True) -> list[dict]:
    """orderRecords state=3 → selectAllExhibition 对账 → 今天正在开展的展会。"""
    if use_cache:
        cached = _load_records_cache(company_id)
        if cached is not None:
            return _filter_inshow_today(cached)

    info = _xiaoyuan("company", "info")
    order_records = (info.get("response", {}).get("data", {}) or {}).get("orderRecords") or []
    state3_ids = [r.get("sourceId") for r in order_records if r.get("state") == 3 and r.get("sourceId")]
    if not state3_ids:
        return []

    need = set(state3_ids)
    by_id = {}
    for page in range(1, 50):
        exh = _xiaoyuan("buyer", "exhibitions", "--page", str(page), "--size", "100")
        all_records = (exh.get("response", {}).get("data", {}) or {}).get("records") or []
        if not all_records:
            break
        for r in all_records:
            by_id[r.get("id")] = r
        if need.issubset(by_id):
            break

    records = []
    for sid in dict.fromkeys(state3_ids):
        r = by_id.get(sid)
        if r:
            records.append({
                "exhibitionId": sid,
                "name": r.get("name") or r.get("nameCn") or "",
                "countryName": (r.get("countryName") or "").strip(),
                "inshowStartDate": (r.get("inshowStartDate") or "").strip(),
                "inshowEndDate": (r.get("inshowEndDate") or "").strip(),
            })
    _save_records_cache(company_id, records)
    return _filter_inshow_today(records)


def _filter_inshow_today(records: list[dict]) -> list[dict]:
    """按【展会当地日期】筛出今天正在开展的展会，并带出时区。"""
    out = []
    for r in records:
        sid = r.get("exhibitionId")
        if not sid:
            continue
        inshow_start = (r.get("inshowStartDate") or "").strip()
        inshow_end = (r.get("inshowEndDate") or "").strip()
        if not (inshow_start and inshow_end):
            continue
        country = (r.get("countryName") or "").strip()
        tz_name = tz_for_country(country)
        # 展期日期是展会当地日期，必须拿【当地今天】比对。容器 TZ=Asia/Shanghai，
        # 直接用北京日期会在展期尾日下午误判成「展会已结束」而漏跑：巴西差 11 小时、
        # 美国差 12-13 小时，当地下午时北京已经跨到次日。
        local_today = local_now(tz_name).strftime("%Y%m%d")
        if inshow_start <= local_today <= inshow_end:
            out.append({
                "exhibitionId": sid,
                "name": r.get("name") or "",
                "country": country,
                "tz": tz_name,
                "localToday": local_today,
                "inshowStartDate": inshow_start,
                "inshowEndDate": inshow_end,
            })
    return out


# ── 2. 产品词 ───────────────────────────────────────────────────

def load_profile(company_id: str) -> dict:
    p = _workspace_root() / "data" / "memory" / company_id / "kb.json"
    if not p.exists():
        return {}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return d.get("profile", {}) or {}


def load_products(company_id: str) -> list[str]:
    prof = load_profile(company_id)
    prods = prof.get("products") or prof.get("product") or []
    return [str(x).strip() for x in prods if str(x).strip()]


# 画像里可能承载"采购标签/类目"的字段（容错多字段，取到就用）
PROFILE_TAG_FIELDS = (
    "tags", "tagKeywords", "tag_keywords", "tagKeyword",
    "categories", "supplierCategories", "supplier_categories",
    "keywords", "seoKeywords",
)


def search_terms(company_id: str) -> list[str]:
    """onsite 搜索词：对齐 find-buyers 机器契约——**标签/类目词优先，英文，一次一个概念**。

    过去直接把 profile.products 原词全塞进 --keywords（可能是中文长句/品牌名），
    接口按"产品关键词"匹配，自然给出泛化结果。这里改成标签优先、短词优先。
    """
    prof = load_profile(company_id)
    terms: list[str] = []
    for field in PROFILE_TAG_FIELDS:
        for t in _split_terms(prof.get(field)):
            if t not in terms:
                terms.append(t)
    if not terms:  # 没有标签字段才退回 products
        for t in _split_terms(prof.get("products") or prof.get("product")):
            if t not in terms:
                terms.append(t)
    # 一次只传一个搜索概念：过长句子不进接口（find-buyers 同口径）
    return [t for t in terms if len(t) <= 40][:5]


# ── 3. 现场买家 ─────────────────────────────────────────────────

def fetch_onsite(exhibition_id: str, keywords: list[str]) -> list[dict]:
    """buyer onsite 拉现场买家（字段对齐 buyer search）。"""
    kw = ",".join(keywords[:5]) if keywords else ""
    resp = _xiaoyuan("buyer", "onsite", "--exhibition-id", exhibition_id,
                     "--keywords", kw, "--page-size", "50")
    data = (resp.get("response", {}).get("data", {}) or {})
    recs = data.get("records") or []
    return recs if isinstance(recs, list) else []


# ── 4. 已邀约 ───────────────────────────────────────────────────

def load_invited_cdp_ids(company_id: str) -> set[str]:
    p = _workspace_root() / "data" / "memory" / company_id / "exhibition-invitations.json"
    if not p.exists():
        return set()
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return set()
    invs = d.get("invitations", []) if isinstance(d, dict) else []
    return {(r.get("companyCdpId") or "").strip() for r in invs if (r.get("companyCdpId") or "").strip()}


# ── 5. 分层推荐 + 理由 ─────────────────────────────────────────

# 买家类型 companyAttributes 枚举（对齐 buyer search）
ATTR_LABEL = {1: "生产商", 2: "分销商", 3: "零售商", 4: "品牌", 5: "商超"}


# ── 产品匹配（2026-09-17 修）──────────────────────────────────
# 过去这里是假的：`if keywords: reasons.append("产品对路")` —— 只要画像里有产品词，
# **每个**买家都被标"产品对路"，从不与买家自身产品比对；分层也只看"有没有公司属性/规模"，
# 与产品无关。结果就是现场推荐"人人主推、个个对路"，用户反馈"给的买家不准"。
# 现在改成真比对：我们的产品词 ∩ 买家产品字段，命中才叫匹配。
BUYER_PRODUCT_FIELDS = (
    "purchaseTags", "productList", "products", "tagList",
    "关注产品", "采购产品", "buyerProducts", "mainProducts",
)


def _split_terms(raw) -> list[str]:
    """把产品词/标签拆成可比对词元（支持中英、逗号/分号/斜杠/顿号分隔）。

    关键：买家 purchaseTags 是 **字典列表**（如 {"name": "Packaging Bag"}），
    必须取 name，否则会把整个 dict 的 repr 当成词，导致真实命中被漏掉（2026-09-17 修）。
    """
    if not raw:
        return []
    if isinstance(raw, dict):
        for key in ("name", "value", "label", "title", "tagName", "text", "keyword"):
            if raw.get(key):
                return _split_terms(raw.get(key))
        return []
    if isinstance(raw, (list, tuple, set)):
        out: list[str] = []
        for x in raw:
            for t in _split_terms(x):
                if t not in out:
                    out.append(t)
        return out
    parts = re.split(r"[,，;；/、|]+", str(raw))
    out = []
    for part in parts:
        t = part.strip().lower()
        if t and t not in out:
            out.append(t)
    return out


def buyer_product_terms(buyer: dict) -> list[str]:
    """买家自身产品字段的全部词元（比对用）。"""
    terms: list[str] = []
    for field in BUYER_PRODUCT_FIELDS:
        for t in _split_terms(buyer.get(field)):
            if t not in terms:
                terms.append(t)
    return terms


# 买家侧的弱信号字段（产品字段为空时兜底，放宽匹配）
BUYER_WEAK_FIELDS = (
    "companyIntro", "companyProfile", "businessScope", "business_scope",
    "mainProducts", "main_products", "description", "主营产品", "公司简介",
)


def _terms_match(a: str, b: str) -> bool:
    """宽松词元匹配（find-buyers 的宽进口径，别硬顶全等）。

    命中任一即算：全等 / 互相包含 / 词元交集（≥4 字的词，去复数）。
    """
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True

    def _toks(x: str) -> list:
        x = re.sub(r"[-_/|]+", " ", x)
        out = []
        for t in x.split():
            t = t.strip().lower()
            if len(t) >= 4 and t.endswith("s") and not t.endswith("ss"):
                t = t[:-1]
            if len(t) >= 4:
                out.append(t)
        return out

    return bool(set(_toks(a)) & set(_toks(b)))


def match_products(buyer: dict, keywords) -> list[str]:
    """返回命中的产品词（我们 ∩ 买家）。任一方包含另一方即算命中。

    拿不到任一侧词元 → 返回 []（不做无依据的"匹配"）。
    """
    mine = _split_terms(keywords)
    if not mine:
        return []
    theirs = buyer_product_terms(buyer)
    hits: list[str] = []
    for kw in mine:
        for tag in theirs:
            if _terms_match(kw, tag):
                if kw not in hits:
                    hits.append(kw)
                break
    if hits:
        return hits
    # 产品字段没命中 → 用简介/主营等弱信号兜底（现场宽进，少些限制）
    weak: list[str] = []
    for field in BUYER_WEAK_FIELDS:
        for t in _split_terms(buyer.get(field)):
            if t not in weak:
                weak.append(t)
    for kw in mine:
        for tag in weak:
            if _terms_match(kw, tag):
                if kw not in hits:
                    hits.append(kw)
                break
    return hits


def _buyer_facts(buyer: dict, keywords: list[str]) -> dict:
    """现场买家 → 展示行与落池共用的事实（公司名/国家/类型/规模/理由/CDP/官网）。

    展示行与落池必须同源，否则会出现「气泡里有理由、池里没理由」这类漂移。
    """
    attrs = buyer.get("companyAttributes") or []
    attr_label = ""
    if attrs:
        attr_label = "/".join(ATTR_LABEL.get(int(a), str(a)) for a in attrs if str(a).isdigit())
    size = buyer.get("newCompanySize") or buyer.get("companySize") or ""

    hits = match_products(buyer, keywords)
    reasons = []
    if hits:
        reasons.append("产品匹配:" + "/".join(hits[:3]))
    elif keywords:
        reasons.append("未见产品交集")
    if attr_label:
        reasons.append(attr_label)
    if size:
        reasons.append(f"规模{size}")

    return {
        "name": buyer.get("companyName") or "",
        "country": (buyer.get("countryCnName") or buyer.get("country")
                    or buyer.get("countryEnName") or ""),
        "attr_label": attr_label,
        "size": str(size or ""),
        "reason": (",".join(reasons) if reasons else "现场买家"),
        "matched_products": hits,
        "cdp": str(buyer.get("companyCdpId") or buyer.get("companyCdpid") or "").strip(),
        "website": str(buyer.get("website") or buyer.get("domain") or "").strip(),
    }


def classify(buyer: dict, keywords: list[str]) -> tuple[str, str]:
    """分层：主推 / 跟进；返回 (层级, 展示行)。"""
    f = _buyer_facts(buyer, keywords)
    # 主推 = 产品真命中；没有命中一律降为跟进（过去按"有无公司属性"分层，人人主推）
    tier = "主推" if f["matched_products"] else "跟进"
    name = f["name"] or "(未知)"
    return tier, f"{name}｜{f['country']}｜{f['reason']}"


# ── 6. 展中推荐落池（每届展会一个独立池）───────────────────

ONSITE_POOL_SOURCE = "展中推荐"
ONSITE_POOL_STAGE = "现场对接中"
POOL_LINK_PREFIX = "📊 本展会线索池："

# 现场买家 companyAttributes → 线索池「买家类型」枚举。
# 池选项只有 品牌商/制造商/经销商/工程商；现场的 生产商/零售商/商超 必须收敛，
# 否则 select 写不进（收敛是有损的：展示行仍保留细粒度标签）。
ATTR_TO_POOL_TYPE = {1: "制造商", 2: "经销商", 3: "经销商", 4: "品牌商", 5: "经销商"}

# 邀约状态「已拒绝」= 明确拒绝（字段名沿用接口原文，见 dealclaw/init-data-mapping.md）
ONSITE_REFUSED_INVITATION_STATES = ("3",)


def is_excluded_from_onsite(buyer: dict) -> bool:
    """排除不落铁律：黑名单 / 明确拒绝 / 人工排除 → 不推、不落池。

    复用展后推荐的 SUPPRESSED_FIELDS（denied / identity_mismatch / cancelled /
    blacklisted / historical_suppressed / manual_excluded），另加邀约状态 3=已拒绝。
    """
    if _is_recommend_suppressed(buyer):
        return True
    for key in ("inviationState", "invitationState"):
        if str(buyer.get(key) or "").strip() in ONSITE_REFUSED_INVITATION_STATES:
            return True
    return False


def _pool_buyer_type(buyer: dict) -> str:
    """companyAttributes → 池枚举（多值时取第一个能映射的）。"""
    for raw in (buyer.get("companyAttributes") or []):
        if str(raw).isdigit():
            mapped = ATTR_TO_POOL_TYPE.get(int(raw))
            if mapped:
                return mapped
    return ""


def _pool_products(buyer: dict) -> list[str]:
    tags = (buyer.get("purchaseTags") or buyer.get("productList")
            or buyer.get("products") or buyer.get("关注产品") or [])
    if isinstance(tags, str):
        tags = [x.strip() for x in tags.replace("，", ",").split(",") if x.strip()]
    out: list[str] = []
    for tag in tags:
        text = str(tag.get("name", "") if isinstance(tag, dict) else tag).strip()
        if text and text not in out:
            out.append(text)
    return out[:20]


def onsite_pool_record(buyer: dict, keywords: list[str]) -> "dict | None":
    """现场买家 → 展中推荐线索池字段；无名且无官网则不落（无法幂等去重，返回 None）。

    字段名用池原生名（dc_company_registry._record_fields 已支持池原生入参）；
    阶段「现场对接中」不在 SEARCH_OWNED_FIELDS 里 → 用户手改的阶段不会被后续 update 覆盖。
    """
    facts = _buyer_facts(buyer, keywords)
    name = str(facts["name"] or "").strip()
    website = str(facts["website"] or "").strip()
    if not name and not website:
        return None
    record = {
        "公司名": name,
        "官网": website,
        "公司CDPID": facts["cdp"],
        "国家": facts["country"],
        "推荐理由": facts["reason"],
        "来源": ONSITE_POOL_SOURCE,
        "阶段": ONSITE_POOL_STAGE,
    }
    pool_type = _pool_buyer_type(buyer)
    if pool_type:
        record["买家类型"] = pool_type
    products = facts["matched_products"]
    if products:
        record["匹配产品"] = products
    return record


def land_onsite_leads(company_id: str, exhibition: dict, buyers: list,
                      keywords: list[str], *, chat_id: str = "",
                      dry_run: bool = False) -> dict:
    """本场推荐落进「本届展会」独立线索池（幂等、排除不落）。

    返回（不抛）：title / url / records / unnamed / created / updated / skipped；
    error：落池失败摘要——**落池失败不影响明细推送**。
    """
    exhibition_id = str(exhibition.get("exhibitionId") or "").strip()
    exhibition_name = str(exhibition.get("name") or "").strip()
    out = {
        "source": ONSITE_POOL_SOURCE,
        "stage": ONSITE_POOL_STAGE,
        "exhibition_id": exhibition_id,
        "exhibition_name": exhibition_name,
        "title": "", "url": "",
        "records": 0, "unnamed": 0,
        "created": 0, "updated": 0, "skipped": 0,
    }
    if dcr is not None:
        try:
            out["title"] = dcr.exhibition_pool_title(exhibition_name, exhibition_id)
        except ValueError:
            pass
    records = []
    for buyer in buyers or []:
        record = onsite_pool_record(buyer, keywords)
        if record is None:
            out["unnamed"] += 1
            continue
        records.append(record)
    out["records"] = len(records)
    if dcr is None or not records:
        return out
    if dry_run:
        out["skipped"] = len(records)
        out["dry_run"] = True
        return out
    try:
        result = dcr.sync_exhibition_leads_to_pool(
            company_id, exhibition_id, records,
            exhibition_name=exhibition_name, chat_id=chat_id,
        )
    except Exception as e:  # noqa: BLE001 — 落池失败绝不吞掉明细推送
        out["error"] = f"{type(e).__name__}: {e}"[:300]
        return out
    out.update({
        "url": result.get("bitable_url") or "",
        "created": result.get("created", 0),
        "updated": result.get("updated", 0),
        "skipped": result.get("skipped", 0),
        "duplicates": result.get("duplicates", 0),
    })
    return out


# ── 7. 分批气泡推群 ─────────────────────────────────────────────

# 2026-09-15 田耕郡现场实测：49 条被折叠成摘要、明细丢失。
# 新口径（红线五.10 修订）：明细永不省略 —— 按优先级分批逐条全发，每批 ≤ ONSITE_BATCH_SIZE 条；
# 总量 > ONSITE_SUMMARY_THRESHOLD（同日由 30 收到 10）时先补一条汇总气泡，随后仍把全部明细分批补齐；
# 本展会线索池入口跟汇总气泡走（≤阈值时挂末条明细气泡）。
ONSITE_BATCH_SIZE = 10
ONSITE_SUMMARY_THRESHOLD = 10


def _onsite_entries(main: list[str], follow: list[str]) -> list[tuple[str, str]]:
    """(层级, 明细行)：主推在前、跟进在后，保持调用方给定的优先级顺序。"""
    return [("主推", line) for line in main] + [("跟进", line) for line in follow]


def build_onsite_bubbles(header: str, main: list[str], follow: list[str],
                         batch_size: int = ONSITE_BATCH_SIZE,
                         summary_threshold: int = ONSITE_SUMMARY_THRESHOLD,
                         pool_url: str = "") -> list[str]:
    """现场推荐气泡列表（可多条）：分批逐条列全明细，禁止折叠丢明细。

    - 顺序：主推在前、跟进在后（调用方已按优先级排序），切批不重排、不去重。
    - 每批 ≤ batch_size 条，逐条列出（沿用「公司名｜国家｜理由」现有行格式）。
    - 总量 > summary_threshold：首条为汇总气泡（总数 / 主推·跟进 / Top 亮点）+ 池入口，
      随后仍是**全部**明细批次——汇总只是补充，不替代明细。
    - pool_url 非空时入口必给：有汇总就放汇总里；没有汇总（≤阈值）就挂末条气泡末尾。
    - 无名单返回 []（调用方不推气泡）。
    """
    entries = _onsite_entries([str(x) for x in (main or [])], [str(x) for x in (follow or [])])
    total = len(entries)
    if total == 0:
        return []
    if batch_size < 1:
        raise ValueError("batch_size must be >= 1")
    main_count = sum(1 for tier, _ in entries if tier == "主推")
    follow_count = total - main_count
    batches = [entries[i:i + batch_size] for i in range(0, total, batch_size)]
    link_line = f"{POOL_LINK_PREFIX}{pool_url}" if pool_url else ""

    bubbles: list[str] = []
    if total > summary_threshold:
        summary = [
            header,
            f"主推 {main_count} 家 · 跟进 {follow_count} 家（共 {total} 家）",
            f"全部明细分 {len(batches)} 批逐条发出，不省略：",
        ]
        highlights = [line for _, line in entries[:3]]
        if highlights:
            summary.append("【Top 亮点】")
            summary.extend(highlights)
        if link_line:
            summary.append(link_line)
        bubbles.append("\n".join(summary))

    for index, batch in enumerate(batches, 1):
        body: list[str] = [header]
        if len(batches) > 1:
            body.append(f"（第 {index}/{len(batches)} 批 · 共 {total} 家）")
        current = None
        for tier, line in batch:
            if tier != current:
                body.append(f"【{tier}】")
                current = tier
            body.append(line)
        bubbles.append("\n".join(body))

    if link_line and total <= summary_threshold:
        # 没有汇总气泡也不能丢池入口：挂到末条气泡末尾（明细行格式不变）
        bubbles[-1] = bubbles[-1] + "\n" + link_line
    return bubbles


def send_card(chat_id: str, text: str, dry_run: bool = False) -> bool:
    if not chat_id:
        print("[dc_onsite_recommend] 缺 chat_id，跳过推群", file=sys.stderr)
        return False
    cmd = ["lark-cli", "im", "+messages-send", "--as", "bot",
           "--chat-id", chat_id, "--text", text]
    if dry_run:
        print("[dry-run] " + " ".join(cmd))
        return True
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return True
    except Exception as e:
        print(f"[dc_onsite_recommend] 推群失败: {e}", file=sys.stderr)
        return False


# ── 主流程 ──────────────────────────────────────────────────────

def run(args) -> dict:
    company_id = canonical_company_id(args.company_id)
    if not company_id:
        raise SystemExit("[dc_onsite_recommend] 无法确定企业 ID")

    # 执行闸门：展中推荐属「需确认」类，绝不能免确认自动发（2026-09-15 定稿）
    try:
        from dc_exhibition_policy import decide_send  # noqa: PLC0415
        send_policy = decide_send(ONSITE_POOL_SOURCE, stage="展中")
    except Exception:  # noqa: BLE001
        send_policy = {"action": "confirm", "auto": False,
                       "reason": "闸门不可用 → 按最保守处理"}

    # 确定当前开展展会
    if args.exhibition_id:
        exhs = [{"exhibitionId": args.exhibition_id, "name": "", "country": "",
                 "tz": FALLBACK_TZ, "inshowStartDate": "", "inshowEndDate": ""}]
    else:
        exhs = current_exhibitions(company_id, use_cache=not args.no_cache)
    if not exhs:
        print("NO_RUN")
        return {"action": "onsite_recommend", "status": "no_exhibition", "count": 0}

    # 时点闸门：只有 cron 带 --slot-gate 才启用。skill 手动触发不带，任何时间都能跑。
    # 放在这里而不是更早，是因为要先知道展会国家才知道该用哪个时区判断「现在几点」。
    if getattr(args, "slot_gate", False):  # 测试夹具/旧调用方可能没有这个属性
        slots = parse_slots(args.slots)
        due = [e for e in exhs if local_now(e.get("tz") or FALLBACK_TZ).hour in slots]
        if not due:
            snapshot = [
                {"exhibitionId": e["exhibitionId"], "tz": e.get("tz"),
                 "localTime": local_now(e.get("tz") or FALLBACK_TZ).strftime("%Y-%m-%d %H:%M")}
                for e in exhs
            ]
            print("NO_RUN")
            return {"action": "onsite_recommend", "status": "not_in_slot",
                    "slots": list(slots), "exhibitions": snapshot, "count": 0}
        exhs = due

    keywords = search_terms(company_id)
    invited = load_invited_cdp_ids(company_id)
    chat_id = (args.chat_id or get_default_target() or "").strip()

    results = []
    for exh in exhs:
        buyers = fetch_onsite(exh["exhibitionId"], keywords)
        candidates = [b for b in buyers if (b.get("companyCdpid") or b.get("companyCdpId") or "").strip() not in invited]
        # 排除不落铁律：黑名单/明确拒绝不推也不落池
        survivors = [b for b in candidates if not is_excluded_from_onsite(b)]
        excluded = len(candidates) - len(survivors)
        main, follow = [], []
        for b in survivors:
            tier, line = classify(b, keywords)
            (main if tier == "主推" else follow).append(line)
        pool = land_onsite_leads(company_id, exh, survivors, keywords,
                                 chat_id=chat_id, dry_run=args.dry_run)
        if pool.get("error"):
            print(f"[dc_onsite_recommend] 落池失败（明细照推）: {pool['error']}", file=sys.stderr)
        if main or follow or excluded:
            header = f"📥 现场未邀约匹配买家（{exh.get('name') or exh['exhibitionId']}）"
            bubbles = build_onsite_bubbles(header, main, follow, pool_url=pool.get("url") or "")
            sent = sum(1 for text in bubbles if send_card(chat_id, text, dry_run=args.dry_run))
            results.append({"exhibitionId": exh["exhibitionId"], "candidates": len(candidates),
                            "main": len(main), "follow": len(follow),
                            "excluded": excluded, "bubbles": len(bubbles), "sent": sent,
                            "pool": pool})

    return {"action": "onsite_recommend", "company_id": company_id,
            "exhibitions": len(exhs), "results": results,
            "send_policy": send_policy}


def main() -> None:
    p = argparse.ArgumentParser(description="小元-展会现场未邀约匹配买家推荐")
    p.add_argument("action", choices=["run"], help="执行推荐")
    p.add_argument("--company-id", default=None, help="企业 ID（缺省读 MIO_CDP_SUPPLIER_ID）")
    p.add_argument("--exhibition-id", default="", help="指定展会 ID（跳过自动判断当前展会）")
    p.add_argument("--chat-id", default="", help="群 chat_id（缺省读 dc_notify routes default）")
    p.add_argument("--dry-run", action="store_true", help="只打印不执行")
    p.add_argument("--slot-gate", action="store_true",
                   help="按展会当地时间判断是否到推荐时点，不到就 NO_RUN（cron 专用；skill 手动触发别带）")
    p.add_argument("--slots", default="",
                   help="推荐时点，展会当地整点，逗号分隔（默认 10,14,16），仅配合 --slot-gate 生效")
    p.add_argument("--no-cache", action="store_true",
                   help="跳过展会记录缓存，强制重新拉取")
    args = p.parse_args()

    result = run(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
