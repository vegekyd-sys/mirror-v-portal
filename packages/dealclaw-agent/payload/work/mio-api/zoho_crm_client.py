#!/usr/bin/env python3
"""
Zoho CRM 只读查询客户端（适配层）
==================================
保留原有 ZohoCrmClient 的 Python API 签名，底层走 xiaoao-zcrm-v1 CLI。

这是 zoho_crm_client.py 的 drop-in 替代品：
  - 不再直连 Zoho OAuth / COQL / REST API
  - 所有查询通过 CLI: skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 --json
  - 返回格式与原版兼容：list[dict]，每条记录扁平字段

用法（与旧版完全相同）:
    from zoho_crm_client import ZohoCrmClient
    client = ZohoCrmClient()
    accounts = client.search_accounts("Account_Name like '%广州%'", fields=["Industry","Owner"])
"""

import json
import os
import re
import subprocess
import sys
import time
from typing import Optional, List, Dict, Any

# CLI 可执行文件路径
_CLI = os.path.join(
    os.path.dirname(__file__), "..", "..",
    "skills", "xiaoao-zcrm-v1-api", "bin", "xiaoao-zcrm-v1"
)

# ── COQL WHERE 子句简单解析 ──────────────────────────────

_COQL_PATTERNS = [
    # Account_Name like '%value%'
    (re.compile(r"""Account_Name\s+like\s+'%(.+?)%'\s*$""", re.I),
     lambda m: ("accounts", "search", ["--name", m.group(1)])),
    # Account_Name = 'value' / Account_Name in ('a','b')
    (re.compile(r"""Account_Name\s*=\s*'([^']+)'\s*$""", re.I),
     lambda m: ("accounts", "search", ["--name", m.group(1)])),
    (re.compile(r"""Account_Name\s+in\s*\(([^)]+)\)\s*$""", re.I),
     lambda m: _parse_in_clause("accounts", "by-names", m)),
    # id in ('1','2','3') / id in(1,2,3)
    (re.compile(r"""\bid\s+in\s*\(([^)]+)\)\s*$""", re.I),
     lambda m: _parse_in_clause("accounts", "by-ids", m)),
    # Account_Name.id = '12345'
    (re.compile(r"""Account_Name\.id\s*=\s*'([^']+)'\s*$""", re.I),
     lambda m: ("deals", "by-account", ["--account-id", m.group(1)])),
    # Owner.name = '某某'
    (re.compile(r"""Owner\.name\s*=\s*'([^']+)'\s*$""", re.I),
     lambda m: ("accounts", "search", ["--owner-name", m.group(1)])),
    # Owner = '某某'
    (re.compile(r"""\bOwner\b\s*=\s*'([^']+)'\s*$""", re.I),
     lambda m: ("accounts", "search", ["--owner-name", m.group(1)])),
    # Industry = 'xxx' / Industry like '%xxx%'
    (re.compile(r"""Industry\s+like\s+'%(.+?)%'\s*$""", re.I),
     lambda m: ("accounts", "search", ["--industry-tags", m.group(1)])),
    (re.compile(r"""Industry\s*=\s*'([^']+)'\s*$""", re.I),
     lambda m: ("accounts", "search", ["--industry-tags", m.group(1)])),
    # Stage = 'xxx' / Stage = 赢单
    (re.compile(r"""Stage\s*=\s*'?([^'\s]+)'?\s*$""", re.I),
     lambda m: ("deals", "search", ["--stage", m.group(1)])),
    # Contract_Stage = 'xxx'
    (re.compile(r"""Contract_Stage\s*=\s*'([^']+)'""", re.I),
     lambda m: ("orders", "search", ["--stage", m.group(1)])),
    # Account_Name = 'xxx' (without like)
    (re.compile(r"""Account_Name\s*=\s*'([^']+)'\s*$""", re.I),
     lambda m: ("accounts", "search", ["--name", m.group(1)])),
]


def _parse_in_clause(module: str, action: str, m) -> tuple:
    """解析 IN 子句，返回 (module, action, [args])"""
    values = re.findall(r"'([^']*)'", m.group(1))
    if not values:
        values = [v.strip() for v in m.group(1).split(",") if v.strip()]
    key = "--names" if action == "by-names" else "--ids"
    return (module, action, [key, ",".join(values)])


def _parse_criteria(criteria: str, module: str = "accounts") -> Optional[tuple]:
    """将 COQL WHERE 子句解析为 (模块, 动作, [CLI参数列表])，无法解析返回 None"""
    criteria = criteria.strip()
    for pattern, handler in _COQL_PATTERNS:
        m = pattern.search(criteria)
        if m:
            result = handler(m)
            if result[0] == module or module == "accounts":
                return result
    return None


# ── CLI 调用工具 ────────────────────────────────────────

