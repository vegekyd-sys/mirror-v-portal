#!/usr/bin/env python3
"""dc_learning_digest.py — 「我更懂你了」主动汇报（显化层，出口统一走 dc_notify）

背景（2026-09-17 田耕郡）：
「我需要你让用户感受到反思和更懂，这部分需要显化出来。日常任务大家能感受到你越来越好，
 但是给用户使用，还是要积极地不断汇报的。」

所以：沉淀不能只在后台发生——**有新东西就要主动说一句**。本模块把
`dc_memory_view.learning_digest()` 生成的内容，用 dc_notify 发给用户（signal_item / realtime）。

约束：
- **限频**：默认同一公司 24h 内最多汇报一次（`--min-interval-hours` 可调，`--force` 可强发）。
- **幂等**：与上次汇报内容相同（last_key 一致）→ 不发。
- **无新增** → 不发（不刷屏）。
- 发送真实发生才更新状态；dry-run 只打印。

用法::

    python3 dc_learning_digest.py run --company-id 100000834234 --open-id ou_xxx        # dry-run
    python3 dc_learning_digest.py run --company-id 100000834234 --open-id ou_xxx --apply # 真发
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from dc_memory_view import learning_digest  # noqa: E402

DATA_DIR_NAME = "data"
STATE_NAME = "learning-digest-state.json"


def _data_dir() -> Path:
    """每次调用重新读 env：多租户/测试会切 DC_DATA_DIR，模块级常量会串（实测踩过）。"""
    return Path(os.environ.get("DC_DATA_DIR") or str(BASE / DATA_DIR_NAME))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _state_path() -> Path:
    return _data_dir() / STATE_NAME


def _load_state() -> dict:
    path = _state_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8")) or {}
    except Exception:  # noqa: BLE001
        return {}


def _save_state(state: dict) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _key(company_id: str, open_id: str) -> str:
    return f"{company_id}::{open_id or '-'}"


def _digest_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def run(company_id: str, *, open_id: str = "", days: int = 7,
        min_interval_hours: float = 24.0, apply: bool = False, force: bool = False) -> dict:
    """生成并按需发送一条「我更懂你了」。返回结构化结果（供心跳/日报内联调用）。"""
    since = _now() - timedelta(days=days)
    digest = learning_digest(company_id, open_id=open_id, since=since)
    if not digest.get("count"):
        return {"status": "no_items", "count": 0}

    text = digest["text"]
    key = _digest_key(text)
    state = _load_state()
    slot_key = _key(company_id, open_id)
    prev = state.get(slot_key) or {}

    if prev.get("last_key") == key and not force:
        return {"status": "duplicate", "count": digest["count"]}
    if not force and prev.get("last_sent_at"):
        try:
            last = datetime.fromisoformat(prev["last_sent_at"])
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            if _now() - last < timedelta(hours=float(min_interval_hours)):
                return {"status": "rate_limited", "count": digest["count"],
                        "last_sent_at": prev["last_sent_at"]}
        except ValueError:
            pass

    result = {"status": "dry_run", "count": digest["count"], "text": text}
    if not apply:
        return result

    try:
        from dc_notify import NotifyEngine  # noqa: PLC0415
        engine = NotifyEngine()
        pub = engine.publish(company_id, "signal_item",
                             {"message": text, "summary": f"我更懂你了（{digest['count']} 件新事）",
                              "source": "learning_digest"},
                             urgency="normal", dedupe_key=key, slot="realtime")
        nid = pub.get("notification_id") or (pub.get("data") or {}).get("notification_id")
        disp = engine.dispatch(company_id, "realtime", only_ids=[nid] if nid else None)
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "count": digest["count"], "error": f"{type(exc).__name__}: {exc}"}

    ok = str(disp.get("status") or "") in {"ok", "sent", "dispatched", "empty"}
    if ok and str(disp.get("status")) != "empty":
        state[slot_key] = {"last_sent_at": _now().isoformat(timespec="seconds"),
                           "last_key": key, "count": digest["count"], "text": text}
        _save_state(state)
    result.update({"status": "sent" if ok else "send_failed",
                   "publish": pub.get("status"), "dispatch": disp.get("status")})
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="「我更懂你了」主动汇报（出口统一走 dc_notify）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run")
    p.add_argument("--company-id", required=True)
    p.add_argument("--open-id", default="")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--min-interval-hours", type=float, default=24.0)
    p.add_argument("--apply", action="store_true", help="真发（默认 dry-run）")
    p.add_argument("--force", action="store_true", help="忽略限频/去重")
    args = ap.parse_args()

    out = run(args.company_id, open_id=args.open_id, days=args.days,
              min_interval_hours=args.min_interval_hours, apply=args.apply, force=args.force)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get("status") in {"sent", "dry_run", "no_items", "duplicate", "rate_limited"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
