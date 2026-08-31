#!/usr/bin/env python3
"""
DC-Env-Config — 手动配置租户可变键（data/memory/tenant-env.json）

租户可变键（MIO_V_OPEN_ID / MIO_CDP_SUPPLIER_ID）改写到 data/memory/tenant-env.json
（工作区根下、可写、跨重启保留）。全局密钥（APOLLO_API_KEY / RESEND_API_KEY 等）
仍留在 work/mio-api/.env（Secret，只读）。

读取优先级：tenant-env.json > .env（Secret 兜底）。引擎侧由 _tenant_env.py 的
load_tenant_env() 在加载 .env 前生效，本工具 get/list 遵循同样优先级。

用法:
  python3 dc_env_config.py list                       # 列出所有键的状态 + 来源
  python3 dc_env_config.py get MIO_V_OPEN_ID          # 查看单个键
  python3 dc_env_config.py set MIO_V_OPEN_ID ou_xxx   # 写入 tenant-env.json
  python3 dc_env_config.py set MIO_CDP_SUPPLIER_ID 123456789012
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

try:
    from _tenant_env import tenant_env_path
except ImportError:  # 独立运行时兜底
    def tenant_env_path() -> Path:
        root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "")
        if root:
            return Path(root) / "data" / "memory" / "tenant-env.json"
        return Path(__file__).resolve().parents[2] / "data" / "memory" / "tenant-env.json"

TENANT_ENV = tenant_env_path()
DOTENV = Path(__file__).resolve().parent / ".env"

# 租户可变键的格式校验
VALIDATORS = {
    "MIO_CDP_SUPPLIER_ID": (lambda v: v.isdigit(), "需为纯数字（X-Supplier-Id）"),
    "MIO_V_OPEN_ID": (lambda v: v.startswith("ou_"), "需以 ou_ 开头（Feishu Open-Id）"),
}


def _load_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _load_dotenv() -> dict:
    try:
        text = DOTENV.read_text(encoding="utf-8")
    except OSError:
        return {}
    data: dict = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        data[k.strip()] = v.strip()
    return data


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _merged() -> tuple[dict, dict]:
    """返回 (tenant, dotenv)。tenant 优先。"""
    return _load_json(TENANT_ENV), _load_dotenv()


def cmd_list(_args) -> int:
    tenant, dotenv = _merged()
    keys = sorted(set(tenant) | set(dotenv))
    if not keys:
        print("（tenant-env.json 与 .env 均为空）")
        return 1
    for k in keys:
        if k in tenant:
            val, src = tenant[k], "tenant-env.json"
        else:
            val, src = dotenv[k], ".env(Secret)"
        shown = "已配置" if val else "（未配置）"
        print(f"{k} = {shown}  [{src}]")
    return 0


def cmd_get(args) -> int:
    tenant, dotenv = _merged()
    key = args.key.strip()
    if key in tenant:
        v = tenant[key]
    else:
        v = dotenv.get(key, "")
    if not v:
        print(f"{key} = （未配置）")
        return 1
    print(v)
    return 0


def cmd_set(args) -> int:
    key = args.key.strip()
    value = (args.value or "").strip()
    if not value:
        print("值不能为空")
        return 2
    if key in VALIDATORS:
        check, msg = VALIDATORS[key]
        if not check(value):
            print(f"非法值: {msg}")
            return 2
    tenant, _dotenv = _merged()
    before = tenant.get(key, "")
    tenant[key] = value
    _write_json(TENANT_ENV, tenant)
    print(f"{key}: {before or '（未配置）'} → {value}  [写入 {TENANT_ENV}]")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="手动配置 DealClaw 租户可变键（tenant-env.json）")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="列出所有键的配置状态与来源")
    g = sub.add_parser("get", help="查看单个键")
    g.add_argument("key")
    s = sub.add_parser("set", help="设置单个键（写入 tenant-env.json，保留其他键）")
    s.add_argument("key")
    s.add_argument("value")
    args = p.parse_args()
    return {"list": cmd_list, "get": cmd_get, "set": cmd_set}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
