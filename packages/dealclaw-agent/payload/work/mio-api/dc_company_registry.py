#!/usr/bin/env python3
"""
DC-Company-Registry — 企业资源注册表（线索池绑定）

每个企业一个线索池飞书 Bitable。所有线索写入前必须先调 ensure_company_lead_pool()。

用法:
  python3 dc_company_registry.py ensure solarunis.com "Solarunis"
  python3 dc_company_registry.py show solarunis.com
  python3 dc_company_registry.py list
"""

import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict

DATA_DIR = Path(__file__).resolve().parent / "data"
REGISTRY_FILE = DATA_DIR / "company_registry.json"

# ── 线索池 v4 字段定义 ──
LEAD_POOL_FIELDS = [
    {"field_name": "公司名", "type": 1},
    {"field_name": "官网", "type": 15},
    {"field_name": "国家", "type": 1},
    {"field_name": "买家类型", "type": 3, "options": [
        {"name": "品牌商", "color": 1},
        {"name": "制造商", "color": 2},
        {"name": "经销商", "color": 3},
        {"name": "工程商", "color": 4},
    ]},
    {"field_name": "匹配产品", "type": 4},
    {"field_name": "推荐理由", "type": 1},
    {"field_name": "联系人", "type": 1},
    {"field_name": "来源", "type": 3, "options": [
        {"name": "引擎搜索", "color": 1},
        {"name": "星擎线索", "color": 2},
        {"name": "猎采线索", "color": 3},
        {"name": "米奥数据库", "color": 4},
        {"name": "Apollo数据库", "color": 5},
        {"name": "展会线索", "color": 6},
        {"name": "用户导入", "color": 7},
    ]},
    {"field_name": "冷热", "type": 3, "options": [
        {"name": "🔥热", "color": 1},
        {"name": "❄️冷", "color": 2},
    ]},
    {"field_name": "阶段", "type": 3, "options": [
        {"name": "待触达", "color": 1},
        {"name": "已触达", "color": 2},
        {"name": "已回复", "color": 3},
        {"name": "报价中", "color": 4},
        {"name": "成交", "color": 5},
        {"name": "停止触达", "color": 6},
    ]},
]


def _now():
    return datetime.now(timezone.utc).isoformat()


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
        """查找已绑定的线索池"""
        return self._entries.get(company_id)

    def set(self, company_id: str, info: Dict):
        """保存绑定信息"""
        self._entries[company_id] = info
        self._save()

    def list_all(self):
        return dict(self._entries)

    def remove(self, company_id: str):
        """删除绑定（慎用）"""
        if company_id in self._entries:
            del self._entries[company_id]
            self._save()
            return True
        return False


# ── API 调用 ──

def _get_token():
    """获取飞书 Bot Token"""
    token = os.environ.get("FEISHU_BOT_TOKEN", "")
    if not token:
        raise RuntimeError("FEISHU_BOT_TOKEN 未设置")
    return token


def _api(method: str, path: str, data: Optional[Dict] = None) -> Dict:
    """调用飞书 API"""
    import requests

    token = _get_token()
    url = f"https://open.feishu.cn/open-apis{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    if method == "GET":
        resp = requests.get(url, headers=headers, timeout=15)
    elif method == "POST":
        resp = requests.post(url, headers=headers, json=data, timeout=30)
    elif method == "PATCH":
        resp = requests.patch(url, headers=headers, json=data, timeout=30)
    else:
        raise ValueError(f"Unsupported method: {method}")

    body = resp.json()
    if body.get("code") != 0:
        raise RuntimeError(
            f"飞书 API 错误 [{method} {path}]: code={body.get('code')} msg={body.get('msg')}"
        )
    return body


def _create_bitable(name: str) -> Dict:
    """创建飞书多维表格，返回 {app_token, name, url}"""
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"无效的 bitable 名称: {name!r}")
    safe_name = name.strip()[:100]
    result = _api("POST", "/bitable/v1/apps", {"name": f"{safe_name}线索池"})
    app = result["data"]["app"]
    return {
        "app_token": app["app_token"],
        "name": app["name"],
        "url": app.get("url", ""),
    }


