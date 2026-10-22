#!/usr/bin/env python3
"""上手引导走到哪一步了：onboarding/GUIDE.md 的进度，跨轮次保存。step=done 就是引导结束。

引导是 agent 主导的：每一轮先读这里知道自己停在哪，做完这一步再写回去，
回复的最后一句永远是下一步。主人隔了几天才回话，也能从原地接上。

用法（工作区根目录）：
  onboard-progress.py get
  onboard-progress.py set --step feishu_auth
  onboard-progress.py set --step choose --chosen 1,3
  onboard-progress.py set --done feishu --step website
  onboard-progress.py set --skipped website --step ai_memory
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

STEPS = ("start", "choose", "feishu", "feishu_scopes", "feishu_auth", "feishu_pick", "feishu_pull",
         "website", "ai_memory", "paste", "wrap_up", "naming", "done")


def workspace() -> Path:
    here = Path(__file__).resolve().parent
    for p in (here, *here.parents):
        if (p / "AGENTS.md").exists():
            return p
    return Path.cwd()


FILE = workspace() / "onboarding" / "progress.json"


def load() -> dict:
    if FILE.exists():
        return json.loads(FILE.read_text(encoding="utf-8"))
    return {"step": "start", "chosen": [], "done": [], "skipped": [], "updated_at": None}


def save(state: dict) -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, FILE)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("get")
    s = sub.add_parser("set")
    s.add_argument("--step", choices=STEPS)
    s.add_argument("--chosen", help="主人选的来源编号，逗号分隔，例如 1,3")
    s.add_argument("--done", help="刚做完的来源：feishu / website / ai_memory / paste")
    s.add_argument("--skipped", help="主人跳过的来源")
    a = ap.parse_args()
    state = load()
    if a.cmd == "set":
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
