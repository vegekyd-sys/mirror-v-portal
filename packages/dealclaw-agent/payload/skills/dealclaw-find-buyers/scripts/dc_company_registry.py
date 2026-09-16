#!/usr/bin/env python3
"""
DC-Company-Registry — 企业资源注册表（线索池绑定）

每个企业一个线索池飞书 Bitable。所有线索写入前必须先调 ensure_company_lead_pool()。

v2: 改用 lark-cli base 替代裸调飞书 API + FEISHU_BOT_TOKEN。同一把钥匙。

用法:
  python3 dc_company_registry.py ensure solarunis.com "Solarunis"
  python3 dc_company_registry.py show solarunis.com
  python3 dc_company_registry.py list
"""

import json, logging, os, sys, subprocess
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any

DATA_DIR = Path(__file__).resolve().parent / "data"
REGISTRY_FILE = DATA_DIR / "company_registry.json"

# ── 线索池 v4 字段定义（lark-cli base JSON 格式）──
# 注意: lark-cli v1.0.82 不识别 type="url"，官网字段暂用 text
LEAD_POOL_FIELDS_JSON = json.dumps([
    {"name": "公司名",   "type": "text"},
    {"name": "官网",     "type": "text"},
    {"name": "公司简介", "type": "text"},
    {"name": "国家",     "type": "text"},
    {"name": "买家类型", "type": "select", "multiple": False, "options": [
        {"name": "品牌商"}, {"name": "制造商"}, {"name": "经销商"}, {"name": "工程商"}]},
    {"name": "匹配产品", "type": "select", "multiple": True},
    {"name": "推荐理由", "type": "text"},
    {"name": "联系人",   "type": "text"},
    {"name": "来源",     "type": "select", "multiple": False, "options": [
        {"name": "引擎搜索"}, {"name": "星擎线索"}, {"name": "猎客线索"},
        {"name": "米奥数据库"}, {"name": "Apollo数据库"}, {"name": "展会线索"},
        {"name": "历届展会"}, {"name": "用户导入"}, {"name": "买家推荐"},
        {"name": "展中推荐"}, {"name": "扫码买家"}]},
    {"name": "线索大类", "type": "select", "multiple": False, "options": [
        {"name": "展会买家"}, {"name": "常态买家"}]},
    {"name": "冷热",     "type": "select", "multiple": False, "options": [
        {"name": "🔥热"}, {"name": "❄️冷"}]},
    {"name": "阶段",     "type": "select", "multiple": False, "options": [
        {"name": "待触达"}, {"name": "已触达"}, {"name": "已回复"},
        {"name": "报价中"}, {"name": "成交"}, {"name": "停止触达"}]},
], ensure_ascii=False)

# 期望的字段名集合（用于验证 field_map 完整性）
EXPECTED_FIELD_NAMES = {
    "公司名", "官网", "公司简介", "国家", "买家类型", "匹配产品",
    "推荐理由", "联系人", "来源", "冷热", "阶段",
}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _write_memory_leads(company_id: str, feishu_fields: list) -> None:
    """改 A：写飞书后直写 memory leads.json（权威数据）。失败不阻断飞书，仅告警。"""
    try:
        mio_dir = Path(__file__).resolve().parents[3] / "work" / "mio-api"
        if str(mio_dir) not in sys.path:
            sys.path.insert(0, str(mio_dir))
        from dc_memory_data import write_leads_to_memory
        write_leads_to_memory(company_id, feishu_fields)
    except Exception as e:
        print(f"[memory-leads] 直写 memory 失败（飞书已写入）: {e}", file=sys.stderr)


def _run_lark(*args, **kwargs) -> Dict[str, Any]:
    """执行 lark-cli 命令，返回解析后的 JSON。失败抛 RuntimeError。"""
    cmd = ["lark-cli"] + list(args)
    timeout = kwargs.pop("timeout", 30)
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, **kwargs
        )
    except FileNotFoundError:
        raise RuntimeError("lark-cli 未安装或不在 PATH 中")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"lark-cli 命令超时 ({timeout}s): {' '.join(cmd)}")

    if result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout.strip() or "(no output)"
        raise RuntimeError(f"lark-cli 失败 [exit={result.returncode}]: {stderr[:300]}")

    stdout = result.stdout.strip()
    if not stdout:
        raise RuntimeError("lark-cli 返回空输出")

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"lark-cli 返回非 JSON: {stdout[:200]}")

    if not data.get("ok"):
        err = data.get("error", {})
        msg = err.get("message", "未知错误")
        raise RuntimeError(f"lark-cli API 错误: {msg}")

    return data


