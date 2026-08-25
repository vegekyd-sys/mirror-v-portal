#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""exhibition_assistant.py — 智能展前助手卡片（每日，动态建议）

每天 cron 触发，给每个「确认参展」的企业发一张卡片，内容结合业务状态动态生成：
  - 倒计时（距开展天数）
  - 邀约进度（本届展会推荐邀约买家数 vs 已邀约企业数，按企业去重）
  - 买家跟进（回复 / 会议意向，来自七信号）
  - 今日建议（结合邀约进度 + 剩余天数动态算）
  - 展前准备清单（物料缺口，缺失的提示可让 AI 帮做）

参展信息多源融合，优先级：meta.json exhibitions（用户输入）> 知识库 profile > orderRecords(state=3)。

用法:
  python3 exhibition_assistant.py [supplier_id ...]     # 遍历/指定企业，DRY_RUN=1 只打印卡片
  python3 exhibition_assistant.py report <sid> --name 展会名 --start 2026-09-08 [--end ... --city ... --venue ... --sector ... --country ... --name-en ...]

meta.json 手动录入入口 = exhibitions 数组，字段（report 子命令原子写，多源融合时优先于 CDP）：
  name      展会中文名（必填）
  name_en   展会英文名（选填）
  start     开展日 YYYY-MM-DD 或 YYYYMMDD（必填）
  end       闭展日（选填，缺省=开展日）
  city      城市/国家（选填，英文）
  country   国家（选填，中文）
  venue     展馆（选填）
  sector    品类/行业（选填）
  recommended_buyers  推荐邀约买家数（选填，默认 0）
  source    来源标记（自动写 user_input，勿手填）
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, date
from pathlib import Path
from zoneinfo import ZoneInfo

WS = Path(__file__).resolve().parents[1]          # dealclaw workspace
MEM = WS / "data" / "memory"
ENV_FILE = WS / "work" / "mio-api" / ".env"

sys.path.insert(0, str(WS / "work" / "mio-api"))
from dc_exhibition_stage import (  # noqa: E402
    STAGE_LABELS, STAGES, stage_next_step, read_stage, set_stage,
)

MATERIAL_LABELS = {
    "catalog": "产品手册/目录", "price": "报价单", "spec": "技术规格书",
    "certificate": "认证证书", "sample": "样品/实拍",
}


def _load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k, v.strip())


def _env(name, default=""):
    return os.environ.get(name, default).strip()


def _today() -> date:
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


# ── 参展信息（多源融合）──────────────────────────────────
def get_meta(supplier_id: str) -> dict:
    p = MEM / supplier_id / "meta.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _norm_date(s) -> str:
    """yyyyMMdd / yyyy-MM-dd / yyyy/MM/dd / yyyy/M/d → yyyy-MM-dd；无法解析返回空串。"""
    s = (s or "").strip()
    if not s:
        return ""
    if re.fullmatch(r"\d{8}", s):
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    s = s.replace("/", "-").replace(".", "-")
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            date(y, mo, d)
            return f"{y:04d}-{mo:02d}-{d:02d}"
        except ValueError:
            return ""
    return ""


def _normalize_exhibition(e: dict) -> dict | None:
    """把用户输入/历史记录归一化成统一字段（与 order_records 对齐）。name+start 无法解析则返回 None。"""
    if not isinstance(e, dict):
        return None
    start = _norm_date(e.get("start") or e.get("inshowStartDate") or e.get("preshowStartDate") or "")
    if not start:
        return None
    name = (e.get("name") or e.get("nameCn") or e.get("exhibitionName")
            or e.get("supplierShowName") or "").strip()
    if not name:
        return None
    end = _norm_date(e.get("end") or e.get("inshowEndDate") or "")
    if not end or end < start:
        end = start
    return {
        "name": name,
        "name_en": (e.get("name_en") or e.get("nameEn") or "").strip(),
        "start": start,
        "end": end,
        "city": (e.get("city") or e.get("country") or e.get("websiteCountry") or "").strip(),
        "venue": (e.get("venue") or e.get("location") or "").strip(),
        "sector": (e.get("sector") or e.get("industries") or "").strip(),
        "country": (e.get("country") or "").strip(),
        "recommended_buyers": int(e.get("recommended_buyers") or 0),
        "source": e.get("source") or "user_input",
    }


def _from_meta(supplier_id: str) -> list[dict]:
    out = []
    for e in get_meta(supplier_id).get("exhibitions", []):
        n = _normalize_exhibition(e)
        if n:
            out.append(n)
    return out


