#!/usr/bin/env python3
"""
dc_growth_dashboard.py — 展会邮件营销看板（只读聚合，P0-E6）

从 email-facts / email-signals / pending-replies / LeadStore / Campaign 聚合，
输出触达漏斗 + 当前跟进 + 买家状态 + 策略效果。

只读：不重新分析邮件、不修改业务状态、不写任何事实。缺数据显示「暂无数据」，不编造。
同日期/企业/战役重复生成结果一致（纯聚合、确定性排序）。
"""

from __future__ import annotations


def _signals(company_id: str) -> list[dict]:
    from dc_memory_data import read_signals
    return read_signals(company_id)


def _outbounds(company_id: str) -> list[dict]:
    from dc_memory_data import read_emails
    return [e for e in read_emails(company_id) if e.get("direction") == "out"]


def _inbounds(company_id: str) -> list[dict]:
    from dc_memory_data import read_emails
    return [e for e in read_emails(company_id) if e.get("direction") == "in"]


def _leads(company_id: str) -> list[dict]:
    from dc_memory_data import read_leads_internal
    return read_leads_internal(company_id)


def _campaign(company_id: str):
    from dc_memory_data import read_campaign
    return read_campaign(company_id)


def _has_reply(inbounds: list[dict], thread_id: str, contact_id: str, sent_at: str,
               outbound: dict | None = None, outbound_records: list | None = None) -> bool:
    """是否已被人工回复（旧路径 + Adapter 引用匹配，见 email_metrics.legacy）。"""
    for ib in inbounds:
        if ib.get("binding_status") != "bound":
            continue
        if thread_id and ib.get("thread_id") == thread_id:
            return True
        if contact_id and ib.get("contact_id") == contact_id \
                and (ib.get("received_at") or "") >= (sent_at or ""):
            return True
    if outbound is not None:
        try:
            from email_metrics import legacy as _legacy
            records = outbound_records if outbound_records is not None else [outbound]
            return _legacy.has_reply(outbound, records, inbounds)
        except Exception:  # noqa: BLE001
            return False
    return False


def _review_candidates(company_id: str) -> list[dict]:
    """第三轮 delivered 仍无回复的 outbound（策略复盘候选），从 memory emails 重算。"""
    out = _outbounds(company_id)
    inb = _inbounds(company_id)
    result = []
    for ob in out:
        if ob.get("provider_status") != "delivered":
            continue
        if int(ob.get("touch_number", 0) or 0) < 3:
            continue
        if _has_reply(inb, ob.get("thread_id") or ob.get("local_message_id", ""),
                      ob.get("contact_id", ""), ob.get("sent_at") or ob.get("created_at", ""),
                      outbound=ob, outbound_records=out):
            continue
        result.append({"resend_id": ob.get("resend_id", ""),
                       "buyer_email": (ob.get("recipients") or [""])[0],
                       "touch_number": ob.get("touch_number"),
                       "campaign_id": ob.get("campaign_id", "")})
    return result


# ── 1. 触达漏斗 ──────────────────────────────────────────
def _company_set(recipients, email_to_company) -> set:
    """收件人邮箱 → 企业标识集合（公司名精确映射，无映射兑底用 domain）。"""
    cs = set()
    for r in (recipients or []):
        e = str(r).strip().lower()
        if "@" not in e:
            continue
        d = e.split("@")[-1]
        if d.endswith(("dealclaw.io", "meorient.com")):
            continue
        cs.add(email_to_company.get(e, d))
    return cs