def _create_bitable(name: str) -> Dict:
    """通过 lark-cli base 创建飞书多维表格，返回 {app_token, name, url, table_id}"""
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"无效的 bitable 名称: {name!r}")
    safe_name = name.strip()[:100]

    result = _run_lark(
        "base", "+base-create",
        "--name", f"{safe_name}线索池",
        "--table-name", "线索池",
        "--fields", LEAD_POOL_FIELDS_JSON,
        "--as", "bot",
        timeout=60,
    )

    base = result["data"]["base"]
    table = result["data"].get("table", {})
    return {
        "app_token": base["base_token"],
        "name": base["name"],
        "url": base.get("url", ""),
        "table_id": table.get("id", ""),
    }


def _get_group_human_members(chat_id: str) -> list:
    """获取群里的人类成员 open_id 列表（排除 bot）。"""
    result = _run_lark(
        "im", "+chat-members-list",
        "--chat-id", chat_id,
        "--as", "bot",
    )
    users = result.get("data", {}).get("users", [])
    return [u["member_id"] for u in users if u.get("member_id")]


def grant_group_access(app_token: str, chat_id: str, perm: str = "full_access") -> Dict:
    """
    给群里所有人类成员授予 Bitable 访问权限。

    参数:
      app_token: Bitable base_token
      chat_id:   飞书群 chat_id
      perm:      权限级别，默认 full_access

    返回:
      {"granted": ["ou_xxx", ...], "failed": [{"member_id": ..., "error": ...}], "total": N}
    """
    if not chat_id or not chat_id.strip():
        return {"granted": [], "failed": [], "total": 0, "skipped": "chat_id 为空"}

    try:
        member_ids = _get_group_human_members(chat_id)
    except RuntimeError as e:
        return {"granted": [], "failed": [], "total": 0, "skipped": f"获取群成员失败: {e}"}

    if not member_ids:
        return {"granted": [], "failed": [], "total": 0, "skipped": "群内无人类成员"}

    granted = []
    failed = []

    for mid in member_ids:
        try:
            _run_lark(
                "drive", "permission.members", "create",
                "--token", app_token,
                "--type", "bitable",
                "--data", json.dumps({
                    "member_id": mid,
                    "member_type": "openid",
                    "perm": perm,
                    "type": "user",
                }),
                "--as", "bot",
                "--yes",
            )
            granted.append(mid)
        except RuntimeError as e:
            err_str = str(e)
            # 1063001 = 权限已存在，视为已授权
            if "1063001" in err_str:
                granted.append(mid)
            else:
                failed.append({"member_id": mid, "error": err_str[:200]})

    return {
        "granted": granted,
        "failed": failed,
        "total": len(member_ids),
    }


def _get_field_map(app_token: str, table_id: str) -> Dict[str, str]:
    """获取字段名 → field_id 映射"""
    result = _run_lark(
        "base", "+field-list",
        "--base-token", app_token,
        "--table-id", table_id,
        "--as", "bot",
    )
    items = result.get("data", {}).get("fields", [])
    field_map = {}
    for f in items:
        name = f.get("name", "")
        fid = f.get("id", "")
        if name and fid:
            field_map[name] = fid
    return field_map


# ── 本地注册表（企业 → Bitable 映射）──