def _run_cli(args: list, timeout: int = 120) -> dict:
    """运行 CLI 并返回解析后的 JSON"""
    cmd = [_CLI] + args + ["--json"]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"}
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"CLI 返回非零 exit code {result.returncode}：{result.stderr[:500]}"
            )
        output = result.stdout.strip()
        if not output:
            return {}
        return json.loads(output)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"CLI 超时（>{timeout}s）：{' '.join(cmd)}")
    except json.JSONDecodeError as e:
        raise RuntimeError(f"CLI 输出非 JSON：{result.stdout[:200] if 'result' in dir() else str(e)}")


def _run_cli_raw(path: str, payload: dict, timeout: int = 120) -> dict:
    """通过 raw 命令调用 CLI"""
    return _run_cli(["raw", "--path", path, "--payload", json.dumps(payload)], timeout=timeout)


# 支持 --page 分页的 (module, action) 组合
_PAGINATED = {
    ("accounts", "search"),
    ("deals", "search"), ("deals", "by-account"),
    ("orders", "search"),
    ("events", "search"),
    ("users", "all"),
}


def _paginate_all(module: str, action: str, base_args: list, limit: int = 200) -> list:
    """自动分页拉取全部结果"""
    is_paginated = (module, action) in _PAGINATED
    if not is_paginated:
        # by-names / by-ids / overview / events count / users search：一次性返回
        cmd = [_CLI, module, action] + base_args + ["--json"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120,
                                env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        if result.returncode != 0:
            raise RuntimeError(f"CLI 失败 ({module} {action}): {result.stderr[:200]}")
        try:
            data = json.loads(result.stdout.strip())
        except json.JSONDecodeError:
            return []
        return data.get("data", [])

    all_data = []
    page = 1
    max_pages = 500
    while page <= max_pages:
        args = base_args + ["--page", str(page), "--limit", str(limit)]
        cmd = [_CLI, module, action] + args + ["--json"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120,
                                env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        if result.returncode != 0:
            if page == 1:
                raise RuntimeError(f"CLI 失败 ({module} {action}): {result.stderr[:200]}")
            break
        try:
            data = json.loads(result.stdout.strip())
        except json.JSONDecodeError:
            break
        records = data.get("data", [])
        if not records:
            break
        all_data.extend(records)
        if not data.get("more_records"):
            break
        page += 1
    return all_data


# ── ZohoCrmClient ───────────────────────────────────────

class ZohoCrmClient:
    """Zoho CRM 只读客户端（CLI 适配层）

    保留所有旧方法签名，返回格式尽可能兼容。
    """

    def __init__(self):
        # 保留 base_url 属性兼容旧代码
        self.base_url = "https://zohodata.meorient.com/agent/v1"

    # ── Accounts ────────────────────────────────────────

    def get_accounts(self, fields: Optional[list] = None) -> list:
        """获取全部 Accounts（分页）"""
        return _paginate_all("accounts", "search", [])

    def search_accounts(self, criteria: str, fields: Optional[list] = None) -> list:
        """COQL 查询 Accounts → CLI"""
        parsed = _parse_criteria(criteria, "accounts")
        if parsed:
            module, action, args = parsed
            return _paginate_all(module, action, args)
        # 未识别 → 尝试 raw
        payload = {"select_query": f"select Account_Name,id,Owner,Customer_Level from Accounts where {criteria} limit 200"}
        result = _run_cli_raw("/accounts/search", payload)
        return result.get("data", [])

    def search_accounts_by_field(self, field: str, value: str, fields: Optional[list] = None) -> list:
        """按字段搜索 Accounts"""
        mapping = {
            "Account_Name": "--name",
            "Industry": "--industry-tags",
            "Customer_Level": "--customer-level",
            "Owner.name": "--owner-name",
            "Owner": "--owner-name",
        }
        cli_arg = mapping.get(field)
        if cli_arg:
            return _paginate_all("accounts", "search", [cli_arg, value])
        # fallback: construct criteria and search
        return self.search_accounts(f"{field} like '%{value}%'", fields)

    def search_accounts_batch(self, names: list, fields: Optional[list] = None) -> list:
        """批量按名称查询"""
        if not names:
            return []
        return _paginate_all("accounts", "by-names", ["--names", ",".join(names)])

    def get_accounts_by_ids(self, ids: list, fields: Optional[list] = None) -> list:
        """批量按 ID 查询"""
        if not ids:
            return []
        return _paginate_all("accounts", "by-ids", ["--ids", ",".join([str(i) for i in ids])])

    def search_accounts_by_ids(self, ids: list, fields: Optional[list] = None) -> list:
        """同 get_accounts_by_ids（兼容旧名）"""
        return self.get_accounts_by_ids(ids, fields)

    def account_search_equals(self, field: str, value: str, fields: Optional[list] = None) -> list:
        """精确搜索（等值匹配）"""
        mapping = {
            "Account_Name": "--name",
            "Owner.name": "--owner-name",
            "Owner": "--owner-name",
        }
        cli_arg = mapping.get(field)
        if cli_arg:
            result = _run_cli(["accounts", "search", cli_arg, value])
            return result.get("data", [])
        return self.search_accounts(f"{field} = '{value}'", fields)

    def get_account_by_id(self, account_id: str) -> dict:
        """获取单个 Account"""
        result = _run_cli(["accounts", "by-ids", "--ids", str(account_id)])
        data = result.get("data", [])
        return data[0] if data else {}

    # ── Deals ───────────────────────────────────────────

    def get_deals(self, fields: Optional[list] = None) -> list:
        return _paginate_all("deals", "search", [])

    def search_deals(self, criteria: str) -> list:
        return self.search_deals_full(criteria, None)

    def search_deals_full(self, criteria: str, fields: Optional[list] = None) -> list:
        """搜索 Deals"""
        parsed = _parse_criteria(criteria, "deals")
        if parsed:
            module, action, args = parsed
            return _paginate_all(module, action, args)
        # 尝试解析 account-name 模式
        m = re.search(r"Account_Name\s*=\s*'([^']+)'", criteria, re.I)
        if m:
            return _paginate_all("deals", "search", ["--account-name", m.group(1)])
        m = re.search(r"Account_Name\.id\s*=\s*'([^']+)'", criteria, re.I)
        if m:
            return _paginate_all("deals", "by-account", ["--account-id", m.group(1)])
        # 尝试 raw
        payload = {"select_query": f"select Deal_Name,id,Stage,Account_Name,Owner from Deals where {criteria} limit 200"}
        result = _run_cli_raw("/deals/search", payload)
        return result.get("data", [])

    # ── Sales_Orders ────────────────────────────────────

    def get_sales_orders(self, fields: Optional[list] = None) -> list:
        return _paginate_all("orders", "search", [])

    def search_sales_orders(self, criteria: str, fields: Optional[list] = None) -> list:
        """搜索 Sales_Orders"""
        parsed = _parse_criteria(criteria, "orders")
        if parsed:
            module, action, args = parsed
            return _paginate_all(module, action, args)
        # 解析 contract_stage / account_name
        args = []
        m = re.search(r"Contract_Stage\s*=\s*'([^']+)'", criteria, re.I)
        if m:
            args.extend(["--stage", m.group(1)])
        m = re.search(r"Account_Name\s*=\s*'([^']+)'", criteria, re.I)
        if m:
            args.extend(["--account-name", m.group(1)])
        # 日期过滤：Start_Date / Created_Time → 映射到 --from/--to
        m = re.search(r"Start_Date\s*(>=?|>)\s*'([^']+)'", criteria, re.I)
        if m:
            args.extend(["--from", m.group(2)])
        m = re.search(r"Created_Time\s*(>=?|>)\s*'([^']+)'", criteria, re.I)
        if m:
            args.extend(["--performance-from", m.group(2)])
        if args:
            return _paginate_all("orders", "search", args)
        # fallback raw
        payload = {"select_query": f"select Subject,id,Account_Name,Owner,Status,Grand_Total from Sales_Orders where {criteria} limit 200"}
        result = _run_cli_raw("/orders/search", payload)
        return result.get("data", [])

    # ── Events ───────────────────────────────────────────

    def get_events(self, fields: Optional[list] = None) -> list:
        return _paginate_all("events", "search", [])

    def search_events(self, criteria: str, fields: Optional[list] = None) -> list:
        """搜索 Events"""
        args = []
        m = re.search(r"What_Id\s*=\s*'([^']+)'", criteria, re.I)
        if m:
            args.extend(["--account-id", m.group(1)])
        m = re.search(r"Account_Name\s*=\s*'([^']+)'", criteria, re.I)
        if m:
            args.extend(["--company-name", m.group(1)])
        if args:
            return _paginate_all("events", "search", args)
        payload = {"select_query": f"select Event_Title,id,What_Id,Owner,Start_DateTime from Events where {criteria} limit 200"}
        result = _run_cli_raw("/events/search", payload)
        return result.get("data", [])

    # ── Users ────────────────────────────────────────────

    def get_users(self) -> list:
        result = _run_cli(["users", "all", "--page", "1", "--limit", "1000"])
        return result.get("data", [])

    # ── 字段元数据 ───────────────────────────────────────

    def get_module_fields(self, module: str) -> dict:
        """获取模块字段 → 新版 API 不直接支持，返回空"""
        return {"fields": [], "note": "module fields not available in Agent V1.02 API"}
