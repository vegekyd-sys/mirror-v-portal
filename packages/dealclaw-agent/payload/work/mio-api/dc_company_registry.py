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

import json, os, sys, subprocess
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any

DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent / "data")))
REGISTRY_FILE = DATA_DIR / "company_registry.json"

# ── 线索池 v4 字段定义（lark-cli base JSON 格式）──
# 注意: lark-cli v1.0.82 不识别 type="url"，官网字段暂用 text
LEAD_POOL_FIELDS_JSON = json.dumps([
    {"name": "公司名",   "type": "text"},
    {"name": "官网",     "type": "text"},
    {"name": "公司简介", "type": "text"},
    {"name": "公司CDPID", "type": "text"},
    {"name": "国家",     "type": "text"},
    {"name": "买家类型", "type": "select", "multiple": False, "options": [
        {"name": "品牌商"}, {"name": "制造商"}, {"name": "经销商"}, {"name": "工程商"}]},
    {"name": "匹配产品", "type": "select", "multiple": True},
    {"name": "推荐理由", "type": "text"},
    {"name": "联系人",   "type": "text"},
    {"name": "来源",     "type": "select", "multiple": False, "options": [
        {"name": "引擎搜索"}, {"name": "星擎线索"}, {"name": "猎采线索"},
        {"name": "米奥数据库"}, {"name": "Apollo数据库"}, {"name": "展会线索"},
        {"name": "历届展会"}, {"name": "用户导入"}, {"name": "买家推荐"}]},
    {"name": "冷热",     "type": "select", "multiple": False, "options": [
        {"name": "🔥热"}, {"name": "❄️冷"}]},
    {"name": "阶段",     "type": "select", "multiple": False, "options": [
        {"name": "待触达"}, {"name": "已触达"}, {"name": "已回复"},
        {"name": "报价中"}, {"name": "成交"}, {"name": "停止触达"}]},
], ensure_ascii=False)

# 期望的字段名集合（用于验证 field_map 完整性）
EXPECTED_FIELD_NAMES = {
    "公司名", "官网", "公司简介", "公司CDPID", "国家", "买家类型", "匹配产品",
    "推荐理由", "联系人", "来源", "冷热", "阶段",
}

# 搜索程序拥有的字段（update 时只允许写这些）；其余为用户手工维护，禁止覆盖。
SEARCH_OWNED_FIELDS = ("公司名", "官网", "公司CDPID", "国家", "来源")


def _now():
    return datetime.now(timezone.utc).isoformat()


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


class BitableResponseParseError(RuntimeError):
    """Bitable（lark-cli）响应结构无法解析。绝不静默返回空结果。"""


def _sanitize_response(resp, max_chars: int = 300) -> str:
    """脱敏响应摘要：只保留结构骨架，不暴露真实业务数据。"""
    try:
        skeleton = {}
        for k, v in (resp or {}).items():
            if isinstance(v, list):
                skeleton[str(k)] = f"<list len={len(v)}>"
            elif isinstance(v, dict):
                skeleton[str(k)] = f"<dict keys={list(v.keys())[:8]}>"
            else:
                skeleton[str(k)] = f"<{type(v).__name__}>"
        return json.dumps(skeleton, ensure_ascii=False)[:max_chars]
    except Exception:
        return f"<unserializable {type(resp).__name__}>"


def parse_created_record_ids(response: dict) -> list:
    """从 record-batch-create 响应提取 record_id 列表。

    兼容结构（按优先级）：
      1. data.record_id_list（lark-cli v1.0.85）
      2. data.records / data.items（旧版，每条 dict 含 record_id/id/record.record_id）
      3. 顶层 records / items

    有数据但无法提取 record_id → 抛 BitableResponseParseError；
    明确为空（空列表）才返回 []。
    """
    if not isinstance(response, dict):
        raise BitableResponseParseError(
            f"batch-create 响应不是 dict: {type(response).__name__}")

    data = response.get("data")
    if not isinstance(data, dict):
        data = response

    # 1) data.record_id_list
    rl = data.get("record_id_list")
    if isinstance(rl, list):
        return [str(x) for x in rl if x]

    # 2) data.records / data.items
    for key in ("records", "items"):
        recs = data.get(key)
        if isinstance(recs, list):
            if not recs:
                return []
            ids = []
            for r in recs:
                if not isinstance(r, dict):
                    continue
                rid = r.get("record_id") or r.get("id")
                if not rid and isinstance(r.get("record"), dict):
                    rid = r["record"].get("record_id") or r["record"].get("id")
                if rid:
                    ids.append(str(rid))
            if ids:
                return ids
            raise BitableResponseParseError(
                f"batch-create 响应含 {key}={len(recs)} 条但无法提取 record_id: "
                f"{_sanitize_response(response)}")

    # 3) 顶层 records / items
    for key in ("records", "items"):
        recs = response.get(key)
        if isinstance(recs, list):
            if not recs:
                return []
            ids = [str(r.get("record_id") or r.get("id")) for r in recs
                   if isinstance(r, dict) and (r.get("record_id") or r.get("id"))]
            if ids:
                return ids
            raise BitableResponseParseError(
                f"batch-create 顶层 {key} 无法提取 record_id: {_sanitize_response(response)}")

    raise BitableResponseParseError(
        f"batch-create 响应无法识别（无 record_id_list/records/items）: "
        f"{_sanitize_response(response)}")