def add_exhibition(supplier_id: str, exh: dict) -> dict:
    """向 meta.json 写入/更新一条参展信息。按 (start, name) 去重覆盖，按 start 排序，临时文件原子替换。"""
    n = _normalize_exhibition(exh)
    if not n:
        return {"ok": False, "error": "缺少 name 或 start，或日期格式无法解析（支持 YYYY-MM-DD / YYYYMMDD）"}
    p = MEM / supplier_id / "meta.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    meta = get_meta(supplier_id)
    merged: dict = {}
    for e in meta.get("exhibitions", []):
        nn = _normalize_exhibition(e)
        if nn:
            merged[(nn["start"], nn["name"])] = nn
    merged[(n["start"], n["name"])] = n
    exhs = sorted(merged.values(), key=lambda e: (e["start"], e["name"]))
    meta["exhibitions"] = exhs
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return {"ok": True, "exhibition": n, "total": len(exhs), "file": str(p)}


def _from_kb(supplier_id: str) -> list[dict]:
    """知识库 profile 里的参展信息（target_markets 里带展会信息的兜底，很弱）。"""
    try:
        sys.path.insert(0, str(WS / "work" / "mio-api"))
        from dc_kb_engine import KBEngine
        kb = KBEngine()._load(supplier_id)
        p = (kb or {}).get("profile", {})
        # 知识库暂不结构化存参展计划；这里返回空，靠 meta.json 或 orderRecords。
        return []
    except Exception:
        return []


def _from_order_records(supplier_id: str, open_id: str) -> list[dict]:
    """orderRecords state=3 → selectAllExhibition 对账拿开展日。"""
    try:
        sys.path.insert(0, str(WS / "work" / "mio-api"))
        from dc_auto_campaign import get_basic_info, get_exhibitions, pick_nearest
        basic = get_basic_info(supplier_id, open_id=open_id)
        recs = basic.get("orderRecords", [])
        exs = get_exhibitions(supplier_id, open_id=open_id)
        chosen = pick_nearest(recs, exs)
        if not chosen:
            return []
        start = chosen["inshow"]
        end = chosen.get("ex", {}).get("inshowEndDate") or ""
        end = f"{end[0:4]}-{end[4:6]}-{end[6:8]}" if len(end) == 8 else start
        return [{
            "name": chosen["name"], "name_en": chosen.get("ex", {}).get("name", ""),
            "start": start, "end": end,
            "city": chosen.get("country", ""),
            "venue": chosen.get("ex", {}).get("location", ""),
            "sector": chosen.get("ex", {}).get("industries", ""),
            "recommended_buyers": 0, "source": "order_records",
        }]
    except Exception:
        return []


def resolve_exhibitions(supplier_id: str, open_id: str = "") -> list[dict]:
    exhs = _from_meta(supplier_id)
    if exhs:
        return exhs
    exhs = _from_kb(supplier_id)
    if exhs:
        return exhs
    return _from_order_records(supplier_id, open_id)


# ── 业务状态 ──────────────────────────────────────────────
def invite_progress(supplier_id: str) -> dict:
    """已邀约企业数（按线索池公司名去重，一个公司多个联系人/多封邮件算一家）+ 回复/会议意向。"""
    try:
        import re
        sys.path.insert(0, str(WS / "work" / "mio-api"))
        from email_gateway.store import EmailStore
        from dc_email_controller.dc_email_signals import list_signals
        from dc_memory_data import read_leads
        s = EmailStore()
        outs = s.list_outbound_records(company_id=supplier_id)
        # 建 邮箱 -> 公司名 映射（线索池公司名 = 企业唯一标识）
        email_to_company = {}
        for l in read_leads(supplier_id):
            company = (l.get("company") or "").strip()
            if not company:
                continue
            for e in re.findall(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}", str(l.get("contact", ""))):
                email_to_company.setdefault(e.lower(), company)
        companies = set()
        for o in outs:
            for r in o.get("recipients", []):
                e = str(r).strip().lower()
                if "@" not in e:
                    continue
                d = e.split("@")[-1]
                if d.endswith(("dealclaw.io", "meorient.com")):
                    continue
                c = email_to_company.get(e)
                companies.add(c if c else d)  # 无映射兑底用域名，避免漏计
        sigs = list_signals(supplier_id)
        replied = sum(1 for x in sigs if x.get("signal_type") in
                      ("quote_request", "sample_request", "meeting_interest", "missing_info"))
        meeting = sum(1 for x in sigs if x.get("signal_type") == "meeting_interest")
        return {"invited": len(companies), "outbound": len(outs),
                "replied": replied, "meeting": meeting}
    except Exception:
        return {"invited": 0, "outbound": 0, "replied": 0, "meeting": 0}


