#!/usr/bin/env python3
"""
dc_exhibition_meta.py — 展会信息 + 展位号落点（meta.json）

复用 `dc_exhibition_stage.meta_path` 的 meta.json 路径与写入约定，扩展两件重要信息：

  - 展会信息（名称/城市/国家/起止/时区/展馆）—— 可从 CDP 接口刷新，也可用户提供
  - **展位号** —— **用户说了要记住**；某天接口能查到再补

写入规则（关键）：
  1. 展位号一旦由用户提供（`source=user`），**永不被空值或接口值静默覆盖**；
     接口值仅在「meta 无值」或「现值为接口来源」时写入；冲突时保留用户值并记录 conflict。
  2. 展会信息可刷新（接口/用户都可写），按字段 merge，不整条覆盖。
  3. 其它字段（exhibition_stage / understanding_done / plan_done 等）原样保留。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from dc_exhibition_stage import meta_path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_meta(company_id: str) -> dict:
    p = meta_path(company_id)
    if p.exists():
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            return d if isinstance(d, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


def write_meta(company_id: str, meta: dict) -> Path:
    """原子写 meta.json（临时文件 + replace）。"""
    p = meta_path(company_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return p


def _find(meta: dict, exhibition_id: str) -> Optional[dict]:
    """找展会条目；exhibition_id 为空时取第一条（当前/最近一届）。"""
    exhs = meta.get("exhibitions", [])
    if not isinstance(exhs, list):
        return None
    if not exhibition_id:
        return exhs[0] if exhs else None
    for e in exhs:
        if str(e.get("exhibition_id") or e.get("sourceId") or "") == str(exhibition_id):
            return e
    return None


def upsert_exhibition(company_id: str, exhibition_id: str, *, source: str = "cdp",
                      **fields) -> dict:
    """写入/刷新展会信息（按字段 merge，不整条覆盖）。"""
    meta = read_meta(company_id)
    exhs = meta.setdefault("exhibitions", [])
    if not isinstance(exhs, list):
        exhs = []
        meta["exhibitions"] = exhs

    entry = _find(meta, exhibition_id)
    if entry is None:
        entry = {"exhibition_id": exhibition_id}
        exhs.append(entry)

    for k, v in fields.items():
        if v not in (None, "", []):
            entry[k] = v
    entry["info_source"] = source
    entry["info_updated_at"] = _now()
    write_meta(company_id, meta)
    return entry


def set_booth(company_id: str, booth: str, *, exhibition_id: str = "",
              source: str = "user") -> dict:
    """记住展位号。

    - source=user：直接写入（用户值最高优先）
    - source=其他（如 win-contracts）：仅当 meta 无值，或现值为接口来源时才写；
      若现值来自用户 → 保留用户值并标 conflict（不静默覆盖）
    """
    meta = read_meta(company_id)
    exhs = meta.setdefault("exhibitions", [])
    if not isinstance(exhs, list):
        exhs = []
        meta["exhibitions"] = exhs

    entry = _find(meta, exhibition_id)
    if entry is None:
        entry = {"exhibition_id": exhibition_id}
        exhs.append(entry)

    cur = str(entry.get("booth") or "").strip()
    cur_src = str(entry.get("booth_source") or "").strip()
    booth = str(booth or "").strip()

    if not booth:
        return {"ok": False, "error": "empty_booth", "booth": cur}

    if source == "user":
        entry["booth"] = booth
        entry["booth_source"] = "user"
        entry["booth_updated_at"] = _now()
    else:
        if not cur:
            entry["booth"] = booth
            entry["booth_source"] = source
            entry["booth_updated_at"] = _now()
        elif cur_src != "user":
            entry["booth"] = booth
            entry["booth_source"] = source
            entry["booth_updated_at"] = _now()
        else:
            if cur != booth:
                entry["booth_conflict"] = {"user": cur, "other": booth, "source": source}
            write_meta(company_id, meta)
            return {"ok": True, "kept_user_value": True, "booth": cur}

    write_meta(company_id, meta)
    return {"ok": True, "booth": entry.get("booth"), "source": entry.get("booth_source")}


def get_exhibition(company_id: str, exhibition_id: str = "") -> dict:
    """取展会条目（含 booth）；没有则返回空 dict。"""
    return _find(read_meta(company_id), exhibition_id) or {}


def sync_exhibition_info(company_id: str, *, fetcher=None) -> dict:
    """从 CDP 拉展会信息 → upsert 进 meta.json（展会信息「查了就存」）。

    fetcher() -> list[dict]，可注入；缺省复用 dc_onsite_recommend.current_exhibitions。
    """
    if fetcher is None:
        try:
            from dc_onsite_recommend import current_exhibitions as fetcher  # type: ignore
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "no_fetcher"}
    try:
        exhs = fetcher() or []
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    ids = []
    for e in exhs:
        if not isinstance(e, dict):
            continue
        eid = str(e.get("exhibitionId") or e.get("exhibition_id") or e.get("sourceId") or "")
        entry = upsert_exhibition(
            company_id, eid, source="cdp",
            name=e.get("name") or e.get("exhibitionName") or "",
            country=e.get("country") or "",
            city=e.get("city") or "",
            start=str(e.get("inshowStartDate") or e.get("start") or "")[:10],
            end=str(e.get("inshowEndDate") or e.get("end") or "")[:10],
            venue=e.get("venue") or "",
            timezone=e.get("timezone") or "",
        )
        ids.append(entry.get("exhibition_id"))
    return {"ok": True, "count": len(ids), "exhibitions": ids}


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="展会信息/展位号落点（meta.json）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("set-booth")
    s.add_argument("company_id")
    s.add_argument("booth")
    s.add_argument("--exhibition-id", default="")

    g = sub.add_parser("show")
    g.add_argument("company_id")
    g.add_argument("--exhibition-id", default="")

    syn = sub.add_parser("sync-info")
    syn.add_argument("company_id")

    a = sub.add_parser("upsert")
    a.add_argument("company_id")
    a.add_argument("exhibition_id")
    a.add_argument("--name", default="")
    a.add_argument("--city", default="")
    a.add_argument("--country", default="")
    a.add_argument("--start", default="")
    a.add_argument("--end", default="")
    a.add_argument("--venue", default="")
    a.add_argument("--timezone", default="")

    args = ap.parse_args()
    if args.cmd == "set-booth":
        print(json.dumps(set_booth(args.company_id, args.booth,
                                   exhibition_id=args.exhibition_id), ensure_ascii=False))
    elif args.cmd == "show":
        print(json.dumps(get_exhibition(args.company_id, args.exhibition_id),
                         ensure_ascii=False, indent=2))
    elif args.cmd == "sync-info":
        print(json.dumps(sync_exhibition_info(args.company_id), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(upsert_exhibition(
            args.company_id, args.exhibition_id, name=args.name, city=args.city,
            country=args.country, start=args.start, end=args.end,
            venue=args.venue, timezone=args.timezone), ensure_ascii=False, indent=2))