def parse_record_list(response: dict) -> list:
    """从 record-list 响应提取 [{"record_id": str, "fields": {field_name: value}}]。

    兼容两种结构：
      A. columnar（lark-cli v1.0.85）：
         data.record_id_list + data.data（二维数组）+ data.fields / data.field_id_list（列头）
      B. row-based（旧版）：
         data.items / data.records，每条 {"record_id"/"id", "fields": {name: value}}
         或 {"record": {"record_id", "fields": {...}}}

    解析失败抛 BitableResponseParseError。
    """
    if not isinstance(response, dict):
        raise BitableResponseParseError(
            f"record-list 响应不是 dict: {type(response).__name__}")

    data = response.get("data")
    if not isinstance(data, dict):
        data = response

    # A. columnar
    rid_list = data.get("record_id_list")
    rows = data.get("data")
    if isinstance(rid_list, list) and isinstance(rows, list):
        headers = data.get("fields") or data.get("field_id_list") or []
        out = []
        for i, rid in enumerate(rid_list):
            row = rows[i] if i < len(rows) else []
            fields = {}
            if isinstance(headers, list) and isinstance(row, list):
                for j, h in enumerate(headers):
                    fields[str(h)] = row[j] if j < len(row) else ""
            out.append({"record_id": str(rid), "fields": fields})
        return out

    # B. row-based
    for key in ("items", "records"):
        recs = data.get(key)
        if isinstance(recs, list):
            out = []
            for item in recs:
                if not isinstance(item, dict):
                    continue
                fields = item.get("fields")
                rid = item.get("record_id") or item.get("id")
                if isinstance(item.get("record"), dict):
                    if fields is None:
                        fields = item["record"].get("fields")
                    if not rid:
                        rid = item["record"].get("record_id") or item["record"].get("id")
                if not isinstance(fields, dict):
                    fields = {}
                if rid:
                    out.append({"record_id": str(rid), "fields": fields})
            return out

    raise BitableResponseParseError(
        f"record-list 响应无法识别: {_sanitize_response(response)}")


def _record_fields(record: dict, source: str) -> dict:
    """把搜索结果映射为线索池 v4 字段。"""
    company = record.get("companyName") or record.get("company_name") or record.get("name") or ""
    website = record.get("website") or record.get("domain") or record.get("url") or ""
    cdp_id = record.get("companyCdpId") or record.get("company_cdp_id") or record.get("cdpId") or ""
    country = record.get("countryCnName") or record.get("country") or ""
    profile = (
        record.get("companyProfile")
        or record.get("briefInfo")
        or record.get("买家公司简介")
        or record.get("company_profile")
        or ""
    )

    attrs = record.get("companyAttributes") or record.get("buyer_type") or []
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

    tags = record.get("purchaseTags") or record.get("matched_products") or record.get("products") or []
    if isinstance(tags, str):
        tags = [x.strip() for x in re.split(r"[,，]", tags) if x.strip()]
    products = []
    for tag in tags:
        text = tag.get("name", "") if isinstance(tag, dict) else str(tag)
        if text and text not in products:
            products.append(text)

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
    if cdp_id:
        fields["公司CDPID"] = str(cdp_id)[:100]
    if profile:
        fields["公司简介"] = str(profile)[:500]
    if buyer_type:
        fields["买家类型"] = buyer_type
    if products:
        fields["匹配产品"] = products[:20]
    # ⭐ 联系人解锁确认后才落库：初始落库时为空，经用户确认（意图识别/反问）解锁后才写入。
    return fields


