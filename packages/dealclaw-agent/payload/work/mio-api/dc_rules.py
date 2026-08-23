#!/usr/bin/env python3
"""DC-Rules — 长期规则原子写入（memory/company/<enterprise>/rules.md）

纠偏时，Agent 判断的「明确长期规则」（explicit_long_term_rules）当轮原子写入 rules.md。
条目格式：- [状态 | 日期 | 来源] 规则文本
状态：active / superseded（新旧规则冲突时标 superseded 不删除）

用法:
  python3 dc_rules.py add <enterprise> <rule_text> [source]
  python3 dc_rules.py list <enterprise>
"""

import fcntl
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# workspace 根（dealclaw）下的 memory 目录
MEMORY_DIR = Path(__file__).resolve().parents[2] / "memory"


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _rules_path(enterprise: str) -> Path:
    d = MEMORY_DIR / "company" / enterprise
    d.mkdir(parents=True, exist_ok=True)
    return d / "rules.md"


def append_rule(enterprise: str, rule_text: str, source: str = "",
                state: str = "active") -> dict:
    """当轮原子追加一条长期规则到 rules.md。"""
    if not enterprise or not str(enterprise).strip():
        return {"status": "error", "error": "enterprise 必填"}
    if not rule_text or not str(rule_text).strip():
        return {"status": "error", "error": "rule_text 必填"}

    path = _rules_path(enterprise)
    line = f"- [{state} | {_today()} | {source}] {str(rule_text).strip()}\n"

    with open(path, "a", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(line)
        fcntl.flock(f, fcntl.LOCK_UN)

    return {"status": "ok", "path": str(path), "rule": str(rule_text).strip()}


def list_rules(enterprise: str) -> list:
    """读取某企业的全部规则（按行返回）。"""
    path = _rules_path(enterprise)
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return [ln.rstrip("\n") for ln in f if ln.strip()]


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "add":
        result = append_rule(sys.argv[2], sys.argv[3],
                             source=sys.argv[4] if len(sys.argv) > 4 else "")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif len(sys.argv) == 3 and sys.argv[1] == "list":
        for r in list_rules(sys.argv[2]):
            print(r)
    else:
        print("用法: dc_rules.py add <enterprise> <rule_text> [source]")
        print("      dc_rules.py list <enterprise>")
