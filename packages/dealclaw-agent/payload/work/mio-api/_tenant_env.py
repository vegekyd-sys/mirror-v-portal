#!/usr/bin/env python3
"""tenant-env.json 加载：租户可写配置，优先级高于只读 .env（Secret 挂载）。

背景：
  租户机器上 work/mio-api/.env 是 symlink 指向 K8s skill-env Secret（只读），
  无法动态写入。MIO_V_OPEN_ID 等租户相关键改写到 data/memory/tenant-env.json
  （工作区根下，entrypoint rsync 排除 /data/，跨重启保留、可写）。

机制：
  各引擎 / skill 脚本在加载 .env 之前调用 load_tenant_env()，把 tenant-env.json
  的键值塞进 os.environ（覆盖）。后续 .env 加载因「if k not in os.environ」不会
  覆盖 → tenant-env.json 优先、.env（Secret）兜底，旧读取方式完全兼容。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

_REL = Path("data") / "memory" / "tenant-env.json"


def workspace_root() -> Path:
    """定位工作区根：优先 OPENCLAW_WORKSPACE_DIR，否则从本文件向上回溯。"""
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    # 本文件在 <root>/work/mio-api/_tenant_env.py → parents[2] = <root>
    return Path(__file__).resolve().parents[2]


def tenant_env_path() -> Path:
    return workspace_root() / _REL


def load_tenant_env() -> None:
    """读 data/memory/tenant-env.json 塞进 os.environ（覆盖，最高优先级）。

    失败静默：文件不存在 / JSON 解析失败 / 非 dict 都不抛错，不阻塞引擎。
    """
    p = tenant_env_path()
    if not p.exists():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(data, dict):
        return
    for k, v in data.items():
        if isinstance(v, str):
            os.environ[k] = v
        elif v is not None:
            os.environ[k] = str(v)


if __name__ == "__main__":
    load_tenant_env()
    print(f"[_tenant_env] path={tenant_env_path()} exists={tenant_env_path().exists()}")
    for k in ("MIO_V_OPEN_ID", "MIO_CDP_SUPPLIER_ID"):
        print(f"[_tenant_env] {k} = {os.environ.get(k, '(未设置)')}")