def material_status(supplier_id: str) -> dict:
    try:
        sys.path.insert(0, str(WS / "work" / "mio-api"))
        from dc_memory_data import read_materials
        mats = read_materials(supplier_id) or {}
        missing = [t for t in MATERIAL_LABELS if mats.get(t, {}).get("status") != "ready"]
        ready = [t for t in MATERIAL_LABELS if mats.get(t, {}).get("status") == "ready"]
        return {"missing": missing, "ready": ready}
    except Exception:
        return {"missing": list(MATERIAL_LABELS), "ready": []}


# ── 建议 + 卡片 ───────────────────────────────────────────
def build_advice(exh: dict, days: int, prog: dict, mats: dict, stage: str = "profiling") -> list[str]:
    rec = int(exh.get("recommended_buyers") or 0)
    lines = []
    step = stage_next_step(stage, invited=prog["invited"], rec=rec, days=days)
    if step:
        lines.append("下一步：" + step)
    if mats["missing"]:
        labels = "、".join(MATERIAL_LABELS[t] for t in mats["missing"][:3])
        lines.append(f"展前物料还缺：{labels}（小元可帮做）")
    if not lines:
        lines.append("展会临近，请确认展品清单与行程安排")
    return lines


def build_card(exh: dict, today: date, prog: dict, mats: dict, company: str, stage: str = "profiling") -> dict:
    start = datetime.strptime(exh["start"], "%Y-%m-%d").date()
    days = (start - today).days
    if days <= 0:
        return None

    rec = int(exh.get("recommended_buyers") or 0)
    venue = exh.get("venue", "")
    city = exh.get("city", "")
    loc = venue or city
    if city and venue and city.strip() and venue.strip() and city.strip() not in venue:
        loc = f"{venue}（{city}）"
    lines = [
        "**%s**" % exh["name"],
        "展会时间：%s - %s" % (exh["start"], exh["end"]),
        "地点：%s" % loc,
        "品类：%s" % exh.get("sector", ""),
        "当前阶段：%s" % STAGE_LABELS.get(stage, stage),
        "",
        "**📊 邀约进度**：已邀约 %d 家 · 确认到展 %d 家（累计发送 %d 封）" % (prog["invited"], prog["meeting"], prog["outbound"]),
        "",
        "**今日建议**",
    ]
    lines += ["· " + a for a in build_advice(exh, days, prog, mats, stage)]
    lines += ["", "**📋 展前准备**"]
    for t, label in MATERIAL_LABELS.items():
        mark = "✅" if t in mats["ready"] else "⬜"
        lines.append(f"{mark} {label}")
    if mats["missing"]:
        lines.append("缺失物料小元可帮你生成")

    title = "⏰ 距展会开展还有 %d 天" % days
    card = {
        "msg_type": "interactive",
        "card": {
            "header": {"template": "blue",
                       "title": {"tag": "plain_text", "content": title}},
            "elements": [
                {"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(lines)}},
                {"tag": "hr"},
                {"tag": "note", "elements": [{"tag": "plain_text",
                                              "content": "%s · 展前助手 · %s" % (company, today.isoformat())}]},
            ],
        },
    }
    return card


def post_card(chat_id: str, card: dict) -> str:
    """发卡片到群：lark-cli bot + chat_id + interactive。

    build_card 返回 {"msg_type":"interactive","card":{...}}；--content 只传 card 内容
    （config/header/elements），msg_type 由 --msg-type 单独指定。无明文 webhook。
    """
    content = card.get("card", card)
    cmd = ["lark-cli", "im", "+messages-send", "--as", "bot",
           "--chat-id", chat_id, "--msg-type", "interactive",
           "--content", json.dumps(content, ensure_ascii=False)]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return (p.stdout or p.stderr or "").strip()


def discover_companies() -> list:
    """遍历已绑定企业：data/buyer-leads-v10/*.json 的 binding。

    返回 [(supplier_id, chat_id, company_name)]，只取 status=active。
    企业 → 群 chat_id 的唯一权威来源。
    """
    lead_dir = WS / "data" / "buyer-leads-v10"
    out = []
    if not lead_dir.exists():
        return out
    for f in sorted(lead_dir.glob("*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("status") != "active":
            continue
        b = d.get("binding") or {}
        sid = str(b.get("tradechina_supplier_id") or "").strip()
        cid = str(b.get("chat_id") or d.get("chat_id") or "").strip()
        name = str(b.get("company_name") or d.get("label") or "").strip()
        if sid and cid:
            out.append((sid, cid, name))
    return out


def _company_name(sid: str, meta: dict) -> str:
    """企业名：registry 优先，fallback meta.json，再 fallback supplier id。"""
    try:
        sys.path.insert(0, str(WS / "work" / "mio-api"))
        from dc_company_registry import CompanyRegistry
        entry = CompanyRegistry().get(sid)
        if entry and entry.get("company_name"):
            return entry["company_name"]
    except Exception:
        pass
    return meta.get("company_name") or sid


def _cmd_stage(argv):
    ap = argparse.ArgumentParser(
        prog="exhibition_assistant.py stage",
        description="写入/推进展会阶段状态（写入 meta.json exhibition_stage / understanding_done / plan_done）")
    ap.add_argument("supplier_id")
    ap.add_argument("--stage", required=True, choices=list(STAGES), help="阶段：" + "/".join(STAGES))
    ap.add_argument("--understanding-done", choices=["true", "false"], help="企业+第一推荐产品理解完成")
    ap.add_argument("--plan-done", choices=["true", "false"], help="获客方案产出")
    a = ap.parse_args(argv)
    r = set_stage(a.supplier_id, a.stage,
                  understanding_done=(None if a.understanding_done is None else a.understanding_done == "true"),
                  plan_done=(None if a.plan_done is None else a.plan_done == "true"))
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r.get("ok") else 1


def _cmd_report(argv):
    ap = argparse.ArgumentParser(
        prog="exhibition_assistant.py report",
        description="手动录入企业参展信息（写入 meta.json exhibitions，多源融合时优先于 CDP）")
    ap.add_argument("supplier_id")
    ap.add_argument("--name", required=True, help="展会中文名（必填）")
    ap.add_argument("--start", required=True, help="开展日 YYYY-MM-DD 或 YYYYMMDD（必填）")
    ap.add_argument("--end", help="闭展日（缺省=开展日）")
    ap.add_argument("--city", help="城市/国家（英文）")
    ap.add_argument("--country", help="国家（中文）")
    ap.add_argument("--venue", help="展馆")
    ap.add_argument("--sector", help="品类/行业")
    ap.add_argument("--name-en", dest="name_en", help="展会英文名")
    a = ap.parse_args(argv)
    r = add_exhibition(a.supplier_id, {
        "name": a.name, "name_en": a.name_en, "start": a.start, "end": a.end,
        "city": a.city, "country": a.country, "venue": a.venue, "sector": a.sector,
    })
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r.get("ok") else 1


def main():
    _load_env()
    open_id = _env("MIO_V_OPEN_ID")
    if len(sys.argv) > 1 and sys.argv[1] == "report":
        return _cmd_report(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "stage":
        return _cmd_stage(sys.argv[2:])
    today = _today()
    argv_ids = [a for a in sys.argv[1:] if a.strip()]
    all_companies = discover_companies()

    if argv_ids:
        # 显式指定 supplier_id：从 binding 匹配 chat_id
        chat_by_sid = {sid: cid for sid, cid, _ in all_companies}
        companies = [(sid, chat_by_sid.get(sid, ""), "") for sid in argv_ids]
    else:
        companies = all_companies

    if not companies:
        print("[skip] 无绑定企业，请先完成企业绑定")
        return

    for sid, chat_id, bound_name in companies:
        exhs = resolve_exhibitions(sid, open_id)
        if not exhs:
            print("[skip] 无参展信息:", sid)
            continue
        prog = invite_progress(sid)
        mats = material_status(sid)
        meta = get_meta(sid)
        company = bound_name or _company_name(sid, meta)
        stage = read_stage(sid)["stage"]
        for exh in exhs:
            card = build_card(exh, today, prog, mats, company, stage)
            if card is None:
                print("[skip] 展会已结束:", exh["name"])
                continue
            if _env("DRY_RUN"):
                print(json.dumps(card, ensure_ascii=False, indent=2))
            else:
                if not chat_id:
                    print("[no chat_id] 仅打印:", exh["name"])
                    print(json.dumps(card, ensure_ascii=False, indent=2))
                    continue
                resp = post_card(chat_id, card)
                print("[ok]", exh["name"], "->", resp)


if __name__ == "__main__":
    main()
