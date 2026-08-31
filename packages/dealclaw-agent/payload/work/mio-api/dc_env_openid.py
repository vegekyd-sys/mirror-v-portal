#!/usr/bin/env python3
"""
DC-Env-Openid — 一键固化租户环境变量中的 MIO_V_OPEN_ID（数字人 bot 自己的 Feishu Open-Id）

背景：
 MIO_V_OPEN_ID = 当前飞书应用（数字人 bot）自己的 open_id。不同租户值不同，
 需要每租户跑一次。本脚本自动探测该值并写入 work/mio-api/.env。

原理（权威路径，无需进群，已实测）：
 1. 用 app_id + app_secret 换 tenant_access_token
    POST /open-apis/auth/v3/tenant_access_token/internal
 2. GET /open-apis/bot/v3/info（Bearer tenant token）→ 返回 bot.open_id
 ⚠️ 注意：lark-cli 的 `api GET /open-apis/bot/v3/info` 会把真实响应里的 `bot` 字段
 吞掉（它只映射 `data` 字段，而 bot/v3/info 返回的是 `bot` 字段，所以 data 为空），
 所以本脚本直接走 HTTP，不依赖 lark-cli，也不依赖 bot 是否进群。

部署位置：必须与 dc_env_config.py 同目录（work/mio-api/），ENV_CONFIG 路径才成立。

用法：
 python3 dc_env_openid.py                 # app_id 优先取 DEALCLAW_FEISHU_APP_ID，兜底 lark-cli whoami
 python3 dc_env_openid.py --app-id cli_xxx --app-secret xxx
 python3 dc_env_openid.py --dry-run       # 只探测不写入

环境变量：
 DEALCLAW_APP_SECRET    — 飞书应用 app_secret（镜像启动时注入，本地开发环境无）
 DEALCLAW_FEISHU_APP_ID — 飞书应用 app_id（可选，缺省走 lark-cli whoami）
 DC_ENV_FILE            — 可选，覆盖 .env 路径（透传给 dc_env_config.py）
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV_CONFIG = HERE / "dc_env_config.py"

FEISHU_BASE = os.environ.get("FEISHU_BASE", "https://open.feishu.cn")


def sh(*args: str) -> str:
    r = subprocess.run(list(args), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"命令失败: {' '.join(args)}\n{r.stderr.strip()}")
    return r.stdout.strip()


def http_json(url: str, method: str = "GET", payload: dict | None = None,
              bearer: str | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def tenant_token(app_id: str, app_secret: str) -> str:
    if not app_id or not app_secret:
        raise RuntimeError("缺少 app_id / app_secret（app_secret 取 DEALCLAW_APP_SECRET 环境变量）")
    r = http_json(f"{FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal",
                  "POST", {"app_id": app_id, "app_secret": app_secret})
    token = r.get("tenant_access_token", "")
    if not token:
        raise RuntimeError(f"换取 tenant_access_token 失败: {r}")
    return token


def bot_open_id(token: str) -> str:
    r = http_json(f"{FEISHU_BASE}/open-apis/bot/v3/info", bearer=token)
    bot = r.get("bot") or {}
    oid = bot.get("open_id", "")
    if not oid:
        raise RuntimeError(f"bot/v3/info 未返回 open_id: {r}")
    return oid


def current_app_id() -> str:
    env_id = os.environ.get("DEALCLAW_FEISHU_APP_ID", "").strip()
    if env_id:
        return env_id
    try:
        return json.loads(sh("lark-cli", "whoami")).get("appId", "")
    except Exception:
        return ""


def write_open_id(open_id: str) -> str:
    return sh(sys.executable, str(ENV_CONFIG), "set", "MIO_V_OPEN_ID", open_id)


def main() -> int:
    p = argparse.ArgumentParser(description="一键固化 MIO_V_OPEN_ID（bot 自身 open_id，无需进群）")
    p.add_argument("--app-id", default="", help="飞书应用 app_id（缺省优先取 DEALCLAW_FEISHU_APP_ID，兜底 lark-cli whoami）")
    p.add_argument("--app-secret", default=os.environ.get("DEALCLAW_APP_SECRET", ""),
                   help="飞书应用 app_secret（缺省取 DEALCLAW_APP_SECRET）")
    p.add_argument("--dry-run", action="store_true", help="只探测不写入")
    args = p.parse_args()

    try:
        app_id = args.app_id or current_app_id()
        token = tenant_token(app_id, args.app_secret)
        open_id = bot_open_id(token)
    except Exception as e:
        print(f"[fail] {e}", file=sys.stderr)
        return 1

    print(f"app_id = {app_id}")
    print(f"open_id = {open_id}")
    if args.dry_run:
        print("[dry-run] 未写入")
        return 0
    print(write_open_id(open_id))
    verify = sh(sys.executable, str(ENV_CONFIG), "get", "MIO_V_OPEN_ID")
    ok = verify.strip() == open_id
    print(f"[verify] {'OK' if ok else 'MISMATCH'}: {verify}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