class CompanyRegistry:
    """企业资源注册表 — 管理 company_id → 线索池 bitable 映射"""

    def __init__(self):
        os.makedirs(str(DATA_DIR), exist_ok=True)
        self._entries = self._load()

    def _load(self):
        if REGISTRY_FILE.exists():
            return json.loads(REGISTRY_FILE.read_text())
        return {}

    def _save(self):
        REGISTRY_FILE.write_text(json.dumps(self._entries, ensure_ascii=False, indent=2))

    def get(self, company_id: str) -> Optional[Dict]:
        return self._entries.get(company_id)

    def set(self, company_id: str, info: Dict):
        self._entries[company_id] = info
        self._save()

    def list_all(self):
        return dict(self._entries)

    def remove(self, company_id: str):
        if company_id in self._entries:
            del self._entries[company_id]
            self._save()
            return True
        return False


# ── 核心 API ──

def ensure_company_lead_pool(
    company_id: str,
    company_name: str,
    chat_id: Optional[str] = None,
) -> Dict:
    """
    确保企业线索池存在。新建时可选授权群成员。

    参数:
      company_id:   企业唯一标识
      company_name: 企业展示名
      chat_id:      可选，飞书群 chat_id。新建 base 后自动给群成员授权

    返回格式与 v1 完全兼容:
      {
        "app_token": "xxx",
        "table_id": "tblxxx",
        "field_map": {"公司名": "fldxxx", ...},
        "created": bool,
        "group_access": {...} | None,   # 仅 created=true 且传了 chat_id 时返回
      }
    """
    if not company_id or not company_id.strip():
        raise ValueError("company_id 不能为空")
    if not company_name or not company_name.strip():
        raise ValueError("company_name 不能为空")

    registry = CompanyRegistry()

    # 1. 查注册表
    existing = registry.get(company_id)
    if existing:
        fm = existing.get("field_map", {})
        if EXPECTED_FIELD_NAMES.issubset(set(fm.keys())):
            result = {
                "app_token": existing["app_token"],
                "table_id": existing["table_id"],
                "field_map": existing["field_map"],
                "created": False,
                "bitable_url": existing.get("bitable_url") or
                    f"https://versa-ai.feishu.cn/base/{existing['app_token']}?table={existing['table_id']}",
            }
            return result
        # field_map 不完整 → 尝试刷新
        try:
            fresh_map = _get_field_map(existing["app_token"], existing["table_id"])
            existing["field_map"] = fresh_map
            registry.set(company_id, existing)
            return {
                "app_token": existing["app_token"],
                "table_id": existing["table_id"],
                "field_map": fresh_map,
                "created": False,
                "bitable_url": existing.get("bitable_url") or
                    f"https://versa-ai.feishu.cn/base/{existing['app_token']}?table={existing['table_id']}",
            }
        except RuntimeError:
            pass  # Bitable 可能被删了，走新建逻辑

    # 2. 创建新线索池（lark-cli base 一步搞定：建 base + 建表 + 建全部字段）
    bitable = _create_bitable(company_name)
    app_token = bitable["app_token"]
    table_id = bitable["table_id"]

    # 3. 获取字段映射
    field_map = _get_field_map(app_token, table_id)

    # 4. 保存到注册表
    entry = {
        "app_token": app_token,
        "table_id": table_id,
        "field_map": field_map,
        "company_name": company_name,
        "created_at": _now(),
        "updated_at": _now(),
        "bitable_url": f"https://versa-ai.feishu.cn/base/{app_token}?table={table_id}",
    }
    registry.set(company_id, entry)

    result = {
        "app_token": app_token,
        "table_id": table_id,
        "field_map": field_map,
        "created": True,
        "bitable_url": entry["bitable_url"],
    }

    # 5. 新建后自动授权群成员
    if chat_id and chat_id.strip():
        access = grant_group_access(app_token, chat_id, perm="full_access")
        result["group_access"] = access

    return result


def _normalize_key(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"^https?://", "", value)
    value = re.sub(r"^www\.", "", value)
    return value.split("/")[0].strip()


