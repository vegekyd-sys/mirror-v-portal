#!/usr/bin/env python3
"""上手引导走到哪一步了：onboarding/GUIDE.md 的进度，跨轮次保存。step=done 就是引导结束。

引导是 agent 主导的：每一轮先读这里知道自己停在哪，做完这一步再写回去，
回复的最后一句永远是下一步。主人隔了几天才回话，也能从原地接上。

进度不全靠 agent 记得写：`get` 会先对照实际状态校正一次（2026-10-23 的租户
把 87 份飞书文档都读进来了，进度却一直停在「选来源」，因为那一轮没写回）。
  · 引导的收尾提交（提交说明以 "onboarding:" 开头）已经有了 → done
  · 初稿已经写好（onboarding/draft.md）→ 至少到 draft
  · 已经读进来飞书文档 → 至少到 reading

用法（工作区根目录）：
  onboard-progress.py get
  onboard-progress.py set --step feishu_auth
  onboard-progress.py set --done feishu --step draft
  onboard-progress.py set --skipped website --step ai_memory
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

STEPS = ("start", "feishu_auth", "feishu_grant", "reading", "draft", "more",
         "website", "ai_memory", "paste", "naming", "done")
# 旧版引导（v15 及以前）的步骤名，读到就换成新流程里对应的那一步。
LEGACY = {"choose": "feishu_auth", "feishu": "feishu_auth", "feishu_scopes": "feishu_grant",
          "feishu_pick": "reading", "feishu_pull": "reading", "wrap_up": "naming"}
BEFORE_READING = ("start", "feishu_auth", "feishu_grant")


def workspace() -> Path:
    here = Path(__file__).resolve().parent
    for p in (here, *here.parents):
        if (p / "AGENTS.md").exists():
            return p
    return Path.cwd()


WS = workspace()
FILE = WS / "onboarding" / "progress.json"
DRAFT = WS / "onboarding" / "draft.md"
MANIFEST = WS / "memory-archive" / "imports" / "MANIFEST.json"


def load() -> dict:
    state = {"step": "start", "chosen": [], "done": [], "skipped": [], "updated_at": None}
    if FILE.exists():
        state.update(json.loads(FILE.read_text(encoding="utf-8")))
    state["step"] = LEGACY.get(state["step"], state["step"])
    return state


def save(state: dict) -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, FILE)


def feishu_docs() -> int:
    try:
        items = json.loads(MANIFEST.read_text(encoding="utf-8")).get("items", [])
    except (OSError, ValueError):
        return 0
    return sum(1 for it in items if it.get("source") == "feishu" and not it.get("duplicate_of"))


def wrapped_up() -> bool:
    p = subprocess.run(["git", "log", "-1", "--format=%h", "--grep=^onboarding:"],
                       cwd=WS, capture_output=True, text=True)
    return p.returncode == 0 and bool(p.stdout.strip())


def reconcile(state: dict) -> str | None:
    """按实际状态把进度往前校正；返回校正原因，没变就返回 None。只往前，不往回。"""
    step = state["step"]
    if step == "done":
        return None
    if wrapped_up():
        state["step"] = "done"
        return "已有 onboarding: 收尾提交"
    if step in (*BEFORE_READING, "reading") and DRAFT.exists():
        state["step"] = "draft"
        return "初稿已写好"
    if step in BEFORE_READING and feishu_docs():
        state["step"] = "reading"
        if "feishu" not in state["done"]:
            state["done"].append("feishu")
        return "飞书文档已经读进来了"
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("get")
    s = sub.add_parser("set")
    s.add_argument("--step", choices=STEPS)
    s.add_argument("--chosen", help="主人选的补充来源编号，逗号分隔，例如 1,3")
    s.add_argument("--done", help="刚做完的来源：feishu / website / ai_memory / paste")
    s.add_argument("--skipped", help="主人跳过的来源")
    a = ap.parse_args()
    state = load()
    if a.cmd == "get":
        why = reconcile(state)
        if why:
            state["reconciled"] = why
            save(state)
    else:
        if a.step:
            state["step"] = a.step
        if a.chosen is not None:
            state["chosen"] = [x.strip() for x in a.chosen.replace("，", ",").replace(" ", ",").split(",") if x.strip()]
        for key, value in (("done", a.done), ("skipped", a.skipped)):
            if value and value not in state[key]:
                state[key].append(value)
        save(state)
    print(json.dumps(state, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