def _fetch_records(app_token: str, table_id: str) -> list:
    """读 record-list，返回 [{"record_id", "fields"}]（含搜索字段）。

    统一列字段：公司名/官网/公司CDPID/国家/来源（用于索引 + diff）。
    解析失败会抛 BitableResponseParseError。
    """
    result = _run_lark(
        "base", "+record-list",
        "--base-token", app_token,
        "--table-id", table_id,
        "--field-id", "公司名",
        "--field-id", "官网",
        "--field-id", "公司CDPID",
        "--field-id", "国家",
        "--field-id", "来源",
        "--limit", "200",
        "--format", "json",
        "--as", "bot",
    )
    return parse_record_list(result)


def _cmp_val(v) -> str:
    """把字段值规范化为可比较字符串（select 返回 list）。"""
    if isinstance(v, list):
        return "|".join(sorted(str(x).strip() for x in v if str(x).strip()))
    return str(v or "").strip()


def _search_field_diff(existing_fields: dict, new_fields: dict) -> dict:
    """返回仅含发生变化的搜索字段子集；无变化返回空 dict。"""
    diff = {}
    for k in SEARCH_OWNED_FIELDS:
        if _cmp_val(existing_fields.get(k)) != _cmp_val(new_fields.get(k)):
            diff[k] = new_fields[k] if k in new_fields else ""
    return diff


def _existing_record_index(app_token: str, table_id: str) -> dict:
    """从真实 record-list 响应建立索引（供幂等 upsert 使用）。

    返回扁平索引：
      cdp:<normalized>      → record_id   （最高优先级）
      website:<normalized>  → record_id   （第二优先级）
      company:<normalized>  → record_id   （仅辅助，不得单独用于覆盖）
    解析失败会抛 BitableResponseParseError，不静默返回空。
    """
    index = {}
    for row in _fetch_records(app_token, table_id):
        record_id = row.get("record_id")
        fields = row.get("fields") or {}
        if not record_id:
            continue
        cdp_key = _normalize_key(str(fields.get("公司CDPID", "")))
        website_key = _normalize_key(str(fields.get("官网", "")))
        company_key = _normalize_key(str(fields.get("公司名", "")))
        if cdp_key:
            index[f"cdp:{cdp_key}"] = record_id
        if website_key:
            index[f"website:{website_key}"] = record_id
        if company_key:
            index[f"company:{company_key}"] = record_id
    return index


def sync_leads_to_pool(
    company_id: str,
    company_name: str,
    records: list,
    *,
    source: str = "引擎搜索",
    chat_id: Optional[str] = None,
) -> Dict:
    """确保企业线索池存在，将最终展示的搜索结果幂等写入，并返回链接。

    幂等键优先级：公司CDPID > normalized_domain；公司名仅辅助，不单独覆盖。
    created > 0 但解析不到 record_id 时，先按稳定唯一键只读回查恢复；
    仍无法恢复则抛 BitableResponseParseError（不重新创建）。
    """
    pool = ensure_company_lead_pool(company_id, company_name, chat_id=chat_id)
    app_token = pool["app_token"]
    table_id = pool["table_id"]

    # 单次读表：建匹配索引 + 保留现有字段（用于 diff）
    index = {}
    existing_fields_by_id = {}
    for row in _fetch_records(app_token, table_id):
        record_id = row.get("record_id")
        fields = row.get("fields") or {}
        if not record_id:
            continue
        existing_fields_by_id[record_id] = fields
        cdp_key = _normalize_key(str(fields.get("公司CDPID", "")))
        website_key = _normalize_key(str(fields.get("官网", "")))
        company_key = _normalize_key(str(fields.get("公司名", "")))
        if cdp_key:
            index[f"cdp:{cdp_key}"] = record_id
        if website_key:
            index[f"website:{website_key}"] = record_id
        if company_key:
            index[f"company:{company_key}"] = record_id

    creates = []
    updates = []   # (record_id, 仅变化字段) — 最小字段更新
    skipped = 0
    unique_keys = []
    for record in records or []:
        fields = _record_fields(record, source)
        cdp_key = _normalize_key(fields.get("公司CDPID", ""))
        website_key = _normalize_key(fields.get("官网", ""))
        company_key = _normalize_key(fields.get("公司名", ""))
        unique_keys.append({
            "cdp": cdp_key, "website": website_key, "company": company_key,
        })
        if not cdp_key and not website_key and not company_key:
            skipped += 1
            continue
        # 仅用 cdp / domain 判断是否 upsert；公司名不作为覆盖依据
        record_id = (index.get(f"cdp:{cdp_key}")
                     or index.get(f"website:{website_key}"))
        if record_id:
            diff = _search_field_diff(existing_fields_by_id.get(record_id, {}), fields)
            if diff:
                updates.append((record_id, diff))
            else:
                skipped += 1   # 值无变化 → 不做无意义 update
        else:
            fields.setdefault("冷热", "❄️冷")
            fields.setdefault("阶段", "待触达")
            creates.append(fields)

    created_ids: list = []
    if creates:
        result = _run_lark(
            "base", "+record-batch-create",
            "--base-token", app_token,
            "--table-id", table_id,
            "--json", json.dumps({"create_records": creates}, ensure_ascii=False),
            "--as", "bot",
            timeout=60,
        )
        created_ids = parse_created_record_ids(result)

        # created > 0 但无 record_id：先按稳定唯一键只读回查恢复
        if len(created_ids) != len(creates):
            recovered = _recover_created_record_ids(app_token, table_id, creates)
            if recovered:
                created_ids = recovered

        if len(created_ids) != len(creates):
            raise BitableResponseParseError(
                f"batch-create 创建 {len(creates)} 条但仅解析到 {len(created_ids)} 个 record_id，"
                f"且回查失败。响应摘要: {_sanitize_response(result)}")

    for record_id, fields in updates:
        _run_lark(
            "base", "+record-upsert",
            "--base-token", app_token,
            "--table-id", table_id,
            "--record-id", record_id,
            "--json", json.dumps(fields, ensure_ascii=False),
            "--as", "bot",
        )

    return {
        "created": len(creates),
        "updated": len(updates),
        "skipped": skipped,
        "record_ids": [x for x in created_ids if x],
        "updated_record_ids": [rid for rid, _ in updates],
        "unique_keys": unique_keys,
        "response_schema_version": "lark-cli-1.0.85-columnar",
        "app_token": app_token,
        "table_id": table_id,
        "bitable_url": pool["bitable_url"],
    }