def build_funnel(company_id: str) -> dict:
    """触达漏斗（企业数口径，去重）+ total_emails（邮件总数）。"""
    import re
    from dc_memory_data import read_emails, read_signals, read_leads
    out = [e for e in read_emails(company_id) if e.get("direction") == "out"]
    signals = read_signals(company_id)
    # 邮箱 -> 公司名 映射（线索池公司名 = 企业唯一标识）
    email_to_company = {}
    for l in read_leads(company_id):
        c = (l.get("company") or "").strip()
        if not c:
            continue
        for e in re.findall(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}", str(l.get("contact", ""))):
            email_to_company.setdefault(e.lower(), c)
    # outbound 企业去重 + id→企业映射（供信号关联）
    id_to_companies: dict[str, set] = {}
    sent: set = set()
    delivered: set = set()
    bounced: set = set()
    for o in out:
        cs = _company_set(o.get("recipients"), email_to_company)
        sent |= cs
        st = o.get("provider_status", "")
        if st == "delivered":
            delivered |= cs
        elif st == "bounced":
            bounced |= cs
        for iid in (o.get("thread_id"), o.get("local_message_id"), o.get("resend_id"), o.get("smtp_message_id")):
            if iid:
                id_to_companies.setdefault(iid, set()).update(cs)
    # 回复/有效询盘/会议意向：按企业去重（信号关联 outbound 后取收件人企业）
    replied: set = set()
    inquiry: set = set()
    meeting: set = set()
    for s in signals:
        st = s.get("signal_type")
        if st not in ("quote_request", "sample_request", "meeting_interest", "missing_info"):
            continue
        cs = set()
        for iid in (s.get("thread_id"), s.get("source_resend_id"), s.get("source_message_id")):
            if iid and iid in id_to_companies:
                cs |= id_to_companies[iid]
        if st == "meeting_interest":
            meeting |= cs
        elif st in ("quote_request", "sample_request"):
            inquiry |= cs
        replied |= cs
    return {
        "sent": len(sent),
        "delivered": len(delivered),
        "replied": len(replied),
        "valid_inquiry": len(inquiry),
        "meeting_intent": len(meeting),
        "bounced": len(bounced),
        "total_emails": len(out),
    }


# ── 2. 当前跟进 ──────────────────────────────────────────
def build_followup_status(company_id: str) -> dict:
    from dc_memory_data import read_drafts
    drafts = [d for d in read_drafts(company_id) if d.get("status") == "pending_confirmation"]
    followup2 = [d for d in drafts if d.get("category") == "followup" and d.get("touch_number") == 2]
    followup3 = [d for d in drafts if d.get("category") == "followup" and d.get("touch_number") == 3]
    reply_drafts = [d for d in drafts if d.get("category") != "followup"]
    paused = _review_candidates(company_id)
    return {
        "pending_drafts": len(drafts),
        "second_round": len(followup2),
        "third_round": len(followup3),
        "reply_drafts": len(reply_drafts),
        "paused_leads": len(paused),
        "needs_user_action": len(drafts),
    }


# ── 3. 买家状态 ──────────────────────────────────────────
def _lead_by_domain(leads: list[dict], domain: str) -> dict | None:
    d = (domain or "").strip().lower()
    if not d:
        return None
    for l in leads:
        if (l.get("domain") or "").strip().lower() == d:
            return l
    return None


def _resolve_lead(outbound: dict, email: str, leads: list[dict]) -> dict | None:
    """优先结构化字段（lead_id/contact_id），缺失时按 domain，再失败返回 None（→暂无数据，不猜测）。"""
    lead_id = outbound.get("lead_id") or outbound.get("contact_id") or ""
    if lead_id:
        for l in leads:
            if l.get("company_cdp_id") == lead_id \
                    or (l.get("domain") or "").strip().lower() == lead_id.strip().lower():
                return l
    domain = email.split("@")[-1].strip().lower() if "@" in email else ""
    return _lead_by_domain(leads, domain)


def _buyer_last_signal(signals: list[dict], out_resend_ids: set) -> str:
    types = []
    for s in signals:
        if s.get("source_resend_id") in out_resend_ids or s.get("thread_id") in out_resend_ids:
            if s.get("signal_type") in ("quote_request", "sample_request", "meeting_interest"):
                types.append(s.get("signal_type"))
    return "meeting_interest" if "meeting_interest" in types else \
           ("valid_inquiry" if types else "")


