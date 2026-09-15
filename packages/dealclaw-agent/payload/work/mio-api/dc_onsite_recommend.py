#!/usr/bin/env python3
# -- coding: UTF-8 --
"""dc_onsite_recommend.py — 展会现场「未邀约匹配买家」推荐

场景：展前已邀约一批买家（邀约名单），展会开展期间定时把「已到场、但没邀约、
且产品对路」的买家捞出来推荐，现场补枪。

流程：
  1. 确定当前正在开展的展会（orderRecords state=3 → selectAllExhibition 对账 inshow 日期）
  2. 拿产品词（企业画像 kb.json profile.products）
  3. 拉现场买家（buyer onsite --exhibition-id --keywords）
  4. 剔除已邀约（邀约名单 companyCdpId）+ 剔除 excluded（黑名单/明确拒绝，排除不落）
  5. 分层推荐（主推/跟进）+ 理由
  6. 落本展会线索池（来源「展中推荐」，与企业主池分开）
  7. 分批气泡推群（复用 dc_notify routes chat_id；明细分批全发，不折叠；总>10 先发汇总+池入口）

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

# 落池基建（每届展会一个独立池）复用企业线索池的 ensure / sync 写路径
try:
    import dc_company_registry as dcr
except ImportError:  # 兔底：无基建时不落池，明细不受影响
    dcr = None

# 展后推荐的「不再推荐」判定（denied / blacklisted / 明确拒绝等），现场落池复用同一口径
try:
    from dc_after_exhibition_recommend import is_suppressed as _is_recommend_suppressed
except ImportError:
    def _is_recommend_suppressed(buyer: dict) -> bool:
        return False


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


def _buyer_facts(buyer: dict, keywords: list[str]) -> dict:
    """现场买家 → 展示行与落池共用的事实（公司名/国家/类型/规模/理由/CDP/官网）。

    展示行与落池必须同源，否则会出现「气泡里有理由、池里没理由」这类漂移。
    """
    attrs = buyer.get("companyAttributes") or []
    attr_label = ""
    if attrs:
        attr_label = "/".join(ATTR_LABEL.get(int(a), str(a)) for a in attrs if str(a).isdigit())
    size = buyer.get("newCompanySize") or buyer.get("companySize") or ""

    reasons = []
    if keywords:
        reasons.append("产品对路")
    if attr_label:
        reasons.append(attr_label)
    if size:
        reasons.append(f"规模{size}")

    return {
        "name": buyer.get("companyName") or "",
        "country": (buyer.get("countryCnName") or buyer.get("country")
                    or buyer.get("countryEnName") or ""),
        "attr_label": attr_label,
        "size": str(size or ""),
        "reason": (",".join(reasons) if reasons else "现场买家"),
        "cdp": str(buyer.get("companyCdpId") or buyer.get("companyCdpid") or "").strip(),
        "website": str(buyer.get("website") or buyer.get("domain") or "").strip(),
    }


def classify(buyer: dict, keywords: list[str]) -> tuple[str, str]:
    """分层：主推 / 跟进；返回 (层级, 展示行)。"""
    f = _buyer_facts(buyer, keywords)
    tier = "主推" if (f["attr_label"] or f["size"]) else "跟进"
    name = f["name"] or "(未知)"
    return tier, f"{name}｜{f['country']}｜{f['reason']}"


# ── 6. 展中推荐落池（每届展会一个独立池）───────────────────

ONSITE_POOL_SOURCE = "展中推荐"
ONSITE_POOL_STAGE = "现场对接中"
POOL_LINK_PREFIX = "📊 本展会线索池："

# 现场买家 companyAttributes → 线索池「买家类型」枚举。
# 池选项只有 品牌商/制造商/经销商/工程商；现场的 生产商/零售商/商超 必须收敛，
# 否则 select 写不进（收敛是有损的：展示行仍保留细粒度标签）。
ATTR_TO_POOL_TYPE = {1: "制造商", 2: "经销商", 3: "经销商", 4: "品牌商", 5: "经销商"}

# 邀约状态「已拒绝」= 明确拒绝（字段名沿用接口原文，见 dealclaw/init-data-mapping.md）
ONSITE_REFUSED_INVITATION_STATES = ("3",)


def is_excluded_from_onsite(buyer: dict) -> bool:
    """排除不落铁律：黑名单 / 明确拒绝 / 人工排除 → 不推、不落池。

    复用展后推荐的 SUPPRESSED_FIELDS（denied / identity_mismatch / cancelled /
    blacklisted / historical_suppressed / manual_excluded），另加邀约状态 3=已拒绝。
    """
    if _is_recommend_suppressed(buyer):
        return True
    for key in ("inviationState", "invitationState"):
        if str(buyer.get(key) or "").strip() in ONSITE_REFUSED_INVITATION_STATES:
            return True
    return False


def _pool_buyer_type(buyer: dict) -> str:
    """companyAttributes → 池枚举（多值时取第一个能映射的）。"""
    for raw in (buyer.get("companyAttributes") or []):
        if str(raw).isdigit():
            mapped = ATTR_TO_POOL_TYPE.get(int(raw))
            if mapped:
                return mapped
    return ""


def _pool_products(buyer: dict) -> list[str]:
    tags = (buyer.get("purchaseTags") or buyer.get("productList")
            or buyer.get("products") or buyer.get("关注产品") or [])
    if isinstance(tags, str):
        tags = [x.strip() for x in tags.replace("，", ",").split(",") if x.strip()]
    out: list[str] = []
    for tag in tags:
        text = str(tag.get("name", "") if isinstance(tag, dict) else tag).strip()
        if text and text not in out:
            out.append(text)
    return out[:20]


def onsite_pool_record(buyer: dict, keywords: list[str]) -> "dict | None":
    """现场买家 → 展中推荐线索池字段；无名且无官网则不落（无法幂等去重，返回 None）。

    字段名用池原生名（dc_company_registry._record_fields 已支持池原生入参）；
    阶段「现场对接中」不在 SEARCH_OWNED_FIELDS 里 → 用户手改的阶段不会被后续 update 覆盖。
    """
    facts = _buyer_facts(buyer, keywords)
    name = str(facts["name"] or "").strip()
    website = str(facts["website"] or "").strip()
    if not name and not website:
        return None
    record = {
        "公司名": name,
        "官网": website,
        "公司CDPID": facts["cdp"],
        "国家": facts["country"],
        "推荐理由": facts["reason"],
        "来源": ONSITE_POOL_SOURCE,
        "阶段": ONSITE_POOL_STAGE,
    }
    pool_type = _pool_buyer_type(buyer)
    if pool_type:
        record["买家类型"] = pool_type
    products = _pool_products(buyer)
    if products:
        record["匹配产品"] = products
    return record


def land_onsite_leads(company_id: str, exhibition: dict, buyers: list,
                      keywords: list[str], *, chat_id: str = "",
                      dry_run: bool = False) -> dict:
    """本场推荐落进「本届展会」独立线索池（幂等、排除不落）。

    返回（不抛）：title / url / records / unnamed / created / updated / skipped；
    error：落池失败摘要——**落池失败不影响明细推送**。
    """
    exhibition_id = str(exhibition.get("exhibitionId") or "").strip()
    exhibition_name = str(exhibition.get("name") or "").strip()
    out = {
        "source": ONSITE_POOL_SOURCE,
        "stage": ONSITE_POOL_STAGE,
        "exhibition_id": exhibition_id,
        "exhibition_name": exhibition_name,
        "title": "", "url": "",
        "records": 0, "unnamed": 0,
        "created": 0, "updated": 0, "skipped": 0,
    }
    if dcr is not None:
        try:
            out["title"] = dcr.exhibition_pool_title(exhibition_name, exhibition_id)
        except ValueError:
            pass
    records = []
    for buyer in buyers or []:
        record = onsite_pool_record(buyer, keywords)
        if record is None:
            out["unnamed"] += 1
            continue
        records.append(record)
    out["records"] = len(records)
    if dcr is None or not records:
        return out
    if dry_run:
        out["skipped"] = len(records)
        out["dry_run"] = True
        return out
    try:
        result = dcr.sync_exhibition_leads_to_pool(
            company_id, exhibition_id, records,
            exhibition_name=exhibition_name, chat_id=chat_id,
        )
    except Exception as e:  # noqa: BLE001 — 落池失败绝不吞掉明细推送
        out["error"] = f"{type(e).__name__}: {e}"[:300]
        return out
    out.update({
        "url": result.get("bitable_url") or "",
        "created": result.get("created", 0),
        "updated": result.get("updated", 0),
        "skipped": result.get("skipped", 0),
        "duplicates": result.get("duplicates", 0),
    })
    return out


# ── 7. 分批气泡推群 ─────────────────────────────────────────────

# 2026-09-15 田耕郡现场实测：49 条被折叠成摘要、明细丢失。
# 新口径（红线五.10 修订）：明细永不省略 —— 按优先级分批逐条全发，每批 ≤ ONSITE_BATCH_SIZE 条；
# 总量 > ONSITE_SUMMARY_THRESHOLD（同日由 30 收到 10）时先补一条汇总气泡，随后仍把全部明细分批补齐；
# 本展会线索池入口跟汇总气泡走（≤阈值时挂末条明细气泡）。
ONSITE_BATCH_SIZE = 10
ONSITE_SUMMARY_THRESHOLD = 10


def _onsite_entries(main: list[str], follow: list[str]) -> list[tuple[str, str]]:
    """(层级, 明细行)：主推在前、跟进在后，保持调用方给定的优先级顺序。"""
    return [("主推", line) for line in main] + [("跟进", line) for line in follow]


def build_onsite_bubbles(header: str, main: list[str], follow: list[str],
                         batch_size: int = ONSITE_BATCH_SIZE,
                         summary_threshold: int = ONSITE_SUMMARY_THRESHOLD,
                         pool_url: str = "") -> list[str]:
    """现场推荐气泡列表（可多条）：分批逐条列全明细，禁止折叠丢明细。

    - 顺序：主推在前、跟进在后（调用方已按优先级排序），切批不重排、不去重。
    - 每批 ≤ batch_size 条，逐条列出（沿用「公司名｜国家｜理由」现有行格式）。
    - 总量 > summary_threshold：首条为汇总气泡（总数 / 主推·跟进 / Top 亮点）+ 池入口，
      随后仍是**全部**明细批次——汇总只是补充，不替代明细。
    - pool_url 非空时入口必给：有汇总就放汇总里；没有汇总（≤阈值）就挂末条气泡末尾。
    - 无名单返回 []（调用方不推气泡）。
    """
    entries = _onsite_entries([str(x) for x in (main or [])], [str(x) for x in (follow or [])])
    total = len(entries)
    if total == 0:
        return []
    if batch_size < 1:
        raise ValueError("batch_size must be >= 1")
    main_count = sum(1 for tier, _ in entries if tier == "主推")
    follow_count = total - main_count
    batches = [entries[i:i + batch_size] for i in range(0, total, batch_size)]
    link_line = f"{POOL_LINK_PREFIX}{pool_url}" if pool_url else ""

    bubbles: list[str] = []
    if total > summary_threshold:
        summary = [
            header,
            f"主推 {main_count} 家 · 跟进 {follow_count} 家（共 {total} 家）",
            f"全部明细分 {len(batches)} 批逐条发出，不省略：",
        ]
        highlights = [line for _, line in entries[:3]]
        if highlights:
            summary.append("【Top 亮点】")
            summary.extend(highlights)
        if link_line:
            summary.append(link_line)
        bubbles.append("\n".join(summary))

    for index, batch in enumerate(batches, 1):
        body: list[str] = [header]
        if len(batches) > 1:
            body.append(f"（第 {index}/{len(batches)} 批 · 共 {total} 家）")
        current = None
        for tier, line in batch:
            if tier != current:
                body.append(f"【{tier}】")
                current = tier
            body.append(line)
        bubbles.append("\n".join(body))

    if link_line and total <= summary_threshold:
        # 没有汇总气泡也不能丢池入口：挂到末条气泡末尾（明细行格式不变）
        bubbles[-1] = bubbles[-1] + "\n" + link_line
    return bubbles


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
        # 排除不落铁律：黑名单/明确拒绝不推也不落池
        survivors = [b for b in candidates if not is_excluded_from_onsite(b)]
        excluded = len(candidates) - len(survivors)
        main, follow = [], []
        for b in survivors:
            tier, line = classify(b, keywords)
            (main if tier == "主推" else follow).append(line)
        pool = land_onsite_leads(company_id, exh, survivors, keywords,
                                 chat_id=chat_id, dry_run=args.dry_run)
        if pool.get("error"):
            print(f"[dc_onsite_recommend] 落池失败（明细照推）: {pool['error']}", file=sys.stderr)
        if main or follow or excluded:
            header = f"📥 现场未邀约匹配买家（{exh.get('name') or exh['exhibitionId']}）"
            bubbles = build_onsite_bubbles(header, main, follow, pool_url=pool.get("url") or "")
            sent = sum(1 for text in bubbles if send_card(chat_id, text, dry_run=args.dry_run))
            results.append({"exhibitionId": exh["exhibitionId"], "candidates": len(candidates),
                            "main": len(main), "follow": len(follow),
                            "excluded": excluded, "bubbles": len(bubbles), "sent": sent,
                            "pool": pool})

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
