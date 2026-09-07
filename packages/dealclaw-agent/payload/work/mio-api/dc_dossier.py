#!/usr/bin/env python3
"""
dc_dossier.py — 客户档案文档生成层（阶段⑤）

档案文档是「可再生阅读层」，不是原始数据唯一来源：
  - 从 customer/opportunity/interaction 结构化数据生成，随时可重算；
  - 优先跟进客户自动生成，普通/长期培育按需生成，降级归档不删；
  - 用户修正必须回写结构化数据（leads.json / interactions.json），不能只改文档。

分层：
  build_dossier_content : 纯函数，结构化数据 → 档案文档 Markdown（可测）
  dossier_plan          : 纯函数，决定 generate / update / skip（可测）
  _create_doc / _update_doc : lark-cli docs v2 薄封装（需真实飞书环境）
  sync_dossier          : 编排：读 leads+interactions → plan → 生成 → 写回 dossier_url
"""

from __future__ import annotations

from typing import Optional

CHANNEL_LABEL = {"email": "邮件", "whatsapp": "WhatsApp", "meeting": "会议", "scan": "扫码"}
DIRECTION_LABEL = {"outbound": "发出", "inbound": "收到", "bidirectional": "双向", "system": "系统"}

PRIORITY_HIGH = "优先跟进"


def _ts(s) -> str:
    """ISO 时间 → 日期（YYYY-MM-DD），档案时间线只看日期。"""
    return str(s or "").replace("T", " ").replace("Z", "")[:10]


def _timeline_line(it: dict) -> str:
    """单条互动 → 时间线一行。正文截断，不铺满。"""
    ch = CHANNEL_LABEL.get(it.get("channel", ""), it.get("channel", "") or "互动")
    direction = DIRECTION_LABEL.get(it.get("direction", ""), it.get("direction", "") or "")
    ts = _ts(it.get("occurred_at"))
    subject = (it.get("subject") or "").strip()
    summary = (it.get("summary") or "").strip()

    head = " · ".join(x for x in (ts, ch, direction) if x)
    if subject:
        head += f"｜{subject}"
    line = f"- {head}"
    if summary:
        line += f"\n  {summary[:200]}"
    return line


def build_dossier_content(lead: Optional[dict] = None, interactions: Optional[list] = None) -> str:
    """从 lead（customer+opportunity 视图）+ interactions 生成档案文档 Markdown。

    纯函数：同样的结构化数据 → 同样的文档。不含任何外部调用。
    lead 字段：company / followup_priority / stage / next_action / due /
               priority_reason / country / buyer_type / contact / position / website
    """
    lead = lead or {}
    interactions = interactions or []

    company = (lead.get("company") or "未命名客户").strip()
    priority = (lead.get("followup_priority") or "").strip()
    stage = (lead.get("stage") or "").strip()
    next_action = (lead.get("next_action") or "").strip()
    due = (lead.get("due") or "").strip()
    priority_reason = (lead.get("priority_reason") or "").strip()
    country = (lead.get("country") or "").strip()
    buyer_type = (lead.get("buyer_type") or "").strip()
    contact = (lead.get("contact") or "").strip()
    position = (lead.get("position") or "").strip()
    website = (lead.get("website") or "").strip()

    lines = [f"# {company}"]

    # 头部：优先级 · 阶段
    head = " · ".join(x for x in (priority, stage) if x)
    if head:
        lines.append("")
        lines.append(head)

    # 下次动作
    if next_action or due:
        lines.append("")
        lines.append("**下次动作**")
        act = next_action or "待定"
        lines.append(act if not due else f"{act}｜截止：{due}")

    # 为什么优先
    if priority_reason:
        lines.append("")
        lines.append("**为什么优先**")
        lines.append(priority_reason)

    # 客户概况
    lines.append("")
    lines.append("**客户概况**")
    meta = " · ".join(x for x in (country, buyer_type) if x)
    if meta:
        lines.append(meta)
    if contact:
        lines.append(f"联系人：{contact}" + (f"｜{position}" if position else ""))
    if website:
        lines.append(f"官网：{website}")

    # 沟通时间线
    lines.append("")
    lines.append("**沟通时间线**")
    if interactions:
        for it in sorted(interactions, key=lambda x: str(x.get("occurred_at") or "")):
            lines.append(_timeline_line(it))
    else:
        lines.append("暂无互动记录")

    return "\n".join(lines)


