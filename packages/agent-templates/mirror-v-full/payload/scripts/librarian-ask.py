#!/usr/bin/env python3
"""夜间整理留给主人的一个问题：只有主人能裁定的矛盾或空白，一晚最多一个。

Librarian 在汇报末尾问出来，同时用 `set` 记在 memory/librarian/ask.json。
汇报是定时任务发的，主人第二天在对话里回答时，那个会话并不知道问过什么；
平台每轮读这个文件，把问题和相关页面告诉 agent，agent 按回答改正记忆，再 `answered`。
（2026-10-28 的第一次整理就碰到：官网和工商在成立时间、A 轮时间上说法不一，只能主人定。）

用法（工作区根目录）：
  librarian-ask.py set --question "..." --option "官网 2020 年" --option "工商 2021 年" \
      --page memory/projects/versa/main.md --context "两种说法各自的来源"
  librarian-ask.py get
  librarian-ask.py answered --note "主人确认以工商为准"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def workspace() -> Path:
    here = Path(__file__).resolve().parent
    for p in (here, *here.parents):
        if (p / "AGENTS.md").exists():
            return p
    return Path.cwd()


WS = workspace()
FILE = WS / "memory" / "librarian" / "ask.json"


def load() -> dict | None:
    try:
        return json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save(data: dict) -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, FILE)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("set")
    s.add_argument("--question", required=True)
    s.add_argument("--option", action="append", default=[], help="给主人的选项，可重复；不给就是开放问题")
    s.add_argument("--page", action="append", default=[], help="答案要改的记忆页，可重复")
    s.add_argument("--context", default="", help="两种说法和各自的来源，给第二天的会话看")
    sub.add_parser("get")
    an = sub.add_parser("answered")
    an.add_argument("--note", required=True, help="主人怎么回答的、改了哪几页")
    a = ap.parse_args()
    cur = load()
    if a.cmd == "set":
        if cur and not cur.get("answered_at"):
            print(json.dumps({"ok": False, "detail": "上一个问题主人还没回答，今晚不再问新的", "pending": cur},
                             ensure_ascii=False, indent=1))
            sys.exit(2)
        cur = {"asked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "question": a.question,
               "options": a.option, "pages": a.page, "context": a.context}
        save(cur)
    elif a.cmd == "answered":
        if not cur or cur.get("answered_at"):
            print(json.dumps({"ok": False, "detail": "没有待回答的问题"}, ensure_ascii=False)); sys.exit(1)
        cur.update(answered_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), answer=a.note)
        save(cur)
    print(json.dumps(cur or {}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