def _extract_buyer_tags(record: dict) -> list:
    """提取买家采购/产品标签（中文优先，其次英文）。"""
    tags = []
    st = record.get("sortedT2TagInfo") or []
    # 优先高相关标签（isHighLine=1）
    for t in st:
        if not isinstance(t, dict):
            continue
        for ti in (t.get("tagInfo") or []):
            if ti.get("isHighLine") == 1:
                text = ti.get("nameCn") or ti.get("nameEn") or ""
                if text and text not in tags:
                    tags.append(text)
    # 兜底：全部 tagInfo
    if not tags:
        for t in st:
            if not isinstance(t, dict):
                continue
            for ti in (t.get("tagInfo") or []):
                text = ti.get("nameCn") or ti.get("nameEn") or ""
                if text and text not in tags:
                    tags.append(text)
    # 采购标签兜底
    p = record.get("purchaseTagCodesDesc") or ""
    if isinstance(p, str):
        for x in re.split(r"[,，;；]", p):
            x = x.strip()
            if x and x not in tags:
                tags.append(x)
    # 字段名兜底：purchaseTags / productList / 关注产品（各数据源命名不同）
    for _alt_key in ("purchaseTags", "productList", "关注产品"):
        _alt = record.get(_alt_key)
        if isinstance(_alt, str):
            _alt = [x.strip() for x in re.split(r"[,，;；]", _alt) if x.strip()]
        if isinstance(_alt, list):
            for _item in _alt:
                if isinstance(_item, dict):
                    _text = (_item.get("nameCn") or _item.get("nameEn")
                             or _item.get("name") or _item.get("productName") or "")
                else:
                    _text = str(_item)
                if _text and _text not in tags:
                    tags.append(_text)
    return tags


def _match_products(buyer_tags: list, enterprise_products) -> list:
    """把买家标签对齐到企业真实产品：每个标签匹配最具体的一个产品（列表按优先级排），用户没有的不写。"""
    matched = []
    for tag in buyer_tags:
        hit = None
        for prod in (enterprise_products or []):
            if not isinstance(prod, dict):
                continue
            name = prod.get("name", "")
            keywords = prod.get("keywords") or []
            kws = [k for k in keywords if k]
            if not kws:
                continue
            if any(kw and kw in tag for kw in kws):
                hit = name
                break  # 第一个命中即止（列表按优先级排）
        if hit and hit not in matched:
            matched.append(hit)
    return matched


def _record_fields(record: dict, source: str, enterprise_products=None) -> dict:
    """把搜索结果映射为线索池 v4 字段。"""
    company = record.get("companyName") or record.get("company_name") or record.get("name") or ""
    website = record.get("website") or record.get("domain") or record.get("url") or ""
    country = record.get("countryCnName") or record.get("country") or ""
    profile = (
        record.get("companyProfile")
        or record.get("briefInfo")
        or record.get("买家公司简介")
        or record.get("company_profile")
        or ""
    )

    # 买家类型：字段名兜底（各数据源命名不同）
    attrs = (
        record.get("companyAttributes")
        or record.get("buyer_type")
        or record.get("buyerType")
        or record.get("buyerTag")
        or record.get("buyer_tags")
        or []
    )
    if isinstance(attrs, str):
        attrs = [attrs]
    buyer_type = ""
    for raw in attrs:
        text = raw.get("name", "") if isinstance(raw, dict) else str(raw)
        if any(k in text for k in ("品牌", "brand")):
            buyer_type = "品牌商"; break
        if any(k in text for k in ("制造", "manufacturer")):
            buyer_type = "制造商"; break
        if any(k in text for k in ("分销", "经销", "批发", "distributor", "wholesale")):
            buyer_type = "经销商"; break
        if any(k in text for k in ("工程", "安装", "project", "installer")):
            buyer_type = "工程商"; break

    # 匹配产品：只写入与企业真实产品对齐的（先看用户有什么产品，再匹配买家采购标签）
    buyer_tags = _extract_buyer_tags(record)
    products = _match_products(buyer_tags, enterprise_products)
    if not products and not enterprise_products:
        # 无企业产品可对齐时，用买家采购标签近似（真相源：无评分时用采购标签近似，标「待匹配」）
        products = [t for t in buyer_tags if t]

    reason = (
        record.get("recommendation")
        or record.get("recommendation_reason")
        or record.get("ai_match_reason")
        or ""
    )

    fields = {
        "公司名": str(company)[:200],
        "官网": str(website)[:500],
        "国家": str(country)[:100],
        "推荐理由": str(reason)[:500],
        "来源": source,
    }
    if buyer_type:
        fields["买家类型"] = buyer_type
    if profile:
        fields["公司简介"] = str(profile)[:500]
    if products:
        fields["匹配产品"] = products[:20]
    # 字段缺失时标空原因，避免静默跳过（全局可观测）
    _missing = []
    if not buyer_type:
        _missing.append("买家类型(需 companyAttributes/buyerType/buyerTag/buyer_tags)")
    if not products:
        _missing.append("匹配产品(需 purchaseTags/productList/关注产品)")
    if _missing:
        logging.getLogger("dc_company_registry").warning(
            "线索池落库字段缺失：company=%r source=%s 缺失=[%s]",
            str(company)[:80], source, ", ".join(_missing))
    # ⭐ 联系人解锁确认后才落库：初始落库时为空，经用户确认（意图识别/反问）解锁后才写入。
    return fields


