#!/usr/bin/env python3
# -- coding: UTF-8 --
"""dc_onsite_recommend.py — 展会现场「未邀约匹配买家」推荐

场景：展前已邀约一批买家（邀约名单），展会开展期间定时把「已到场、但没邀约、
且产品对路」的买家捞出来推荐，现场补枪。

流程：
  1. 确定当前正在开展的展会（orderRecords state=3 → selectAllExhibition 对账 inshow 日期）
  2. 拿产品词（企业画像 kb.json profile.products）
  3. 拉现场买家（buyer onsite --exhibition-id --keywords）
  4. 剔除已邀约（邀约名单 companyCdpId）
  5. 分层推荐（主推/跟进）+ 理由
  6. 简讯卡推群（复用 dc_notify routes chat_id）

触发：定时任务（展会期间当地时间 10:00 / 14:00 / 16:00），脚本内判断当天是否有
正在开展的展会，没有则 NO_RUN。

用法：
  python3 dc_onsite_recommend.py run [--company-id <sid>] [--dry-run] [--exhibition-id <id>]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

_XIAOYUAN = shutil.which("xiaoyuan") or "/opt/xiaoyuan-venv/bin/xiaoyuan"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _tenant_env import load_tenant_env

load_tenant_env()

try:
    from enterprise_ids import canonical_company_id
except ImportError:  # 兜底
    def canonical_company_id(cid: str) -> str:
        return (cid or "").strip() or os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()

try:
    from dc_notify import get_default_target
except ImportError:
    def get_default_target() -> str:
        return ""


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_yyyymmdd() -> str:
    return datetime.now().strftime("%Y%m%d")


def _xiaoyuan(*args: str) -> dict:
    cmd = [
        _XIAOYUAN,
        "--open-id", os.environ.get("MIO_V_OPEN_ID", ""),
        "--supplier-id", os.environ.get("MIO_CDP_SUPPLIER_ID", ""),
        *args,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    try:
        return json.loads(proc.stdout or proc.stderr)
    except Exception:
        return {"_raw": (proc.stdout or proc.stderr)[:500]}


# ── 1. 当前开展展会 ─────────────────────────────────────────────

def current_exhibitions() -> list[dict]:
    """orderRecords state=3 → selectAllExhibition 对账 → 今天正在开展的展会。"""
    info = _xiaoyuan("company", "info")
    order_records = (info.get("response", {}).get("data", {}) or {}).get("orderRecords") or []
    state3_ids = [r.get("sourceId") for r in order_records if r.get("state") == 3 and r.get("sourceId")]
    if not state3_ids:
        return []

    need = set(state3_ids)
    by_id = {}
    for page in range(1, 50):
        exh = _xiaoyuan("buyer", "exhibitions", "--page", str(page), "--size", "100")
        all_records = (exh.get("response", {}).get("data", {}) or {}).get("records") or []
        if not all_records:
            break
        for r in all_records:
            by_id[r.get("id")] = r
        if need.issubset(by_id):
            break

    today = _today_yyyymmdd()
    out = []
    for sid in dict.fromkeys(state3_ids):
        r = by_id.get(sid)
        if not r:
            continue
        inshow_start = (r.get("inshowStartDate") or "").strip()
        inshow_end = (r.get("inshowEndDate") or "").strip()
        if inshow_start and inshow_end and inshow_start <= today <= inshow_end:
            out.append({
                "exhibitionId": sid,
                "name": r.get("name") or r.get("nameCn") or "",
                "country": r.get("countryName") or "",
                "inshowStartDate": inshow_start,
                "inshowEndDate": inshow_end,
            })
    return out


# ── 2. 产品词 ───────────────────────────────────────────────────

def load_products(company_id: str) -> list[str]:
    p = _workspace_root() / "data" / "memory" / company_id / "kb.json"
    if not p.exists():
        return []
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []
    prof = d.get("profile", {}) or {}
    prods = prof.get("products") or prof.get("product") or []
    return [str(x).strip() for x in prods if str(x).strip()]


# ── 3. 现场买家 ─────────────────────────────────────────────────

def fetch_onsite(exhibition_id: str, keywords: list[str]) -> list[dict]:
    """buyer onsite 拉现场买家（字段对齐 buyer search）。"""
    kw = ",".join(keywords[:5]) if keywords else ""
    resp = _xiaoyuan("buyer", "onsite", "--exhibition-id", exhibition_id,
                     "--keywords", kw, "--page-size", "50")
    data = (resp.get("response", {}).get("data", {}) or {})
    recs = data.get("records") or []
    return recs if isinstance(recs, list) else []


# ── 4. 已邀约 ───────────────────────────────────────────────────

def load_invited_cdp_ids(company_id: str) -> set[str]:
    p = _workspace_root() / "data" / "memory" / company_id / "exhibition-invitations.json"
    if not p.exists():
        return set()
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return set()
    invs = d.get("invitations", []) if isinstance(d, dict) else []
    return {(r.get("companyCdpId") or "").strip() for r in invs if (r.get("companyCdpId") or "").strip()}


# ── 5. 分层推荐 + 理由 ─────────────────────────────────────────

# 买家类型 companyAttributes 枚举（对齐 buyer search）
ATTR_LABEL = {1: "生产商", 2: "分销商", 3: "零售商", 4: "品牌", 5: "商超"}


def classify(buyer: dict, keywords: list[str]) -> tuple[str, str]:
    """分层：主推 / 跟进；返回 (层级, 理由)。"""
    name = buyer.get("companyName") or "(未知)"
    country = buyer.get("countryCnName") or buyer.get("country") or buyer.get("countryEnName") or ""
    attrs = buyer.get("companyAttributes") or []
    size = buyer.get("newCompanySize") or buyer.get("companySize") or ""

    attr_label = ""
    if attrs:
        attr_label = "/".join(ATTR_LABEL.get(int(a), str(a)) for a in attrs if str(a).isdigit())

    reasons = []
    if keywords:
        reasons.append("产品对路")
    if attr_label:
        reasons.append(attr_label)
    if size:
        reasons.append(f"规模{size}")

    reason = (",".join(reasons) if reasons else "现场买家")
    tier = "主推" if (attr_label or size) else "跟进"
    return tier, f"{name}｜{country}｜{reason}"


# ── 6. 简讯卡推群 ───────────────────────────────────────────────

ONSITE_LIST_LIMIT = 5


def format_onsite_card(header: str, main: list[str], follow: list[str], limit: int = ONSITE_LIST_LIMIT) -> str:
    """现场推荐简讯卡文案（红线五.10：不刷屏）。

    ≤limit 家：主推 + 跟进逐条列出（现状不变）。
    >limit 家：收敛为「主推 N · 跟进 M（共 X）」总结 + 主推前 3 + 跟进前 2，
    其余只给数量，不逐条刷屏。现场推荐不落线索池、无表格链接，故收敛靠「重点 + 数量」而非链接。
    """
    total = len(main) + len(follow)
    if total <= limit:
        body: list[str] = []
        if main:
            body.append("【主推】")
            body.extend(main)
        if follow:
            body.append("【跟进】")
            body.extend(follow)
        if not body:
            return header
        return header + "\n" + "\n".join(body)

    body = [f"主推 {len(main)} 家 · 跟进 {len(follow)} 家（共 {total} 家）"]
    shown = 0
    if main:
        body.append("【主推】")
        body.extend(main[:3])
        shown += min(len(main), 3)
    if follow:
        body.append("【跟进】")
        body.extend(follow[:2])
        shown += min(len(follow), 2)
    if total > shown:
        body.append(f"… 其余 {total - shown} 家未逐条列出")
    return header + "\n" + "\n".join(body)


def send_card(chat_id: str, text: str, dry_run: bool = False) -> bool:
    if not chat_id:
        print("[dc_onsite_recommend] 缺 chat_id，跳过推群", file=sys.stderr)
        return False
    cmd = ["lark-cli", "im", "+messages-send", "--as", "bot",
           "--chat-id", chat_id, "--text", text]
    if dry_run:
        print("[dry-run] " + " ".join(cmd))
        return True
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return True
    except Exception as e:
        print(f"[dc_onsite_recommend] 推群失败: {e}", file=sys.stderr)
        return False


# ── 主流程 ──────────────────────────────────────────────────────

def run(args) -> dict:
    company_id = canonical_company_id(args.company_id)
    if not company_id:
        raise SystemExit("[dc_onsite_recommend] 无法确定企业 ID")

    # 确定当前开展展会
    if args.exhibition_id:
        exhs = [{"exhibitionId": args.exhibition_id, "name": "", "country": "",
                 "inshowStartDate": "", "inshowEndDate": ""}]
    else:
        exhs = current_exhibitions()
    if not exhs:
        print("NO_RUN")
        return {"action": "onsite_recommend", "status": "no_exhibition", "count": 0}

    keywords = load_products(company_id)
    invited = load_invited_cdp_ids(company_id)
    chat_id = (args.chat_id or get_default_target() or "").strip()

    results = []
    for exh in exhs:
        buyers = fetch_onsite(exh["exhibitionId"], keywords)
        candidates = [b for b in buyers if (b.get("companyCdpid") or b.get("companyCdpId") or "").strip() not in invited]
        lines = []
        main, follow = [], []
        for b in candidates:
            tier, line = classify(b, keywords)
            (main if tier == "主推" else follow).append(line)
        if main or follow:
            header = f"📥 现场未邀约匹配买家（{exh.get('name') or exh['exhibitionId']}）"
            text = format_onsite_card(header, main, follow)
            send_card(chat_id, text, dry_run=args.dry_run)
            results.append({"exhibitionId": exh["exhibitionId"], "candidates": len(candidates),
                            "main": len(main), "follow": len(follow)})

    return {"action": "onsite_recommend", "company_id": company_id,
            "exhibitions": len(exhs), "results": results}


def main() -> None:
    p = argparse.ArgumentParser(description="小元-展会现场未邀约匹配买家推荐")
    p.add_argument("action", choices=["run"], help="执行推荐")
    p.add_argument("--company-id", default=None, help="企业 ID（缺省读 MIO_CDP_SUPPLIER_ID）")
    p.add_argument("--exhibition-id", default="", help="指定展会 ID（跳过自动判断当前展会）")
    p.add_argument("--chat-id", default="", help="群 chat_id（缺省读 dc_notify routes default）")
    p.add_argument("--dry-run", action="store_true", help="只打印不执行")
    args = p.parse_args()

    result = run(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
