#!/usr/bin/env python3
"""展会模式（2026-09-15）：按「展会 ID + 日期区间」自动切换展会期行为。

展会期内的差异（用户 2026-09-15 定）：

  · **窗口豁免**：发送窗口不阻断（`send_window.py` 自动切 exhibition 模式）
  · **额度**：本地不设硬限；消耗按 `xiaoyuan report-usage` 上报（平台计量）
  · **自动白名单**：只有"邀约到展位"这一类免确认自动发；其余来源需确认（见 skill 场景表）

配置来源（按优先级）：
  1. 环境变量 `DC_EXHIBITION_WINDOWS`（JSON 数组字符串）
  2. 文件 `data/exhibition/windows.json`

配置格式::

    {"windows": [
        {"exhibition_id": "153072369700", "name": "2026年墨西哥中国出口品牌展",
         "start": "2026-09-15", "end": "2026-09-18"}
    ]}

用法::

    python3 dc_exhibition_mode.py                 # 打印当前是否展会期
    python3 dc_exhibition_mode.py --exhibition-id 153072369700
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "data" / "exhibition" / "windows.json"
ENV_KEY = "DC_EXHIBITION_WINDOWS"


def _as_date(value) -> date | None:
    s = str(value or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def load_windows() -> list[dict]:
    """读取展会时间窗（env 优先，其次配置文件）；任何异常都返回空列表，不抛。"""
    raw = ""
    if os.environ.get(ENV_KEY):
        raw = os.environ[ENV_KEY]
    elif CONFIG_PATH.exists():
        try:
            raw = CONFIG_PATH.read_text(encoding="utf-8")
        except Exception:  # noqa: BLE001
            return []
    if not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        return []
    windows = data.get("windows") if isinstance(data, dict) else data
    if not isinstance(windows, list):
        return []
    out = []
    for w in windows:
        if not isinstance(w, dict):
            continue
        s, e = _as_date(w.get("start")), _as_date(w.get("end"))
        if not s or not e:
            continue
        out.append({
            "exhibition_id": str(w.get("exhibition_id") or ""),
            "name": str(w.get("name") or ""),
            "start": s.isoformat(),
            "end": e.isoformat(),
            "_start": s,
            "_end": e,
        })
    return out


def active_window(now: datetime | date | None = None, *, exhibition_id: str = "") -> dict | None:
    """当前是否处于某个展会期；命中返回该 window，未命中返回 None。

    ``end`` 为闭区间（展会最后一天当天仍算展会期）。
    """
    today = now.date() if isinstance(now, datetime) else (now or date.today())
    for w in load_windows():
        if exhibition_id and w["exhibition_id"] != str(exhibition_id):
            continue
        if w["_start"] <= today <= w["_end"]:
            return {k: v for k, v in w.items() if not k.startswith("_")}
    return None


def in_exhibition_mode(now: datetime | date | None = None) -> bool:
    return active_window(now) is not None


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="展会模式判定（按展会 ID + 日期区间）")
    p.add_argument("--exhibition-id", default="", help="只看指定展会")
    p.add_argument("--today", default="", help="按指定日期判定（YYYY-MM-DD，测试用）")
    a = p.parse_args(argv)
    now = _as_date(a.today) or date.today()
    w = active_window(now, exhibition_id=a.exhibition_id)
    result = {
        "ok": True,
        "today": now.isoformat(),
        "exhibition_mode": bool(w),
        "window": w or {},
        "windows_configured": len(load_windows()),
    }
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