def _existing_record_index(app_token: str, table_id: str) -> dict:
    """读取公司名/官网索引，供幂等 upsert 使用。"""
    result = _run_lark(
        "base", "+record-list",
        "--base-token", app_token,
        "--table-id", table_id,
        "--field-id", "公司名",
        "--field-id", "官网",
        "--limit", "200",
        "--format", "json",
        "--as", "bot",
    )
    data = result.get("data", {})
    rows = data.get("data") or data.get("items") or data.get("records") or []
    rids = data.get("record_id_list") or []
    fnames = data.get("fields") or []
    index = {}

    def _fields_of(row):
        if isinstance(row, dict):
            return row.get("fields") or row.get("record", {}).get("fields") or {}
        if isinstance(row, list) and fnames:
            return dict(zip(fnames, row))
        return {}

    def _rid_of(item, i):
        if isinstance(item, dict):
            return item.get("record_id") or item.get("_record_id") or item.get("id") or item.get("record", {}).get("record_id")
        return rids[i] if i < len(rids) else None

    for i, item in enumerate(rows):
        fields = _fields_of(item)
        record_id = _rid_of(item, i)
        if not record_id:
            continue
        company_key = _normalize_key(str(fields.get("公司名", "")))
        website_key = _normalize_key(str(fields.get("官网", "")))
        if company_key:
            index[f"company:{company_key}"] = record_id
        if website_key:
            index[f"website:{website_key}"] = record_id
    return index


def sync_leads_to_pool(
    company_id: str,
    company_name: str,
    records: list,
    *,
    source: str = "引擎搜索",
    chat_id: Optional[str] = None,
    enterprise_products: Optional[list] = None,
    exclude_manufacturer: bool = False,
) -> Dict:
    """确保企业线索池存在，将最终展示的搜索结果幂等写入，并返回链接。

    enterprise_products: 企业真实产品列表 [{name, keywords}]，用于把买家采购标签
    对齐到企业产品（用户没有的产品不写入匹配产品）。缺省时匹配产品留空。

    exclude_manufacturer: 企业产品为「成品」时传 True。判定买家身份为制造商
    （自产自用型/与买方自产线重叠）时直接跳过，不写入线索池。该布尔值由
    上层（模型搜索前置判断产品类型）决定，本函数不做产品类型语义判断。
    """
    pool = ensure_company_lead_pool(company_id, company_name, chat_id=chat_id)
    app_token = pool["app_token"]
    table_id = pool["table_id"]
    existing = _existing_record_index(app_token, table_id)

    creates = []
    updates = []
    skipped = 0
    excluded_manufacturer = 0
    for record in records or []:
        fields = _record_fields(record, source, enterprise_products=enterprise_products)
        if exclude_manufacturer and fields.get("买家类型") == "制造商":
            excluded_manufacturer += 1
            continue
        company_key = _normalize_key(fields.get("公司名", ""))
        website_key = _normalize_key(fields.get("官网", ""))
        if not company_key and not website_key:
            skipped += 1
            continue
        record_id = existing.get(f"website:{website_key}") or existing.get(f"company:{company_key}")
        if record_id:
            updates.append((record_id, fields))
        else:
            fields.setdefault("冷热", "❄️冷")
            fields.setdefault("阶段", "待触达")
            creates.append(fields)

    created_ids = []
    if creates:
        result = _run_lark(
            "base", "+record-batch-create",
            "--base-token", app_token,
            "--table-id", table_id,
            "--json", json.dumps({"create_records": creates}, ensure_ascii=False),
            "--as", "bot",
            timeout=60,
        )
        created = result.get("data", {}).get("records") or result.get("data", {}).get("items") or []
        created_ids = [x.get("record_id") or x.get("id") for x in created if isinstance(x, dict)]

    for record_id, fields in updates:
        _run_lark(
            "base", "+record-upsert",
            "--base-token", app_token,
            "--table-id", table_id,
            "--record-id", record_id,
            "--json", json.dumps(fields, ensure_ascii=False),
            "--as", "bot",
        )

    _write_memory_leads(company_id, creates + [f for _, f in updates])

    return {
        "created": len(creates),
        "updated": len(updates),
        "skipped": skipped,
        "excluded_manufacturer": excluded_manufacturer,
        "record_ids": [x for x in created_ids if x],
        "app_token": app_token,
        "table_id": table_id,
        "bitable_url": pool["bitable_url"],
    }