def build_buyer_status(company_id: str) -> list[dict]:
    out = _outbounds(company_id)
    signals = _signals(company_id)
    leads = _leads(company_id)

    # 按买家邮箱分组
    by_email: dict[str, dict] = {}
    for o in out:
        email = (o.get("recipients") or [""])[0].strip().lower()
        if not email:
            continue
        g = by_email.setdefault(email, {"email": email, "touch": 0, "resend_ids": set(),
                                        "status": "", "outbounds": []})
        g["outbounds"].append(o)
        g["touch"] = max(g["touch"], int(o.get("touch_number", 0) or 0))
        g["resend_ids"].add(o.get("resend_id", ""))
        g["status"] = o.get("provider_status", "") or g["status"]

    rows = []
    for email, g in sorted(by_email.items()):
        hint = g["outbounds"][0] if g["outbounds"] else {}
        lead = _resolve_lead(hint, email, leads)
        touch = g["touch"]
        status = g["status"]
        sig = _buyer_last_signal(signals, g["resend_ids"])

        # 最近动作 + 下一步动作 + 状态原因
        if status == "bounced":
            recent, nxt, reason = "退信", "已停止", "退信"
        elif status in ("complained", "failed"):
            recent, nxt, reason = "投递失败", "已停止", status
        elif sig == "meeting_interest":
            recent, nxt, reason = "会议意向", "已回复", "买家有会议意向"
        elif sig == "valid_inquiry":
            recent, nxt, reason = "有效询盘", "已回复", "买家询盘"
        elif status == "delivered":
            if touch >= 3:
                recent, nxt, reason = "已送达(三轮无回复)", "策略复盘", "达到第三轮"
            else:
                recent, nxt, reason = "已送达未回复", f"第{touch+1}轮跟进", "未回复"
        else:
            recent, nxt, reason = "已发送", "等待送达", "投递中"

        rows.append({
            "company": (lead or {}).get("company_name", "") or "暂无数据",
            "contact": email,
            "country": (lead or {}).get("country", "") or "暂无数据",
            "touch_number": touch,
            "last_action": recent,
            "next_action": nxt,
            "status_reason": reason,
        })
    return rows


# ── 3.5 邮件口径（统一读入口）────────────────────────────
def _signal_reply_ids(signals: list[dict]) -> set:
    return {s.get("source_message_id") for s in signals
            if s.get("source_message_id")
            and s.get("signal_type") in ("quote_request", "sample_request",
                                         "meeting_interest", "missing_info")}


def build_email_metrics(company_id: str, *, date: str | None = None, date_range=None,
                        tz: str | None = None, store=None, signals=None) -> dict:
    """看板的邮件指标块 —— **统一读入口** `email_metrics.service.read_email_metrics`。

    口径由 `DC_EMAIL_METRICS_MODE` 决定（默认 legacy）；数字不可用时 `status="unavailable"`、
    值为 None，不报假 0。看板的「触达漏斗」仍是企业数口径（去重企业），与本块（邮件数口径）
    分开展示，不相互混算。
    """
    from email_metrics.service import read_email_metrics
    if signals is None:
        try:
            signals = _signals(company_id)
        except Exception:  # noqa: BLE001
            signals = []
    m = read_email_metrics(
        company_id=company_id, date=date, date_range=date_range, report_timezone=tz,
        store=store, opportunity_signals=signals,
        legacy_replied=len(_signal_reply_ids(signals or [])), consumer="growth_dashboard",
    )
    return {
        "mode": m["mode"],
        "status": m["status"],
        "v1_status": m.get("v1_status"),
        "reasons": list(m.get("reasons") or []),
        "metrics": dict(m["metrics"]),
        "range": m.get("range"),
        "report_timezone": m.get("report_timezone"),
        "unassigned_count": m.get("unassigned_count"),
        "data_complete": m["status"] == "ok",
    }


# ── 4. 策略效果 ──────────────────────────────────────────
def build_strategy_effect(company_id: str) -> dict:
    f = build_funnel(company_id)
    camp = _campaign(company_id)
    paused = _review_candidates(company_id)
    delivery_rate = round(f["delivered"] / f["sent"] * 100, 1) if f["sent"] else 0
    reply_rate = round(f["replied"] / f["delivered"] * 100, 1) if f["delivered"] else 0
    return {
        "delivery_rate": delivery_rate,
        "reply_rate": reply_rate,
        "valid_inquiry": f["valid_inquiry"],
        "meeting_intent": f["meeting_intent"],
        "bounced": f["bounced"],
        "strategy_version": (camp or {}).get("strategy_version", 0),
        "needs_review": len(paused) > 0,
    }


# ── 聚合 ────────────────────────────────────────────────
def build_dashboard(company_id: str) -> dict:
    return {
        "company_id": company_id,
        "funnel": build_funnel(company_id),
        "email_metrics": build_email_metrics(company_id),
        "followup": build_followup_status(company_id),
        "buyers": build_buyer_status(company_id),
        "strategy": build_strategy_effect(company_id),
        "text": None,
    }


