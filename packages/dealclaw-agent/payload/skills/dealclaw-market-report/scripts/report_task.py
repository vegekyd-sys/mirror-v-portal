#!/usr/bin/env python3
"""市场报告「会话内异步任务」状态存储。

用途：同一会话里跨轮推进报告生成——触发轮只回执并落任务；后续询问轮读状态、
推进一步或直接回报产物。状态落在磁盘，因此**不依赖任何子会话/定时器能力**。

用法:
  python3 report_task.py create --key <会话键> --product <产品> --market <市场> [--stages N]
  python3 report_task.py get    --key <会话键>
  python3 report_task.py advance --key <会话键> [--note <进度文案>] [--next-stage]
  python3 report_task.py complete --key <会话键> --html-url <直链> --file-id <id> --bytes N
  python3 report_task.py fail   --key <会话键> --error <原因>
  python3 report_task.py list

任务键（--key）应取会话级稳定标识（如外部集成方传入的 externalUserId）。
存储目录：$MIAO_REPORT_TASK_DIR，默认 ${OPENCLAW_WORKSPACE_DIR:-/data/workspace}/work/mio-api/report-tasks/
（**错误提示**：不要改用相对路径 —— agent 工具 CWD 可能是 /tmp）

退出码: 0 成功 / 2 参数错误 / 3 任务不存在
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

STAGES = [
    "scoping",      # 锁定国家与品类、建证据账本
    "market",       # 市场规模与经济情景
    "competition",  # 需求、竞争与渠道
    "compliance",   # 合规闸门
    "scoring",      # 选品池评分
    "entry",        # 进入方案与 90 天路线图
    "render",       # HTML 生成
    "deliver",      # 上传与交付
]


WORKSPACE = os.environ.get("OPENCLAW_WORKSPACE_DIR") or "/data/workspace"


def store_dir() -> Path:
    """任务状态目录。默认锚定 workspace 根，**不依赖进程 CWD**。

    agent 执行工具时的 CWD 可能是 /tmp 等临时目录（已实测确认），
    因此绝不能用相对路径 —— 否则状态会落到 CWD 下的同名目录，
    导致跨轮读写位置不一致（甚至落到会被清理的 /tmp 里）。
    """
    d = os.environ.get("MIAO_REPORT_TASK_DIR") or os.path.join(
        WORKSPACE, "work/mio-api/report-tasks"
    )
    p = Path(d)
    p.mkdir(parents=True, exist_ok=True)
    print(f"[report_task] store={p}", file=sys.stderr)
    return p


def safe_slug(key: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]", "-", key).strip("-")
    return (slug or "task")[:80]


def path_for(key: str) -> Path:
    return store_dir() / f"{safe_slug(key)}.json"


def load(key: str):
    p = path_for(key)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def save(rec: dict) -> None:
    p = path_for(rec["key"])
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def emit(rec: dict) -> None:
    print(json.dumps(rec, ensure_ascii=False))


def cmd_create(a) -> int:
    rec = {
        "key": a.key,
        "taskId": f"mr-{int(time.time())}-{safe_slug(a.key)[:12]}",
        "product": a.product,
        "market": a.market,
        "status": "accepted",
        "stage": 0,
        "totalStages": a.stages,
        "stageName": STAGES[0],
        "progressNote": "已受理，排队生成中",
        "artifact": None,
        "error": None,
        "createdAt": int(time.time() * 1000),
        "updatedAt": int(time.time() * 1000),
    }
    save(rec)
    emit(rec)
    return 0


def cmd_get(a) -> int:
    rec = load(a.key)
    if not rec:
        emit({"status": "not_found", "key": a.key})
        return 3
    emit(rec)
    return 0


def cmd_advance(a) -> int:
    rec = load(a.key)
    if not rec:
        emit({"status": "not_found", "key": a.key})
        return 3
    if a.next_stage:
        rec["stage"] = min(rec["stage"] + 1, rec["totalStages"])
    rec["stageName"] = STAGES[min(rec["stage"], len(STAGES) - 1)]
    if rec["status"] == "accepted":
        rec["status"] = "running"
    if a.note:
        rec["progressNote"] = a.note
    if rec["stage"] >= rec["totalStages"]:
        rec["progressNote"] = rec["progressNote"] or "报告生成中，进入产物上传阶段"
    rec["updatedAt"] = int(time.time() * 1000)
    save(rec)
    emit(rec)
    return 0


def cmd_complete(a) -> int:
    rec = load(a.key)
    if not rec:
        emit({"status": "not_found", "key": a.key})
        return 3
    rec["status"] = "completed"
    rec["stage"] = rec["totalStages"]
    rec["stageName"] = "deliver"
    rec["progressNote"] = "报告已完成"
    rec["artifact"] = {"html_url": a.html_url, "file_id": a.file_id, "bytes": a.bytes}
    rec["updatedAt"] = int(time.time() * 1000)
    save(rec)
    emit(rec)
    return 0


def cmd_fail(a) -> int:
    rec = load(a.key)
    if not rec:
        emit({"status": "not_found", "key": a.key})
        return 3
    rec["status"] = "failed"
    rec["error"] = a.error
    rec["progressNote"] = "报告生成失败"
    rec["updatedAt"] = int(time.time() * 1000)
    save(rec)
    emit(rec)
    return 0


def cmd_list(_a) -> int:
    out = []
    for p in sorted(store_dir().glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            continue
    print(json.dumps(out, ensure_ascii=False))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("create"); p.add_argument("--key", required=True)
    p.add_argument("--product", required=True); p.add_argument("--market", required=True)
    p.add_argument("--stages", type=int, default=len(STAGES)); p.set_defaults(fn=cmd_create)

    p = sub.add_parser("get"); p.add_argument("--key", required=True); p.set_defaults(fn=cmd_get)

    p = sub.add_parser("advance"); p.add_argument("--key", required=True)
    p.add_argument("--note"); p.add_argument("--next-stage", action="store_true")
    p.set_defaults(fn=cmd_advance)

    p = sub.add_parser("complete"); p.add_argument("--key", required=True)
    p.add_argument("--html-url", required=True); p.add_argument("--file-id", required=True)
    p.add_argument("--bytes", type=int, required=True); p.set_defaults(fn=cmd_complete)

    p = sub.add_parser("fail"); p.add_argument("--key", required=True)
    p.add_argument("--error", required=True); p.set_defaults(fn=cmd_fail)

    p = sub.add_parser("list"); p.set_defaults(fn=cmd_list)

    a = ap.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
