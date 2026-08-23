#!/usr/bin/env python3
"""
DC-Push-Target — 推送目标配置工具（单租户单接收方）

配置 dealclaw 镜像的「主接收方」：一个主群 chat_id(oc_) 或主用户 open_id(ou_)。
写入 notify_routes.json 的 "default" 键，dispatch 时由 dc_notify.resolve_target 读取。
company_id 不作路由主键（初始化时不知道），"default" 即主接收方。

用法：
  python3 dc_push_target.py get                 # 查看当前主接收方
  python3 dc_push_target.py set oc_xxx          # 设置主群 chat_id
  python3 dc_push_target.py set ou_xxx          # 设置主用户 open_id
  python3 dc_push_target.py test                # 向当前主接收方发一条测试消息
  python3 dc_push_target.py unset               # 清除配置
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# 与 dc_notify.RouteMap 同路径：data/notifications/routes.json
DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent / "data")))
ROUTES_FILE = DATA_DIR / "notifications" / "routes.json"
DEFAULT_KEY = "default"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict:
    try:
        return json.loads(ROUTES_FILE.read_text(encoding="utf-8") or "{}")
    except (json.JSONDecodeError, OSError):
        return {}


def _save(data: dict) -> None:
    ROUTES_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = ROUTES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, ROUTES_FILE)


def _current() -> str:
    r = _load().get(DEFAULT_KEY) or {}
    return (r.get("chat_id") or r.get("target_id") or "").strip()


def _valid(target: str) -> bool:
    return bool(target) and (target.startswith("oc_") or target.startswith("ou_"))


def cmd_get(args) -> int:
    target = _current()
    if not target:
        print(json.dumps({"status": "unset", "target": ""}, ensure_ascii=False))
        return 1
    print(json.dumps({
        "status": "set",
        "target": target,
        "type": "chat_id" if target.startswith("oc_") else "open_id",
    }, ensure_ascii=False))
    return 0


def cmd_set(args) -> int:
    target = (args.target or "").strip()
    if not _valid(target):
        print(json.dumps({"status": "error",
                          "error": "target 非法：需 oc_（群）或 ou_（用户 open_id）开头",
                          "target": target}, ensure_ascii=False))
        return 2
    existing = _current()
    if existing and existing != target and not args.force:
        print(json.dumps({
            "status": "needs_confirm",
            "current": existing,
            "new": target,
            "hint": "已存在主接收方，覆盖需加 --force",
        }, ensure_ascii=False))
        return 4
    data = _load()
    data[DEFAULT_KEY] = {
        "chat_id": target,
        "target_type": "chat_id" if target.startswith("oc_") else "open_id",
        "label": "主接收方",
        "source": "manual_route",
        "updated_at": _now(),
    }
    _save(data)
    print(json.dumps({
        "status": "set",
        "target": target,
        "type": "chat_id" if target.startswith("oc_") else "open_id",
    }, ensure_ascii=False))
    return 0


def cmd_test(args) -> int:
    target = _current()
    if not target:
        print(json.dumps({"status": "error", "error": "未配置主接收方，先 set"},
                         ensure_ascii=False))
        return 2
    msg = args.message or "DealClaw 推送测试：配置成功，后续早晚报/买家提醒将发送到这里。"
    cmd = ["openclaw", "message", "send",
           "--channel", "feishu",
           "--target", target, "--message", msg, "--json"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        print(json.dumps({"status": "error", "error": (p.stderr or p.stdout or "send failed")[-200:]},
                         ensure_ascii=False))
        return 3
    print(json.dumps({"status": "sent", "target": target, "raw": (p.stdout or "").strip()[:200]},
                     ensure_ascii=False))
    return 0


def cmd_unset(args) -> int:
    data = _load()
    data.pop(DEFAULT_KEY, None)
    _save(data)
    print(json.dumps({"status": "unset"}, ensure_ascii=False))
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="DealClaw 推送目标配置")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("get", help="查看当前主接收方")
    s = sub.add_parser("set", help="设置主接收方（oc_ 群 / ou_ 用户）")
    s.add_argument("target", help="chat_id(oc_) 或 open_id(ou_)")
    s.add_argument("--force", action="store_true", help="覆盖已有主接收方（无需确认）")
    t = sub.add_parser("test", help="发测试消息到当前主接收方")
    t.add_argument("--message", default="", help="自定义测试消息")
    sub.add_parser("unset", help="清除配置")
    args = p.parse_args()
    return {"get": cmd_get, "set": cmd_set, "test": cmd_test, "unset": cmd_unset}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
