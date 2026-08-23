#!/usr/bin/env python3
"""DC-Distill — 每周蒸馏：把隐式行为提炼成用户行为偏好

扫 feedback.jsonl 的 behavior 字段 → 按 open_id 统计频率 → 粗筛「行为候选」
Agent 确认候选后，沉淀到 memory/people/<open_id>.md 的「行为偏好」字段。

职责边界：
  - 脚本只做「字符串粗筛 + 频率统计」，不做语义归类。
  - 「跳过贸易商」和「不要贸易商」脚本认不出是同一类，合并归类由 Agent 判断。

用法:
  python3 dc_distill.py scan [--days 7]     # 扫候选，输出 JSON
  python3 dc_distill.py promote <json>      # Agent 确认后落盘
"""

import json
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
FEEDBACK_FILE = DATA_DIR / "feedback.jsonl"
MEMORY_DIR = Path(__file__).resolve().parents[2] / "memory"

# TODO: 频率阈值待定（同一行为信号出现几次算「稳定候选」）
THRESHOLD = 2


def scan_behaviors(days: int = 7) -> dict:
    """扫描过去 N 天 feedback.jsonl 里的 behavior，按 open_id 统计频率并粗筛。"""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    counter: dict = {}  # open_id -> Counter(signal)

    if not FEEDBACK_FILE.exists():
        return {"period_days": days, "candidates": [], "total_behaviors": 0}

    with open(FEEDBACK_FILE, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
                if rec.get("_ts", "") < cutoff:
                    continue
                behavior = rec.get("interpretation", {}).get("behavior") or []
                if not behavior:
                    continue
                open_id = rec.get("user_open_id") or "default"
                counter.setdefault(open_id, Counter())
                for b in behavior:
                    counter[open_id][b] += 1
            except Exception:
                pass

    candidates = []
    total = 0
    for open_id, cnt in counter.items():
        for signal, count in cnt.items():
            total += count
            if count >= THRESHOLD:
                candidates.append({
                    "open_id": open_id,
                    "signal": signal,
                    "count": count,
                })

    candidates.sort(key=lambda x: -x["count"])
    return {
        "period_days": days,
        "candidates": candidates,
        "total_behaviors": total,
        "threshold": THRESHOLD,
    }


def promote(candidates: list) -> dict:
    """Agent 确认后的候选，落盘到 people/<open_id>.md 的行为偏好字段。"""
    written = []
    for c in candidates:
        open_id = c["open_id"]
        path = MEMORY_DIR / "people" / f"{open_id}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        line = f"- [行为 | {datetime.now(timezone.utc).strftime('%Y-%m-%d')} | 蒸馏] {c['signal']}（出现 {c['count']} 次）\n"
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
        written.append({"open_id": open_id, "signal": c["signal"]})
    return {"status": "ok", "written": written}


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "scan":
        days = 7
        if "--days" in sys.argv:
            days = int(sys.argv[sys.argv.index("--days") + 1])
        print(json.dumps(scan_behaviors(days), ensure_ascii=False, indent=2))
    elif len(sys.argv) >= 3 and sys.argv[1] == "promote":
        candidates = json.loads(sys.argv[2])
        print(json.dumps(promote(candidates), ensure_ascii=False, indent=2))
    else:
        print("用法: dc_distill.py scan [--days 7]")
        print("      dc_distill.py promote '<candidates_json>'")