_PRESERVE_ON_UPDATE = ("是否解锁", "阶段", "冷热")

def _buyerleads_fields(record: dict, enterprise_products=None) -> dict:
    """把 buyerLeadsPlaza 猎客线索映射为线索池字段（来源=AI猎客，解锁前联系人为空）。"""
    reason = record.get("recentTrend") or record.get("买家公司简介") or record.get("companyProfile") or ""
    fields = {
        "公司名": (record.get("buyerCompany") or "")[:200],
        "官网": (record.get("companyWebsite") or record.get("website") or "")[:500],
        "国家": (record.get("buyerCountry") or "")[:100],
        "推荐理由": reason[:500],
        "来源": "AI猎客",
        "冷热": "🔥热",
        "阶段": "待触达",
        "是否解锁": "未解锁",
    }
    bt = record.get("buyerType")
    if bt:
        fields["买家类型"] = bt
    # 匹配产品：只写与企业真实产品对齐的（用户没有的不写）
    product_tags = []
    pl = record.get("productList") or record.get("关注产品") or []
    if isinstance(pl, list):
        for p in pl:
            if isinstance(p, dict):
                product_tags.append(p.get("productName") or p.get("productNameEn") or "")
            else:
                product_tags.append(str(p))
    elif isinstance(pl, str):
        product_tags.append(pl)
    product_tags.append(reason)
    products = _match_products([t for t in product_tags if t], enterprise_products)
    if products:
        fields["匹配产品"] = products
    # AI匹配等级：从 AI匹配分 映射（高≥70 / 中≥50 / 低<50）
    score = record.get("AI匹配分") or record.get("ai_score") or record.get("aiMatchScore")
    if isinstance(score, (int, float)) and not isinstance(score, bool):
        fields["AI匹配等级"] = "高" if score >= 70 else "中" if score >= 50 else "低"
    return fields