_DASHBOARD_QUERIES = ["看一下邮件情况", "邮件情况", "展会进展", "邮件漏斗", "哪些买家需要跟进", "当前营销效果", "营销效果", "邮件看板", "看板", "触达漏斗", "线索池", "线索看板", "在跟的买家", "买家线索"]


def detect_dashboard_intent(text: str) -> bool:
    """对话查询是否触发完整看板。"""
    t = (text or "").strip()
    if not t:
        return False
    return any(q in t for q in _DASHBOARD_QUERIES)


def format_dashboard(d: dict) -> str:
    company = d.get("company_id", "")
    f = d.get("funnel", {})
    fu = d.get("followup", {})
    st = d.get("strategy", {})
    buyers = d.get("buyers", [])

    lines = [f"📊 DealClaw 展会邮件看板 · {company}", ""]
    lines.append("## 触达漏斗")
    lines.append(f"发送 {f.get('sent',0)} → 送达 {f.get('delivered',0)} → 回复 {f.get('replied',0)} → 有效询盘 {f.get('valid_inquiry',0)} → 会议意向 {f.get('meeting_intent',0)}")
    em = d.get("email_metrics")
    if em:
        from email_metrics.service import format_metrics_line
        mode = em.get("mode", "legacy")
        if em.get("status") == "unavailable":
            reasons = "，".join(em.get("reasons") or [])
            lines.append(f"邮件口径（{mode}）：数据不可用（{reasons}）")
        else:
            lines.append(format_metrics_line(
                {"status": em.get("status"), "metrics": em.get("metrics") or {},
                 "reasons": em.get("reasons")},
                prefix=f"邮件口径（{mode} · 邮件数）："))
    lines.append("")
    lines.append("## 当前跟进")
    lines.append(f"待发送草稿 {fu.get('pending_drafts',0)}（回复 {fu.get('reply_drafts',0)} / 跟进 {fu.get('second_round',0)+fu.get('third_round',0)}）")
    lines.append(f"第二轮 {fu.get('second_round',0)} · 第三轮 {fu.get('third_round',0)} · 已暂停 {fu.get('paused_leads',0)} · 需确认 {fu.get('needs_user_action',0)}")
    lines.append("")
    lines.append("## 策略效果")
    lines.append(f"送达率 {st.get('delivery_rate',0)}% · 回复率 {st.get('reply_rate',0)}% · 退信 {st.get('bounced',0)}")
    lines.append(f"有效询盘 {st.get('valid_inquiry',0)} · 会议意向 {st.get('meeting_intent',0)} · 策略版本 v{st.get('strategy_version',0)} · 需复盘 {'是' if st.get('needs_review') else '否'}")
    lines.append("")
    lines.append("## 买家状态")
    if not buyers:
        lines.append("暂无数据")
    else:
        lines.append("| 公司 | 联系人 | 国家 | 触达轮次 | 最近动作 | 下一步 | 状态原因 |")
        lines.append("|---|---|---|---|---|---|---|")
        for b in buyers:
            lines.append(f"| {b['company']} | {b['contact']} | {b['country']} | {b['touch_number']} | {b['last_action']} | {b['next_action']} | {b['status_reason']} |")
    return "\n".join(lines)


# ── 5. 线索池看板 ──────────────────────────────────────────
# 线索池字段清单（说明线索池有哪些字段；展示规则见 format_lead_pool_dashboard）
LEAD_POOL_FIELDS = [
    ("company", "公司名"),
    ("website", "官网"),
    ("country", "国家"),
    ("buyer_type", "买家类型"),
    ("contact", "联系人"),
    ("followup_priority", "跟进优先级"),
    ("priority_reason", "优先级理由"),
    ("next_action", "下一步动作"),
    ("due", "截止时间"),
]


