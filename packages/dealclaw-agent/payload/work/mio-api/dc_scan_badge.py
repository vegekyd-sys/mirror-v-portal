#!/usr/bin/env python3
"""展证扫码记录（展商在展会期间扫到的买家）— 单独存档 + 查询 + 慧译/慧记匹配。

为什么单独存：扫码记录是**展商联系人的原始采集数据**（含联系方式），语义上不同于
线索池里的销售线索。先落到独立目录留档，再按需生成线索池记录；避免把原始记录
直接当线索写进去、也避免每次展示都重新请求接口。

固定位置（相对本目录，即 mio-api 工作目录）::

    data/exhibition/scan-badge/<supplier_id>/records.jsonl   # 归一化后的记录（按 record_id 幂等）
    data/exhibition/scan-badge/<supplier_id>/index.json      # 汇总索引（最近抓取时间/条数/展会分布）
    data/exhibition/scan-badge/<supplier_id>/raw/<ts>.json   # 原始响应留档

数据源：`xiaoyuan company scan-badge-list`（POST /agent/company/getSupplierScanPage.json）
身份：`--open-id` 与 `--supplier-id` 必须成对（或 env MEO_OPEN_ID / MEO_SUPPLIER_ID）。

用法::

    python3 dc_scan_badge.py fetch  --supplier-id <id> --open-id <id> [--exhibition-id <id>]
                                    [--start 2026-09-01] [--end 2026-09-30] [--page-size 100]
    python3 dc_scan_badge.py list   --supplier-id <id> [--limit 10]
    python3 dc_scan_badge.py match  --supplier-id <id> [--limit 5] [--mock]
    python3 dc_scan_badge.py fetch  --supplier-id demo --mock        # 造数据跑通链路
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
STORE_ROOT = BASE / "data" / "exhibition" / "scan-badge"

# 归一化字段的候选来源键（真实字段名以接口为准，这里做宽容映射并保留原始记录）
_KEY_CANDIDATES = {
    "company_name": ("companyName", "company_name", "buyerCompanyName", "custCompanyName", "name"),
    "website": ("website", "companyWebsite", "webSite", "url", "domain"),
    "country": ("country", "countryName", "areaName", "nation"),
    "contact_name": ("contactName", "contact_name", "buyerName", "custName", "linkman"),
    "title": ("position", "title", "jobTitle", "duty"),
    "email": ("email", "mail", "contactEmail"),
    "phone": ("phone", "mobile", "telephone", "contactPhone", "whatsapp"),
    "customer_id": ("customerId", "customer_id", "custId"),
    "cdp_id": ("cdpId", "cdp_id", "companyCdpId"),
    "badge_no": ("badgeNo", "badge_no", "cardNo", "exhibitionBadgeNo"),
    "scan_time": ("scanTime", "scan_time", "createTime", "createdAt", "gmtCreate"),
    "exhibition_id": ("exhibitionId", "exhibition_id", "sourceId"),
    "exhibition_name": ("exhibitionName", "exhibition_name"),
}


def _pick(rec: dict, field: str) -> str:
    for key in _KEY_CANDIDATES.get(field, ()):
        val = rec.get(key)
        if val not in (None, "", []):
            return str(val).strip()
    return ""


def normalize(rec: dict) -> dict:
    """把原始记录归一为稳定结构；原始记录原样保留在 ``raw``。"""
    out = {k: _pick(rec, k) for k in _KEY_CANDIDATES}
    out["raw"] = rec
    seed = "|".join([out.get("exhibition_id", ""), out.get("badge_no", ""),
                     out.get("email", ""), out.get("scan_time", ""),
                     out.get("company_name", "")])
    out["record_id"] = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]
    out["fetched_at"] = datetime.now(timezone.utc).isoformat()
    return out


def store_dir(supplier_id: str) -> Path:
    d = STORE_ROOT / str(supplier_id or "unknown")
    (d / "raw").mkdir(parents=True, exist_ok=True)
    return d


def load_records(supplier_id: str) -> list[dict]:
    path = store_dir(supplier_id) / "records.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:  # noqa: BLE001
            continue
    return rows


def save_records(supplier_id: str, records: list[dict], *, raw_payload: dict | None = None) -> dict:
    """按 record_id 幂等追加。返回 {"added", "skipped", "total"}。"""
    d = store_dir(supplier_id)
    path = d / "records.jsonl"
    existing = {r.get("record_id") for r in load_records(supplier_id)}
    added = 0
    with path.open("a", encoding="utf-8") as fh:
        for rec in records:
            if rec.get("record_id") in existing:
                continue
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            existing.add(rec.get("record_id"))
            added += 1
    if raw_payload is not None:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        (d / "raw" / f"{ts}.json").write_text(
            json.dumps(raw_payload, ensure_ascii=False, indent=1), encoding="utf-8")
    all_rows = load_records(supplier_id)
    by_exh: dict[str, int] = {}
    for r in all_rows:
        key = r.get("exhibition_name") or r.get("exhibition_id") or "(未知展会)"
        by_exh[key] = by_exh.get(key, 0) + 1
    index = {
        "supplier_id": str(supplier_id),
        "total": len(all_rows),
        "last_fetch_at": datetime.now(timezone.utc).isoformat(),
        "by_exhibition": by_exh,
        "store_path": str(path.relative_to(BASE)),
    }
    (d / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"added": added, "skipped": len(records) - added, "total": len(all_rows),
            "store_path": index["store_path"]}


# ── 邀约记录（用于交叉比对：既邀约又扫码 = 采购意图高）────────────
# 邀约字段同样做宽容映射；未见过真实返回前不写死判据。
INVITATION_KEYS = {
    "company_name": ("companyName", "custCompanyName", "buyerCompanyName", "company_name"),
    "website": ("website", "companyWebsite", "webSite", "domain"),
    "email": ("email", "contactEmail", "buyerEmail"),
    "contact_name": ("contactName", "linkman", "buyerName"),
    "exhibition_id": ("exhibitionId", "exhibition_id"),
    "exhibition_name": ("exhibitionName", "exhibition_name"),
    "invitation_state": ("inviationState", "invitationState", "state", "invitation_state"),
    "invitation_type": ("inviationType", "invitationType", "invitation_type"),
    "is_check_in": ("isCheckIn", "is_check_in", "checkIn"),
    "is_meeting": ("isMeeting", "is_meeting"),
    "create_user": ("createUser", "create_user"),
    "create_time": ("createTime", "createdAt", "gmtCreate"),
}

_COMPANY_SUFFIX = ("co., ltd", "co. ltd", "co.,ltd", "company limited", "limited", "ltd", "llc",
                   "inc.", "inc", "corp.", "corp", "corporation", "s.a. de c.v.", "s.a.", "sa",
                   "gmbh", "pty ltd", "ltda", "s.r.l.", "b.v.", "co.", "有限公司", "股份公司", "公司")


def company_key(name: str) -> str:
    """公司名归一：小写 + 去标点/空格 + 去常见法人后缀。仅用于精确比对，不做模糊猜测。"""
    s = str(name or "").lower()
    for ch in "()（）.,，、·-–_&/\\'\"":
        s = s.replace(ch, " ")
    s = " ".join(s.split())
    changed = True
    while changed:
        changed = False
        for suf in _COMPANY_SUFFIX:
            if s.endswith(" " + suf):
                s = s[: -len(suf) - 1].strip()
                changed = True
    return s.replace(" ", "")


def domain_of(value: str) -> str:
    """从邮箱或网址里取域名（小写，去 www）。"""
    s = str(value or "").strip().lower()
    if not s:
        return ""
    if "@" in s:
        s = s.split("@", 1)[1]
    s = s.replace("https://", "").replace("http://", "").strip("/")
    s = s.split("/", 1)[0].split("?", 1)[0]
    return s[4:] if s.startswith("www.") else s


def normalize_invitation(rec: dict) -> dict:
    out = {k: _pick(rec, k) for k in ()}  # 占位，下面用专用映射
    out = {}
    for field, keys in INVITATION_KEYS.items():
        val = ""
        for k in keys:
            v = rec.get(k)
            if v not in (None, "", []):
                val = str(v).strip()
                break
        out[field] = val
    out["raw"] = rec
    seed = "|".join([out.get("exhibition_id", ""), out.get("company_name", ""),
                     out.get("email", ""), out.get("create_time", "")])
    out["record_id"] = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]
    out["fetched_at"] = datetime.now(timezone.utc).isoformat()
    return out


def invitation_dir(supplier_id: str) -> Path:
    d = STORE_ROOT.parent / "invitation" / str(supplier_id or "unknown")
    (d / "raw").mkdir(parents=True, exist_ok=True)
    return d


def load_invitations(supplier_id: str) -> list[dict]:
    path = invitation_dir(supplier_id) / "records.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:  # noqa: BLE001
            continue
    return rows


def save_invitations(supplier_id: str, records: list[dict], *, raw_payload: dict | None = None) -> dict:
    d = invitation_dir(supplier_id)
    path = d / "records.jsonl"
    existing = {r.get("record_id") for r in load_invitations(supplier_id)}
    added = 0
    with path.open("a", encoding="utf-8") as fh:
        for rec in records:
            if rec.get("record_id") in existing:
                continue
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            existing.add(rec.get("record_id"))
            added += 1
    if raw_payload is not None:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        (d / "raw" / f"{ts}.json").write_text(
            json.dumps(raw_payload, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"added": added, "skipped": len(records) - added, "total": len(load_invitations(supplier_id)),
            "store_path": str(path.relative_to(BASE))}


def fetch_invitations_api(*, supplier_id: str, open_id: str, exhibition_id: str = "",
                          is_check_in: str = "", is_meeting: str = "",
                          page_num: int = 1, page_size: int = 50) -> dict:
    cmd = ["xiaoyuan"]
    if open_id:
        cmd += ["--open-id", open_id]
    if supplier_id:
        cmd += ["--supplier-id", supplier_id]
    cmd += ["company", "invitation-list", "--page-num", str(page_num), "--page-size", str(page_size)]
    for flag, val in (("--exhibition-id", exhibition_id), ("--is-check-in", is_check_in),
                      ("--is-meeting", is_meeting)):
        if val not in ("", None):
            cmd += [flag, str(val)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    raw = proc.stdout
    try:
        return json.loads(raw[raw.find("{"):])
    except Exception:
        raise SystemExit(f"CLI 输出无法解析：{raw[:300]}{proc.stderr[:200]}")


def _mock_data():
    """联调 mock 数据（2026-09-15 减肥：从主文件外移到 fixtures）。"""
    from fixtures.scan_badge_mock import mock_invitations, mock_records  # noqa: PLC0415

    return mock_records, mock_invitations


# ── 交叉比对：既邀约又扫码 = 高意图 ─────────────────────────
def cross_match(scans: list[dict], invitations: list[dict]) -> dict:
    """扫码 × 邀约交叉比对。

    优先级（用户口径）：1 既邀约又扫码（🔥热·优先跟进/推荐）> 2 纯扫码 > 3 纯邀约未到场
    命中判据（由强到弱）：域名相同 > 邮箱相同 > 公司名归一后完全相同；
    **不做模糊/相似度匹配**，不确认就不算命中。
    """
    by_domain: dict[str, dict] = {}
    by_email: dict[str, dict] = {}
    by_name: dict[str, dict] = {}
    for inv in invitations:
        dom = domain_of(inv.get("website")) or domain_of(inv.get("email"))
        if dom:
            by_domain.setdefault(dom, inv)
        mail = str(inv.get("email") or "").strip().lower()
        if mail:
            by_email.setdefault(mail, inv)
        key = company_key(inv.get("company_name", ""))
        if key:
            by_name.setdefault(key, inv)

    used_inv: set[str] = set()
    ranked: list[dict] = []
    for s in scans:
        dom = domain_of(s.get("website")) or domain_of(s.get("email"))
        mail = str(s.get("email") or "").strip().lower()
        key = company_key(s.get("company_name", ""))
        hit = None
        how = ""
        if dom and dom in by_domain:
            hit, how = by_domain[dom], f"域名 {dom}"
        elif mail and mail in by_email:
            hit, how = by_email[mail], f"邮箱 {mail}"
        elif key and key in by_name:
            hit, how = by_name[key], f"公司名 {s.get('company_name','')}"
        if hit is not None:
            used_inv.add(hit.get("record_id", ""))
            checkin = str(hit.get("is_check_in", ""))
            ranked.append({
                "priority": 1, "tag": "邀约+扫码",
                "company_name": s.get("company_name", ""), "website": s.get("website", ""),
                "contact": s.get("contact_name", ""), "email": s.get("email", ""),
                "exhibition": s.get("exhibition_name", ""),
                "evidence": f"命中邀约：{hit.get('company_name','')}（{how}）· 是否到展={checkin or '未标明'}",
                "action": "🔥热 · 优先跟进 + 优先推荐",
            })
        else:
            ranked.append({
                "priority": 2, "tag": "纯扫码",
                "company_name": s.get("company_name", ""), "website": s.get("website", ""),
                "contact": s.get("contact_name", ""), "email": s.get("email", ""),
                "exhibition": s.get("exhibition_name", ""),
                "evidence": "扫码记录（无对应邀约记录）",
                "action": "按慧译慧记意图定冷热；无 text → ❄️冷",
            })
    for inv in invitations:
        if inv.get("record_id", "") in used_inv:
            continue
        ranked.append({
            "priority": 3, "tag": "纯邀约（未扫码）",
            "company_name": inv.get("company_name", ""), "website": inv.get("website", ""),
            "contact": inv.get("contact_name", ""), "email": inv.get("email", ""),
            "exhibition": inv.get("exhibition_name", ""),
            "evidence": f"邀约未到展/未扫码（是否到展={inv.get('is_check_in', '未标明')}）",
            "action": "其次；排在扫码组之后",
        })
    ranked.sort(key=lambda r: (r["priority"], str(r.get("company_name"))))
    return {
        "scans": len(scans), "invitations": len(invitations),
        "both": sum(1 for r in ranked if r["priority"] == 1),
        "scan_only": sum(1 for r in ranked if r["priority"] == 2),
        "invite_only": sum(1 for r in ranked if r["priority"] == 3),
        "ranked": ranked,
    }


# ── 取数 ────────────────────────────────────────────────────
def fetch_api(*, supplier_id: str, open_id: str, exhibition_id: str = "",
              start: str = "", end: str = "", page_size: int = 100, page_num: int = 1) -> dict:
    cmd = ["xiaoyuan"]
    if open_id:
        cmd += ["--open-id", open_id]
    if supplier_id:
        cmd += ["--supplier-id", supplier_id]
    cmd += ["company", "scan-badge-list", "--page-num", str(page_num), "--page-size", str(page_size)]
    if exhibition_id:
        cmd += ["--exhibition-id", exhibition_id]
    if start:
        cmd += ["--start", start]
    if end:
        cmd += ["--end", end]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    raw = proc.stdout
    try:
        payload = json.loads(raw[raw.find("{"):])
    except Exception:
        raise SystemExit(f"CLI 输出无法解析：{raw[:300]}{proc.stderr[:200]}")
    return payload


def _api_records(payload: dict) -> tuple[list, str]:
    data = ((payload.get("response") or {}).get("data") or {})
    records = data.get("records") or []
    msg = (payload.get("response") or {}).get("msg") or payload.get("msg") or ""
    return records, msg


# ── 慧译 / 慧记 匹配 ─────────────────────────────────────────
def fetch_translate_summary(customer_id: str, *, mock: bool = False) -> str:
    if mock:
        return ("Real-time translation summary: buyer asked about MOQ 500 units, "
                "FOB Santos, delivery within 45 days; requested catalog and certification.")
    cmd = ["xiaoyuan", "company", "translate-summary-list", "--customer-id", customer_id, "--type", "1"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    return p.stdout.strip()


def fetch_note_records(customer_id: str, *, mock: bool = False) -> str:
    if mock:
        return ("Meeting note: 展位洽谈 12 分钟，买家关注交期与认证；"
                "对方是区域经销商，年采购量约 20 个柜；约定展后发目录与报价单。")
    cmd = ["xiaoyuan", "company", "note-records", "--customer-id", customer_id]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    return p.stdout.strip()


def match_huiji_huiyi(records: list[dict], *, mock: bool = False, limit: int = 5) -> list[dict]:
    out = []
    for rec in records[:limit]:
        cid = rec.get("customer_id") or ""
        out.append({
            "company_name": rec.get("company_name", ""),
            "customer_id": cid,
            "huiyi_translate": fetch_translate_summary(cid, mock=mock) if cid else "",
            "huiji_note": fetch_note_records(cid, mock=mock) if cid else "",
        })
    return out


# ── CLI ────────────────────────────────────────────────────
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="展证扫码记录：存档 / 查询 / 慧译慧记匹配")
    sub = p.add_subparsers(dest="command", required=True)

    f = sub.add_parser("fetch", help="拉取并归档扫码记录")
    f.add_argument("--supplier-id", required=True)
    f.add_argument("--open-id", default="")
    f.add_argument("--exhibition-id", default="")
    f.add_argument("--start", default="")
    f.add_argument("--end", default="")
    f.add_argument("--page-size", type=int, default=100)
    f.add_argument("--page-num", type=int, default=1)
    f.add_argument("--mock", action="store_true", help="不调接口，用 mock 数据跑通链路")

    l = sub.add_parser("list", help="查看已归档记录")
    l.add_argument("--supplier-id", required=True)
    l.add_argument("--limit", type=int, default=10)

    m = sub.add_parser("match", help="对已归档记录做慧译/慧记匹配")
    m.add_argument("--supplier-id", required=True)
    m.add_argument("--limit", type=int, default=5)
    m.add_argument("--mock", action="store_true")

    fi = sub.add_parser("fetch-invitations", help="拉取并归档邀约记录（交叉比对用）")
    fi.add_argument("--supplier-id", required=True)
    fi.add_argument("--open-id", default="")
    fi.add_argument("--exhibition-id", default="")
    fi.add_argument("--is-check-in", default="")
    fi.add_argument("--is-meeting", default="")
    fi.add_argument("--page-size", type=int, default=50)
    fi.add_argument("--page-num", type=int, default=1)
    fi.add_argument("--mock", action="store_true")

    cm = sub.add_parser("crossmatch", help="扫码 × 邀约 交叉比对并排序（既邀约又扫码=高意图）")
    cm.add_argument("--supplier-id", required=True)
    cm.add_argument("--limit", type=int, default=20)
    cm.add_argument("--mock", action="store_true", help="用 mock 邀约/扫码数据直接跑排序")

    a = p.parse_args(argv)
    if a.command == "fetch":
        if a.mock:
            mock_records, _ = _mock_data()
            recs = [normalize(r) for r in mock_records(3)]
            res = save_records(a.supplier_id, recs, raw_payload={"mock": True, "records": recs})
            print(json.dumps({"ok": True, "mock": True, **res}, ensure_ascii=False))
            return 0
        if not a.open_id or not a.supplier_id:
            print(json.dumps({"ok": False,
                              "error": "身份必须成对：--open-id 与 --supplier-id（缺一个就无法查，请向用户索取，不要猜）"},
                             ensure_ascii=False))
            return 2
        payload = fetch_api(supplier_id=a.supplier_id, open_id=a.open_id,
                            exhibition_id=a.exhibition_id, start=a.start, end=a.end,
                            page_size=a.page_size, page_num=a.page_num)
        raw_recs, msg = _api_records(payload)
        if not raw_recs:
            print(json.dumps({"ok": True, "total_remote": 0, "added": 0, "msg": msg,
                              "note": "该身份下没有扫码记录（如实告知用户，不要编造）"},
                             ensure_ascii=False))
            return 0
        res = save_records(a.supplier_id, [normalize(r) for r in raw_recs], raw_payload=payload)
        print(json.dumps({"ok": True, "remote": len(raw_recs), **res}, ensure_ascii=False))
        return 0
    if a.command == "list":
        rows = load_records(a.supplier_id)
        print(json.dumps({"total": len(rows), "records": rows[: a.limit]}, ensure_ascii=False, indent=1))
        return 0
    if a.command == "match":
        rows = load_records(a.supplier_id)
        print(json.dumps(match_huiji_huiyi(rows, mock=a.mock, limit=a.limit),
                         ensure_ascii=False, indent=1))
        return 0
    if a.command == "fetch-invitations":
        if a.mock:
            _, mock_invitations = _mock_data()
            recs = [normalize_invitation(r) for r in mock_invitations()]
            res = save_invitations(a.supplier_id, recs, raw_payload={"mock": True, "records": recs})
            print(json.dumps({"ok": True, "mock": True, **res}, ensure_ascii=False))
            return 0
        if not a.open_id or not a.supplier_id:
            print(json.dumps({"ok": False,
                              "error": "身份必须成对：--open-id 与 --supplier-id（缺一个就无法查，请向用户索取）"},
                             ensure_ascii=False))
            return 2
        payload = fetch_invitations_api(supplier_id=a.supplier_id, open_id=a.open_id,
                                        exhibition_id=a.exhibition_id,
                                        is_check_in=a.is_check_in, is_meeting=a.is_meeting,
                                        page_num=a.page_num, page_size=a.page_size)
        raw_recs, msg = _api_records(payload)
        if not raw_recs:
            print(json.dumps({"ok": True, "total_remote": 0, "added": 0, "msg": msg,
                              "note": "该身份下没有邀约记录（如实告知，不要编造）"}, ensure_ascii=False))
            return 0
        res = save_invitations(a.supplier_id, [normalize_invitation(r) for r in raw_recs],
                               raw_payload=payload)
        print(json.dumps({"ok": True, "remote": len(raw_recs), **res}, ensure_ascii=False))
        return 0
    if a.command == "crossmatch":
        scans = load_records(a.supplier_id)
        invites = load_invitations(a.supplier_id)
        if a.mock or not scans:
            mock_records, _ = _mock_data()
            scans = scans or [normalize(r) for r in mock_records(3)]
        if a.mock or not invites:
            _, mock_invitations = _mock_data()
            invites = invites or [normalize_invitation(r) for r in mock_invitations()]
        out = cross_match(scans, invites)
        out["ranked"] = out["ranked"][: a.limit]
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
