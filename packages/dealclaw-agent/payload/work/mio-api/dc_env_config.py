#!/usr/bin/env python3
"""
DC-Env-Config — 手动配置租户环境变量（work/mio-api/.env）

当租户的 supplier id / 数字人 open id 与镜像默认值不同（或未配置）时，
用本工具安全地读写 work/mio-api/.env 的单个键：只改目标键，保留注释/顺序/其他行，
绝不整文件重写。

用法:
  python3 dc_env_config.py list                      # 列出所有键的配置状态（值遮蔽）
  python3 dc_env_config.py get MIO_CDP_SUPPLIER_ID   # 查看单个键的值
  python3 dc_env_config.py set MIO_CDP_SUPPLIER_ID 123456789012
  python3 dc_env_config.py set MIO_V_OPEN_ID ou_xxx

租户可变键（本工具重点）:
  MIO_CDP_SUPPLIER_ID   纯数字，X-Supplier-Id（tradechina 供应商 id）
  MIO_V_OPEN_ID         ou_ 开头，数字人 V 的 Feishu Open-Id
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

ENV_FILE = Path(os.environ.get("DC_ENV_FILE", str(Path(__file__).resolve().parent / ".env")))

# 租户可变键的格式校验
VALIDATORS = {
    "MIO_CDP_SUPPLIER_ID": (lambda v: v.isdigit(), "需为纯数字（X-Supplier-Id）"),
    "MIO_V_OPEN_ID": (lambda v: v.startswith("ou_"), "需以 ou_ 开头（Feishu Open-Id）"),
}


def _load() -> dict:
    try:
        text = ENV_FILE.read_text(encoding="utf-8")
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


def _rewrite(key: str, value: str) -> tuple[str, str]:
    """改单个键，保留注释/顺序/其他行；返回 (before, after)。原子写。"""
    try:
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    before = ""
    out: list[str] = []
    found = False
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k = s.split("=", 1)[0].strip()
            if k == key:
                before = s.split("=", 1)[1].strip() if "=" in s else ""
                out.append(f"{key}={value}")
                found = True
                continue
        out.append(line)
    if not found:
        out.append(f"{key}={value}")
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = ENV_FILE.with_suffix(".env.tmp")
    tmp.write_text("\n".join(out) + "\n", encoding="utf-8")
    os.replace(tmp, ENV_FILE)
    return before, value


def cmd_list(_args) -> int:
    data = _load()
    if not data:
        print("（.env 不存在或为空）")
        return 1
    for k in sorted(data):
        print(f"{k} = {'已配置' if data[k] else '（未配置）'}")
    return 0


def cmd_get(args) -> int:
    key = args.key.strip()
    v = _load().get(key, "")
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
    before, _after = _rewrite(key, value)
    print(f"{key}: {before or '（未配置）'} → {value}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        description="手动配置 DealClaw 租户环境变量（work/mio-api/.env）"
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="列出所有键的配置状态（值遮蔽）")
    g = sub.add_parser("get", help="查看单个键")
    g.add_argument("key")
    s = sub.add_parser("set", help="设置单个键（保留其他键）")
    s.add_argument("key")
    s.add_argument("value")
    args = p.parse_args()
    return {"list": cmd_list, "get": cmd_get, "set": cmd_set}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
