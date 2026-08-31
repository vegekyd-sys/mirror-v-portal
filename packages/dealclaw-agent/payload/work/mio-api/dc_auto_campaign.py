#!/usr/bin/env python3
"""
DC-Auto-Campaign — 无 campaign 时从 CDP 动态创建展会 Campaign。

流程（两个接口对账）：
  1. getBasicInfo(supplier_id)     → orderRecords（state=3 = 当前有效订单）
  2. selectAllExhibition           → 全量展会目录
  3. 按 sourceId 对账              → 拿 inshowStartDate（开展日，orderRecords 无此字段）
  4. 选「最近一场即将开展的展会」   → inshowStartDate >= today 的最小者
  5. create_campaign(company_id, exhibition_name, exhibition_date)

关键坑：orderRecords 只有 preshowStartDate/aftershowEndDate，真正的开展日
inshowStartDate 只能在 selectAllExhibition 里按 sourceId 对账拿到。
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

DEFAULT_BASE_URL = "https://micro.tradechina.com/blade-agent-adapter"


def _load_env() -> None:
    """从当前目录及上级目录加载 .env（不覆盖已有环境变量）。"""
    try:
        from _tenant_env import load_tenant_env
        load_tenant_env()
    except ImportError:
        pass
    dirs = []
    d = os.path.dirname(os.path.abspath(__file__))
    while d and d != os.path.dirname(d):
        dirs.append(d)
        d = os.path.dirname(d)
    for d in dirs:
        f = os.path.join(d, ".env")
        if os.path.exists(f):
            with open(f, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        if k not in os.environ:
                            os.environ[k] = v.strip()


def env(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    return v.strip() if v else default


# 模块导入即加载 .env（供 dc_daily_cycle 等 import 方使用，避免 open_id 为空）
_load_env()


def _post(base_url: str, path: str, body: dict, open_id: str, supplier_id: str,
          timeout: int = 60) -> dict:
    url = base_url.rstrip("/") + path
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, method="POST", data=payload,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "X-Feishu-Open-Id": open_id.strip(),
            "X-Supplier-Id": supplier_id.strip(),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        return {"success": False, "code": e.code, "msg": f"HTTP {e.code}",
                "errorBody": e.read().decode("utf-8", errors="replace")[:300]}
    except urllib.error.URLError as e:
        return {"success": False, "code": -1, "msg": f"网络错误: {e.reason}"}


def get_basic_info(supplier_id: str, open_id: str = "",
                   base_url: str = DEFAULT_BASE_URL, timeout: int = 60) -> dict:
    resp = _post(base_url, "/agent/company/getBasicInfo.json", {}, open_id, supplier_id, timeout)
    data = resp.get("data")
    return data if isinstance(data, dict) else {}


def get_exhibitions(supplier_id: str, open_id: str = "",
                    base_url: str = DEFAULT_BASE_URL, timeout: int = 60) -> list[dict]:
    """拉全量展会目录（selectAllExhibition）。尽量一页拿全。"""
    all_recs: list[dict] = []
    for page in (1, 2, 3, 4, 5):
        resp = _post(base_url, "/agent/buyer/selectAllExhibition.json",
                     {"page": page, "size": 200}, open_id, supplier_id, timeout)
        data = resp.get("data")
        recs: list[dict] = []
        if isinstance(data, dict):
            for k in ("records", "list", "data", "rows", "content"):
                if isinstance(data.get(k), list):
                    recs = data[k]
                    break
        elif isinstance(data, list):
            recs = data
        if not recs:
            break
        all_recs.extend(recs)
        # 返回数小于 size 说明已到末页
        total = data.get("total") if isinstance(data, dict) else None
        if len(recs) < 200:
            break
        if total is not None and len(all_recs) >= int(total):
            break
    return all_recs


def _yyyymmdd_to_date(s) -> str:
    s = (s or "").strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return s


def pick_nearest(order_records: list[dict], exhibitions: list[dict]) -> dict | None:
    """从 state=3 订单里挑「最近一场即将开展的展会」。

    返回 {inshow, name, source_id, country, ex, rec} 或 None。
    """
    by_id = {str(e.get("id")): e for e in exhibitions if e.get("id")}
    today = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
    candidates: list[dict] = []
    for rec in order_records:
        if rec.get("state") != 3:
            continue
        sid = str(rec.get("sourceId", ""))
        ex = by_id.get(sid)
        inshow = _yyyymmdd_to_date(ex.get("inshowStartDate")) if ex else ""
        if (not inshow or len(inshow) != 10):
            # 无开展日 → 兜底用 orderRecords.preshowStartDate
            inshow = _yyyymmdd_to_date(rec.get("preshowStartDate"))
        if not inshow or len(inshow) != 10:
            continue
        name = (rec.get("supplierShowName") or rec.get("exhibitionName")
                or (ex.get("nameCn") if ex else "") or (ex.get("name") if ex else ""))
        candidates.append({
            "inshow": inshow,
            "name": name.strip(),
            "source_id": sid,
            "country": rec.get("websiteCountry", ""),
            "ex": ex or {},
            "rec": rec,
        })
    if not candidates:
        return None
    upcoming = [c for c in candidates if c["inshow"] >= today]
    if upcoming:
        return min(upcoming, key=lambda c: c["inshow"])
    return max(candidates, key=lambda c: c["inshow"])


def ensure_campaign(company_id: str, supplier_id: str = "", open_id: str = "",
                    base_url: str = DEFAULT_BASE_URL, timeout: int = 60,
                    dry_run: bool = False) -> dict:
    """无 active campaign 时，动态创建；有则返回现有。"""
    from dc_campaign import get_active_campaign, create_campaign

    camp = get_active_campaign(company_id)
    if camp:
        return {"status": "existing", "campaign": camp}

    supplier_id = (supplier_id or company_id or env("MIO_CDP_SUPPLIER_ID")).strip()
    open_id = open_id or env("MIO_V_OPEN_ID")
    if not supplier_id:
        return {"status": "no_data", "reason": "supplier_id 为空"}

    basic = get_basic_info(supplier_id, open_id, base_url, timeout)
    recs = basic.get("orderRecords") or []
    state3 = [r for r in recs if r.get("state") == 3]
    if not state3:
        return {"status": "no_data", "reason": f"orderRecords 无 state=3 订单（共 {len(recs)} 条）",
                "company_name": basic.get("companyName", ""),
                "company_name_en": basic.get("companyNameEn", "")}

    exs = get_exhibitions(supplier_id, open_id, base_url, timeout)
    chosen = pick_nearest(recs, exs)
    if not chosen:
        return {"status": "no_data", "reason": "无法对账到开展日（selectAllExhibition 缺 sourceId 对应展会）",
                "state3_count": len(state3), "exhibition_count": len(exs)}

    if dry_run:
        return {"status": "dry_run", "would_create": {
            "company_id": company_id, "exhibition_name": chosen["name"],
            "exhibition_date": chosen["inshow"], "source_id": chosen["source_id"],
            "country": chosen["country"],
        }}

    result = create_campaign(
        company_id=company_id,
        exhibition_name=chosen["name"],
        exhibition_date=chosen["inshow"],
        target_invites=0,
        target_meetings=0,
        automation_scope="research_only",
        buyer_profile_confirmed=False,
        current_strategy="auto",
        owner_open_id="",
    )
    if result.get("status") == "error":
        return {"status": "error", "reason": result.get("error", "")}
    return {"status": "created", "campaign": result}


def _cli() -> None:
    _load_env()
    p = argparse.ArgumentParser(description="DC-Auto-Campaign 动态建 Campaign")
    p.add_argument("--company-id", default=env("MIO_CDP_SUPPLIER_ID"))
    p.add_argument("--supplier-id", default="")
    p.add_argument("--open-id", default=env("MIO_V_OPEN_ID"))
    p.add_argument("--base-url", default=env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL))
    p.add_argument("--timeout", type=int, default=60)
    p.add_argument("--dry-run", action="store_true", help="只探测不真正创建")
    args = p.parse_args()
    if not args.company_id:
        raise SystemExit("缺少 --company-id")
    result = ensure_campaign(
        company_id=args.company_id, supplier_id=args.supplier_id,
        open_id=args.open_id, base_url=args.base_url, timeout=args.timeout,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    _cli()