def _get_tables(app_token: str) -> list:
    """获取 bitable 的所有表"""
    result = _api("GET", f"/bitable/v1/apps/{app_token}/tables")
    return result["data"].get("items", [])


def _get_first_table_id(app_token: str) -> str:
    """获取第一个（默认）表的 table_id"""
    tables = _get_tables(app_token)
    if not tables:
        raise RuntimeError(f"Bitable {app_token} 下没有表")
    # 默认表通常第一个，重命名为「线索池」
    tbl = tables[0]
    return tbl["table_id"]


def _rename_table(app_token: str, table_id: str, new_name: str = "线索池"):
    """重命名表"""
    _api("PATCH", f"/bitable/v1/apps/{app_token}/tables/{table_id}", {
        "name": new_name,
    })


def _add_field(app_token: str, table_id: str, field_def: dict):
    """添加一个字段到表中，返回 field_id"""
    body = {
        "field_name": field_def["field_name"],
        "type": field_def["type"],
    }
    # select / multiSelect 需要 property_options
    if field_def["type"] in (3, 4):
        if "options" in field_def:
            body["property"] = {"options": field_def["options"]}
    try:
        result = _api("POST", f"/bitable/v1/apps/{app_token}/tables/{table_id}/fields", body)
        return result["data"]["field"]["field_id"]
    except RuntimeError as e:
        # 如果字段已存在则跳过（幂等）
        if "already exists" in str(e) or "duplicate" in str(e).lower():
            return None
        raise


def _get_field_map(app_token: str, table_id: str) -> Dict[str, str]:
    """获取字段名 → field_id 映射"""
    result = _api("GET", f"/bitable/v1/apps/{app_token}/tables/{table_id}/fields")
    items = result["data"].get("items", [])
    field_map = {}
    for f in items:
        field_map[f["field_name"]] = f["field_id"]
    return field_map


# ── 核心 API ──

def ensure_company_lead_pool(company_id: str, company_name: str) -> Dict:
    """
    确保企业线索池存在。

    返回:
      {
        "app_token": "xxx",
        "table_id": "tblxxx",
        "field_map": {"公司名": "fldxxx", "官网": "fldxxx", ...},
        "created": bool,   # 是否本次新建
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
        # 验证 field_map 是否完整
        fm = existing.get("field_map", {})
        expected_fields = {f["field_name"] for f in LEAD_POOL_FIELDS}
        actual_fields = set(fm.keys())
        if expected_fields.issubset(actual_fields):
            return {
                "app_token": existing["app_token"],
                "table_id": existing["table_id"],
                "field_map": existing["field_map"],
                "created": False,
            }
        # field_map 不完整 → 刷新
        try:
            fresh_map = _get_field_map(existing["app_token"], existing["table_id"])
            existing["field_map"] = fresh_map
            registry.set(company_id, existing)
            return {
                "app_token": existing["app_token"],
                "table_id": existing["table_id"],
                "field_map": fresh_map,
                "created": False,
            }
        except RuntimeError:
            # Bitable 可能被删了，往下走新建逻辑
            pass

    # 2. 创建新线索池
    bitable = _create_bitable(company_name)
    app_token = bitable["app_token"]
    table_id = _get_first_table_id(app_token)

    # 重命名默认表
    try:
        _rename_table(app_token, table_id, "线索池")
    except RuntimeError:
        pass  # 重命名失败不阻塞

    # 3. 添加字段
    field_map = {}
    for field_def in LEAD_POOL_FIELDS:
        fid = _add_field(app_token, table_id, field_def)
        if fid:
            field_map[field_def["field_name"]] = fid

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

    return {
        "app_token": app_token,
        "table_id": table_id,
        "field_map": field_map,
        "created": True,
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


# ── CLI ──

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法:")
        print("  python3 dc_company_registry.py ensure <company_id> <company_name>")
        print("  python3 dc_company_registry.py show <company_id>")
        print("  python3 dc_company_registry.py list")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "ensure":
        if len(sys.argv) < 4:
            print("用法: ensure <company_id> <company_name>")
            sys.exit(1)
        company_id = sys.argv[2]
        company_name = sys.argv[3]
        try:
            result = ensure_company_lead_pool(company_id, company_name)
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