def build_lead_pool_dashboard(company_id: str, backfill_first: bool = True) -> dict:
    """线索池看板：读 memory 的 leads.json（权威数据），只读。

    backfill_first=True 时先回写触达状态（发送/回复 → 阶段）并 re-sync memory，
    保证看板反映最新触达状态。回写失败不影响看板生成。
    """
    if backfill_first:
        try:
            from dc_touch_backfill import backfill
            from dc_memory_data import sync_leads_to_memory
            backfill(company_id)
            sync_leads_to_memory(company_id)
        except Exception:
            pass
    from dc_memory_data import read_leads
    leads = read_leads(company_id)
    company_name = company_id
    bitable_url = ""
    try:
        from dc_company_registry import CompanyRegistry
        entry = CompanyRegistry().get(company_id)
        if entry:
            company_name = entry.get("company_name") or company_id
            bitable_url = entry.get("bitable_url") or ""
    except Exception:
        pass
    if not leads:
        return {"company_id": company_id, "company_name": company_name,
                "bitable_url": bitable_url, "total": 0, "rows": [],
                "error": "memory 无线索数据（先 sync-leads 归集）"}
    return {"company_id": company_id, "company_name": company_name,
            "bitable_url": bitable_url, "total": len(leads), "rows": leads}


def _website_link(site) -> str:
    """把官网值转成可跳转的 markdown 链接（统一 https）。

    官网值可能是纯域名（cafecalupoh.mx），也可能已经是 markdown 链接格式
    （飞书 style=url 后自动包装成 [域名](http://域名)），这里统一解析并 https。
    """
    import re
    site = (site or "").strip()
    if not site:
        return "—"
    m = re.match(r"^\[(.*)\]\((.*)\)$", site)
    if m:
        text = m.group(1).strip()
        url = m.group(2).strip()
    else:
        text = site
        url = site
    if url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    elif not url.startswith("http"):
        url = "https://" + url
    return f"[{text}]({url})"


def format_lead_pool_dashboard(d: dict) -> str:
    """线索池展示（阶段⑥前台收敛）。

    重点展示「跟进优先级 + 下一步」；匹配度、阶段作为 AI 判断依据收起不铺满。
    ≤5 条：逐条（公司名 + 优先级 + 下一步），次要信息（国家/类型）一行。
    >5 条：优先级分布 + 优先跟进列表。
    """
    title = d.get("company_name") or d.get("company_id", "")
    total = d.get("total", 0)
    rows = d.get("rows", [])
    bitable_url = d.get("bitable_url", "")

    lines = [f"📋 线索池 · {title}（共 {total} 条）", ""]
    if d.get("error"):
        lines.append(f"⚠️ {d['error']}")
        return "\n".join(lines)
    if not rows:
        lines.append("暂无数据")
        return "\n".join(lines)

    pri_rank = {"优先跟进": 0, "普通跟进": 1, "长期培育": 2}

    def _pri_key(r):
        return pri_rank.get((r.get("followup_priority") or "").strip(), 99)

    if total <= 5:
        for i, r in enumerate(sorted(rows, key=_pri_key), 1):
            head = f"{i}. {r.get('company','')}"
            badges = []
            pri = (r.get("followup_priority") or "").strip()
            if pri:
                badges.append(pri)
            next_action = (r.get("next_action") or "").strip()
            due = (r.get("due") or "").strip()
            if next_action:
                badges.append(next_action + (f"｜{due}" if due else ""))
            if badges:
                head += " · " + " · ".join(badges)
            lines.append(head)
            meta = " · ".join(x for x in [r.get('country',''), r.get('buyer_type','')] if x)
            if meta:
                lines.append(f"   {meta}")
            lines.append("")
    else:
        from collections import Counter
        pri_counts = Counter((r.get("followup_priority") or "未定").strip() or "未定" for r in rows)
        pri_str = "、".join(f"{p} {c}" for p, c in pri_counts.most_common())
        lines.append(f"优先级：{pri_str}")
        highs = [r for r in rows if (r.get("followup_priority") or "").strip() == "优先跟进"]
        if highs:
            lines.append("")
            lines.append("优先跟进：")
            for r in highs[:3]:
                next_action = (r.get("next_action") or "").strip()
                tail = f"（{next_action}）" if next_action else ""
                lines.append(f"· {r.get('company','')}{tail}")

    if bitable_url:
        lines.append("")
        lines.append(f"📋 完整线索池：[打开飞书表格]({bitable_url})")
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    company = sys.argv[1] if len(sys.argv) > 1 else "testco"
    d = build_dashboard(company)
    d["text"] = format_dashboard(d)
    print(d["text"])