def _recover_created_record_ids(app_token: str, table_id: str, creates: list) -> list:
    """按稳定唯一键（cdp > domain）只读回查刚创建的记录，恢复 record_id。

    不重新创建；只读重读索引。返回与 creates 等长且可对齐的 record_id 列表，
    无法对齐时返回 []。
    """
    try:
        index = _existing_record_index(app_token, table_id)
    except BitableResponseParseError:
        return []
    recovered = []
    for fields in creates:
        cdp_key = _normalize_key(str(fields.get("公司CDPID", "")))
        website_key = _normalize_key(str(fields.get("官网", "")))
        rid = index.get(f"cdp:{cdp_key}") or index.get(f"website:{website_key}")
        if rid:
            recovered.append(rid)
    return recovered if len(recovered) == len(creates) else []


def sync_contacts_to_pool(
    company_id: str,
    company_name: str,
    contact_updates: list,
    *,
    source: str = "CDP联系人",
) -> Dict:
    """把补全到的联系人字段更新到对应 Bitable lead 记录（按 cdp/domain 匹配，幂等）。

    contact_updates: [{
        "companyCdpId": str,   # 优先匹配键
        "website": str,        # 兜底匹配键（normalized_domain）
        "contact_text": str,   # 写入「联系人」字段的文本
    }]

    匹配不到 record_id 或 contact_text 为空时跳过。
    返回 {"updated": n, "matched": n, "app_token": ..., "table_id": ...}
    """
    pool = ensure_company_lead_pool(company_id, company_name)
    app_token = pool["app_token"]
    table_id = pool["table_id"]
    existing = _existing_record_index(app_token, table_id)

    updated = 0
    matched = 0
    for u in contact_updates or []:
        cdp_key = _normalize_key(str(u.get("companyCdpId", "") or u.get("company_cdp_id", "")))
        website_key = _normalize_key(str(u.get("website", "") or u.get("domain", "")))
        contact_text = str(u.get("contact_text", "") or "").strip()
        record_id = existing.get(f"cdp:{cdp_key}") or existing.get(f"website:{website_key}")
        if not record_id or not contact_text:
            continue
        matched += 1
        try:
            _run_lark(
                "base", "+record-upsert",
                "--base-token", app_token,
                "--table-id", table_id,
                "--record-id", record_id,
                "--json", json.dumps({"联系人": contact_text[:1000]}, ensure_ascii=False),
                "--as", "bot",
            )
            updated += 1
        except Exception:
            continue
    return {"updated": updated, "matched": matched, "app_token": app_token, "table_id": table_id}


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