def dossier_plan(leads: list) -> list:
    """决定每个客户的档案文档动作。

    - 优先跟进 → generate（无文档）/ update（已有文档）
    - 普通/长期培育 → skip（按需，不自动生成；已有文档不删，即「归档不删」）

    返回 [(lead, action)]，action ∈ {"generate", "update", "skip"}。
    """
    plan = []
    for lead in leads:
        pri = (lead.get("followup_priority") or "").strip()
        has_doc = bool((lead.get("dossier_url") or "").strip())
        if pri == PRIORITY_HIGH:
            action = "update" if has_doc else "generate"
        else:
            action = "skip"
        plan.append((lead, action))
    return plan


# ─────────────────────────────────────────────────────────────
# lark-cli docs v2 薄封装（需真实飞书环境，联调时验证）
# ─────────────────────────────────────────────────────────────

def _create_doc(content: str) -> str:
    """创建飞书档案文档，返回 document url。需真实飞书环境。"""
    import subprocess
    import json
    p = subprocess.run(
        ["lark-cli", "docs", "+create", "--api-version", "v2",
         "--doc-format", "markdown", "--as", "bot",
         "--content", "-"],
        input=content, capture_output=True, text=True, timeout=60,
    )
    try:
        data = json.loads(p.stdout or p.stderr or "{}")
        doc = (data.get("data") or {}).get("document") or {}
        return doc.get("url", "")
    except Exception:
        return ""


def _update_doc(doc_url: str, content: str) -> bool:
    """整体覆盖更新飞书档案文档。需真实飞书环境。"""
    import subprocess
    p = subprocess.run(
        ["lark-cli", "docs", "+update", "--api-version", "v2",
         "--doc", doc_url, "--command", "overwrite",
         "--doc-format", "markdown", "--as", "bot",
         "--content", "-"],
        input=content, capture_output=True, text=True, timeout=60,
    )
    return p.returncode == 0


def sync_dossier(company_id: str, *, create_doc=None, update_doc=None, dry_run: bool = False) -> dict:
    """编排档案文档生成：读 leads + interactions → plan → 生成 → 写回 dossier_url。

    create_doc / update_doc 可注入（测试替换）；缺省用 lark-cli 真实实现。
    dry_run 时不落飞书、不回写 dossier_url。
    """
    from dc_memory_data import read_leads, read_interactions, _write_json

    leads = read_leads(company_id)
    interactions = read_interactions(company_id)

    by_customer = {}
    for it in interactions:
        cid = (it.get("customer_id") or "").strip()
        if cid:
            by_customer.setdefault(cid, []).append(it)

    create_doc = create_doc or _create_doc
    update_doc = update_doc or _update_doc

    results = []
    updated = []
    for lead, action in dossier_plan(leads):
        if action == "skip":
            results.append({"company": lead.get("company", ""), "action": "skip"})
            continue
        cid = (lead.get("company_cdp_id") or "").strip()
        content = build_dossier_content(lead, by_customer.get(cid, []))
        if dry_run:
            results.append({"company": lead.get("company", ""), "action": action,
                            "dry_run": True, "content": content})
            continue
        if action == "generate":
            url = create_doc(content)
            if url:
                lead = dict(lead)
                lead["dossier_url"] = url
                results.append({"company": lead.get("company", ""), "action": "generate", "url": url})
            else:
                results.append({"company": lead.get("company", ""), "action": "generate", "error": "create_failed"})
        else:  # update
            ok = update_doc(lead.get("dossier_url", ""), content)
            results.append({"company": lead.get("company", ""), "action": "update", "ok": ok})
        updated.append(lead)

    # 回写 dossier_url（仅生成/更新的 lead）
    if updated and not dry_run:
        index = {l.get("company", ""): l for l in leads}
        for lead in updated:
            index[lead.get("company", "")] = lead
        _write_json(company_id, "leads.json", list(index.values()))

    return {"status": "ok", "total": len(results),
            "generated": sum(1 for r in results if r.get("action") == "generate"),
            "updated": sum(1 for r in results if r.get("action") == "update"),
            "skipped": sum(1 for r in results if r.get("action") == "skip"),
            "results": results}


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(description="客户档案文档生成（阶段⑤）")
    ap.add_argument("company_id", help="企业 supplier_id")
    ap.add_argument("--dry-run", action="store_true", help="只预演，不落飞书")
    args = ap.parse_args()
    print(json.dumps(sync_dossier(args.company_id, dry_run=args.dry_run), ensure_ascii=False, indent=2))