def sync_buyerleads_to_pool(
    company_id: str,
    company_name: str,
    records: list,
    *,
    enterprise_products: Optional[list] = None,
    chat_id: Optional[str] = None,
    exclude_manufacturer: bool = False,
) -> Dict:
    """把 buyerLeadsPlaza 猎客线索映射并幂等写入统一线索池（来源=AI猎客）。

    exclude_manufacturer: 企业产品为「成品」时传 True，判定买家身份为制造商时
    直接跳过不写入。布尔值由上层（模型搜索前置判断产品类型）决定。
    """
    pool = ensure_company_lead_pool(company_id, company_name, chat_id=chat_id)
    app_token = pool["app_token"]
    table_id = pool["table_id"]
    existing = _existing_record_index(app_token, table_id)

    creates = []
    updates = []
    skipped = 0
    excluded_manufacturer = 0
    for record in records or []:
        fields = _buyerleads_fields(record, enterprise_products=enterprise_products)
        if exclude_manufacturer and fields.get("买家类型") == "制造商":
            excluded_manufacturer += 1
            continue
        company_key = _normalize_key(fields.get("公司名", ""))
        website_key = _normalize_key(fields.get("官网", ""))
        if not company_key and not website_key:
            skipped += 1
            continue
        record_id = existing.get(f"website:{website_key}") or existing.get(f"company:{company_key}")
        if record_id:
            updates.append((record_id, fields))
        else:
            creates.append(fields)

    created_ids = []
    if creates:
        result = _run_lark(
            "base", "+record-batch-create",
            "--base-token", app_token,
            "--table-id", table_id,
            "--json", json.dumps({"create_records": creates}, ensure_ascii=False),
            "--as", "bot",
            timeout=60,
        )
        created = (result.get("data", {}).get("record_id_list")
                   or result.get("data", {}).get("records")
                   or result.get("data", {}).get("items") or [])
        created_ids = [x for x in created if isinstance(x, str)]

    for record_id, fields in updates:
        _run_lark(
            "base", "+record-upsert",
            "--base-token", app_token,
            "--table-id", table_id,
            "--record-id", record_id,
            "--json", json.dumps({k: v for k, v in fields.items() if k not in _PRESERVE_ON_UPDATE}, ensure_ascii=False),
            "--as", "bot",
        )

    _write_memory_leads(company_id, creates + [f for _, f in updates])

    return {
        "created": len(creates),
        "updated": len(updates),
        "skipped": skipped,
        "excluded_manufacturer": excluded_manufacturer,
        "record_ids": [x for x in created_ids if x],
        "app_token": app_token,
        "table_id": table_id,
        "bitable_url": pool["bitable_url"],
    }


def get_lead_pool(company_id: str) -> Optional[Dict]:
    """只读获取线索池信息，不创建"""
    registry = CompanyRegistry()
    existing = registry.get(company_id)
    if not existing:
        return None
    return {
        "app_token": existing["app_token"],
        "table_id": existing["table_id"],
        "field_map": existing.get("field_map", {}),
        "company_name": existing.get("company_name", ""),
        "bitable_url": existing.get("bitable_url", ""),
    }


# ── CLI（与 v1 完全兼容）──

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法:")
        print("  python3 dc_company_registry.py ensure <company_id> <company_name> [--chat-id <chat_id>]")
        print("  python3 dc_company_registry.py show <company_id>")
        print("  python3 dc_company_registry.py list")
        print("  python3 dc_company_registry.py grant <app_token> <chat_id> [perm]")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "ensure":
        if len(sys.argv) < 4:
            print("用法: ensure <company_id> <company_name> [--chat-id <chat_id>]")
            sys.exit(1)
        company_id = sys.argv[2]
        company_name = sys.argv[3]
        chat_id = None
        # 解析可选的 --chat-id
        for i, arg in enumerate(sys.argv):
            if arg == "--chat-id" and i + 1 < len(sys.argv):
                chat_id = sys.argv[i + 1]
                break
        try:
            result = ensure_company_lead_pool(company_id, company_name, chat_id=chat_id)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        except Exception as e:
            print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
            sys.exit(1)

    elif cmd == "grant":
        if len(sys.argv) < 4:
            print("用法: grant <app_token> <chat_id> [perm]")
            sys.exit(1)
        app_token = sys.argv[2]
        chat_id = sys.argv[3]
        perm = sys.argv[4] if len(sys.argv) > 4 else "full_access"
        try:
            result = grant_group_access(app_token, chat_id, perm=perm)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        except Exception as e:
            print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
            sys.exit(1)

    elif cmd == "show":
        if len(sys.argv) < 3:
            print("用法: show <company_id>")
            sys.exit(1)
        result = get_lead_pool(sys.argv[2])
        if result:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(f"❌ 未找到 {sys.argv[2]} 的线索池绑定")
            sys.exit(1)

    elif cmd == "list":
        registry = CompanyRegistry()
        entries = registry.list_all()
        if entries:
            print(json.dumps(entries, ensure_ascii=False, indent=2))
        else:
            print("（空）")

    else:
        print(f"未知命令: {cmd}")
        sys.exit(1)
