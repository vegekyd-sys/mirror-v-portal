#!/usr/bin/env python3
"""
DC-ErrorLog — 结构化错误日志引擎

替代全系统 30+ 处 bare except: pass。
每条错误带时间、引擎、操作、原因、上下文。

用法:
  from dc_error_log import log_error
  log_error("iq_engine", "process", e, buyer="munich-solar.de")
  log_error("cdp", "search", e, keyword="solar", country="DE")
"""

import json, os, traceback
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
ERROR_FILE = DATA_DIR / "error_log.jsonl"


def _now():
    return datetime.now(timezone.utc).isoformat()


def log_error(engine, operation, error, **context):
    """
    记录一次错误。

    engine:   引擎名 (iq_engine, cdp, send_log, ...)
    operation: 操作名 (process, search, send, ...)
    error:     Exception 或 错误信息字符串
    **context: 任意上下文键值对
    """
    entry = {
        "_ts": _now(),
        "engine": engine,
        "operation": operation,
        "error": str(error)[:500],
        "error_type": type(error).__name__ if isinstance(error, Exception) else "str",
        "traceback": traceback.format_exc()[:800] if isinstance(error, Exception) else "",
    }
    if context:
        entry["context"] = {k: str(v)[:200] for k, v in context.items()}
    try:
        os.makedirs(str(DATA_DIR), exist_ok=True)
        with open(ERROR_FILE, 'a') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except Exception:
        pass  # 最后的保险：日志写不了就不再尝试


def recent_errors(hours=24, engine=None):
    """获取最近的错误"""
    cutoff = (datetime.now(timezone.utc) - __import__('datetime').timedelta(hours=hours)).isoformat()
    records = []
    if not ERROR_FILE.exists():
        return records
    with open(ERROR_FILE) as f:
        for line in f:
            try:
                r = json.loads(line.strip())
                if r.get("_ts", "") >= cutoff:
                    if engine and r.get("engine") != engine:
                        continue
                    records.append(r)
            except Exception:
                pass
    return records


def error_summary(hours=24):
    """错误汇总: 按引擎 × 操作聚合"""
    errors = recent_errors(hours)
    from collections import Counter
    by_engine = Counter(r["engine"] for r in errors)
    by_type = Counter(r["error_type"] for r in errors)
    return {
        "total": len(errors),
        "by_engine": dict(by_engine),
        "by_type": dict(by_type),
        "latest": [{"ts": r["_ts"][:19], "engine": r["engine"], "error": r["error"][:80]}
                    for r in errors[-5:]],
    }


# ── CLI ──
if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print(json.dumps(error_summary(), ensure_ascii=False, indent=2))
    elif sys.argv[1] == "recent":
        for r in recent_errors():
            print(f"[{r['_ts'][:19]}] {r['engine']:15s} {r['operation']:15s} {r['error'][:80]}")
    else:
        print(json.dumps(error_summary(), ensure_ascii=False, indent=2))
