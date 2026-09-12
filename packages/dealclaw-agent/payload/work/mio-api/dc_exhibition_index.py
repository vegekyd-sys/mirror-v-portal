#!/usr/bin/env python3
"""
dc_exhibition_index.py — 展会目录门面文档（index.md）生成

复用 memory 现有记录，产出一页「展会目录」：

  一、展商参展信息   ← meta.json（展位号/起止）+ kb.json（企业/产品线）
  二、展会信息       ← meta.json
  三、买家总览       ← **线索池 leads.json**（一览表，不建新表）
  四、买家档案       ← 复用 dc_exhibition_dossier.build_buyer_markdown
  五、进度概览       ← 邀约/互动/优先跟进统计
  六、数据完整度     ← 各源 ready / partial / unavailable

纯可读层：随时可重算，不手改；数据源全部复用 memory。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

from dc_exhibition_dossier import (
    load_buyers,
    build_index_markdown,
    build_buyer_markdown,
)


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _memory_dir(company_id: str, workspace_root: Optional[str] = None) -> Path:
    root = Path(workspace_root) if workspace_root else _workspace_root()
    return root / "data" / "memory" / str(company_id)


def _read_json(company_id: str, name: str, default, workspace_root: Optional[str] = None):
    import json
    p = _memory_dir(company_id, workspace_root) / name
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def _cell(v, dash: str = "待补") -> str:
    s = str(v or "").strip()
    return s if s else dash


# ─────────────────────────────────────────────────────────────
# 各区块
# ─────────────────────────────────────────────────────────────

def section_exhibitor(company_id: str, exh: dict, *, workspace_root=None) -> str:
    kb = _read_json(company_id, "kb.json", {}, workspace_root)
    profile = (kb.get("profile") if isinstance(kb, dict) else {}) or {}
    name = profile.get("name") or profile.get("enterprise_external") or ""
    products = profile.get("product") or profile.get("products") or ""
    if isinstance(products, list):
        products = "、".join(str(x) for x in products)

    booth = exh.get("booth") or ""
    booth_note = ""
    if booth and exh.get("booth_source") == "user":
        booth_note = "（用户提供，已记住）"
    elif booth:
        booth_note = f"（来源：{exh.get('booth_source') or '接口'}）"

    dates = ""
    if exh.get("start") or exh.get("end"):
        dates = f"{exh.get('start') or ''} ~ {exh.get('end') or ''}".strip(" ~")

    lines = ["## 一、展商参展信息", "",
             f"- 企业名：{_cell(name)}",
             f"- 展位号：{_cell(booth)}{booth_note}",
             f"- 参展产品线：{_cell(products)}",
             f"- 参展日期：{_cell(dates)}",
             f"- 我方负责人：待补"]
    return "\n".join(lines)


def section_exhibition(exh: dict) -> str:
    lines = ["## 二、展会信息", "",
             f"- 展会名：{_cell(exh.get('name'))}",
             f"- 城市/国家：{_cell(exh.get('city'))} / {_cell(exh.get('country'))}",
             f"- 展馆：{_cell(exh.get('venue'))}",
             f"- 起止：{_cell(exh.get('start'))} ~ {_cell(exh.get('end'))}",
             f"- 时区：{_cell(exh.get('timezone'))}",
             f"- 展会 ID：{_cell(exh.get('exhibition_id'))}"]
    return "\n".join(lines)


def section_progress(buyers: list) -> str:
    total = len(buyers)
    invited = sum(1 for b in buyers if b.get("invitation"))
    interacted = sum(1 for b in buyers if b.get("interactions"))
    interactions = sum(len(b.get("interactions") or []) for b in buyers)
    high = [b for b in buyers
            if str((b.get("lead") or {}).get("followup_priority") or "").strip() == "优先跟进"]

    lines = ["## 五、进度概览", "",
             f"- 买家总数：{total}",
             f"- 已邀约：{invited}",
             f"- 有互动：{interacted}",
             f"- 互动总条数：{interactions}",
             f"- 优先跟进：{len(high)}"]
    if high:
        lines += ["", "**优先跟进名单**"]
        for b in sorted(high, key=lambda x: (x["lead"].get("company") or "")):
            L = b["lead"]
            reason = (L.get("priority_reason") or "").strip()
            lines.append(f"- {L.get('company') or '—'}"
                         + (f"（{reason}）" if reason else ""))
    return "\n".join(lines)


def section_integrity(company_id: str, *, workspace_root=None) -> str:
    def status(name, ok, detail=""):
        return f"- {name}：{'✅ ready' if ok else '⚠️ unavailable'}" + (f"（{detail}）" if detail else "")

    leads = _read_json(company_id, "leads.json", [], workspace_root)
    its = _read_json(company_id, "interactions.json", [], workspace_root)
    inv = _read_json(company_id, "exhibition-invitations.json", {}, workspace_root)
    inv = inv.get("invitations", []) if isinstance(inv, dict) else []
    kb = _read_json(company_id, "kb.json", {}, workspace_root)
    meta_exists = (_memory_dir(company_id, workspace_root) / "meta.json").exists()

    lines = ["## 六、数据完整度", "",
             status("线索池 leads.json", bool(leads), f"{len(leads)} 条"),
             status("沟通明细 interactions.json", bool(its), f"{len(its)} 条"),
             status("展会邀约 exhibition-invitations.json", bool(inv), f"{len(inv)} 条"),
             status("企业知识库 kb.json", bool(kb)),
             status("展会信息 meta.json", meta_exists)]
    lines += ["", "> 「unavailable」= 该源目前无数据，不代表为 0。"]
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────

def build_index_document(company_id: str, *, workspace_root: Optional[str] = None,
                         exhibition_id: str = "") -> str:
    """生成展会目录 index.md（一页）。"""
    from dc_exhibition_meta import get_exhibition

    exh = get_exhibition(company_id, exhibition_id)
    buyers = load_buyers(company_id, workspace_root=workspace_root)

    title_name = exh.get("name") or "展会"
    parts = [
        f"# {title_name} · 展会目录",
        "",
        section_exhibitor(company_id, exh, workspace_root=workspace_root),
        "",
        section_exhibition(exh),
        "",
        "## 三、买家总览",
        "",
        build_index_markdown(buyers, title="买家一览"),
        "",
        "## 四、买家档案（一客一案）",
        "",
    ]
    if buyers:
        for b in sorted(buyers, key=lambda x: (x["lead"].get("company") or "")):
            parts.append(build_buyer_markdown(b))
            parts.append("")
    else:
        parts.append("（暂无买家记录）")
    parts += ["", section_progress(buyers), "", section_integrity(company_id, workspace_root=workspace_root)]
    return "\n".join(parts)


# ─────────────────────────────────────────────────────────────
# 落盘 / 发布
# ─────────────────────────────────────────────────────────────

def _slug(exh: dict) -> str:
    import re
    base = (exh.get("name") or exh.get("exhibition_id") or "exhibition")
    s = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "-", str(base)).strip("-").lower()
    return s or "exhibition"


def index_path(company_id: str, exh: dict, *, workspace_root=None) -> Path:
    """展会目录 index.md 路径：data/memory/<cid>/exhibitions/<slug>/index.md"""
    return _memory_dir(company_id, workspace_root) / "exhibitions" / _slug(exh) / "index.md"


def write_index_file(company_id: str, *, workspace_root=None, exhibition_id: str = "") -> dict:
    """生成并写入展会目录 index.md（A：落盘，供定时刷新）。"""
    from dc_exhibition_meta import get_exhibition
    exh = get_exhibition(company_id, exhibition_id)
    content = build_index_document(company_id, workspace_root=workspace_root,
                                   exhibition_id=exhibition_id)
    p = index_path(company_id, exh, workspace_root=workspace_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return {"ok": True, "path": str(p), "bytes": len(content.encode("utf-8"))}


def publish_index(company_id: str, *, create_doc=None, update_doc=None,
                  workspace_root=None, exhibition_id: str = "") -> dict:
    """发布到飞书文档（B）：无 url → create；有 → update；url 写回 meta.json。"""
    from dc_exhibition_meta import get_exhibition, upsert_exhibition
    exh = get_exhibition(company_id, exhibition_id)
    content = build_index_document(company_id, workspace_root=workspace_root,
                                   exhibition_id=exhibition_id)
    if create_doc is None or update_doc is None:
        from dc_dossier import _create_doc as real_create, _update_doc as real_update
        create_doc = create_doc or real_create
        update_doc = update_doc or real_update

    url = str(exh.get("index_doc_url") or "").strip()
    if url:
        ok = bool(update_doc(url, content))
        return {"ok": ok, "action": "update", "url": url}
    new_url = create_doc(content)
    if new_url:
        upsert_exhibition(company_id,
                          exh.get("exhibition_id") or exhibition_id or "",
                          source="agent", index_doc_url=new_url)
        return {"ok": True, "action": "create", "url": new_url}
    return {"ok": False, "action": "create", "error": "create_failed"}


def _cli() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="展会目录 index.md 生成")
    ap.add_argument("--company-id", required=True)
    ap.add_argument("--workspace-root", default="")
    ap.add_argument("--exhibition-id", default="")
    ap.add_argument("--write", action="store_true", help="写入 index.md 文件")
    ap.add_argument("--publish", action="store_true", help="发布/更新飞书文档")
    args = ap.parse_args()
    ws = args.workspace_root or None
    if args.write:
        import json
        print(json.dumps(write_index_file(args.company_id, workspace_root=ws,
                                          exhibition_id=args.exhibition_id), ensure_ascii=False))
        return 0
    if args.publish:
        import json
        print(json.dumps(publish_index(args.company_id, workspace_root=ws,
                                       exhibition_id=args.exhibition_id), ensure_ascii=False))
        return 0
    print(build_index_document(args.company_id, workspace_root=ws,
                               exhibition_id=args.exhibition_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
