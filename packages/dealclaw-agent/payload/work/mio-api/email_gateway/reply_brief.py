"""回信解读 + 下一步建议：把买家回复变成"人话解读 + 可执行动作"。

用途：取信管子拉到归属成功的回信后，通知里不能只有"有新邮件"，而要直接给出
**买家想干什么** 与 **建议下一步**，让用户一句话就能决定（参见卡片时代的回复形态）。

解读来源复用既有信号分类器（``dc_email_signals.classify_reply_signals``，由 inbound
处理链产出 ``signals``），本模块只做「信号 → 中文解读 + 动作建议」的映射，不重复判断逻辑。
"""

from __future__ import annotations

# 信号类型 → （解读标签，建议动作列表）
SIGNAL_BRIEFS: dict[str, tuple[str, list[str]]] = {
    "quote_request": ("买家在问价格", [
        "确认报价口径：单价 / MOQ / 交期 / 贸易条款，一次给全，避免来回",
        "附一份主推型号的报价要点，别只回一句“稍后发你”",
    ]),
    "sample_request": ("买家想要样品", [
        "确认寄样地址、收件人、电话，并说明样品费与运费由谁承担",
        "给出寄样时间承诺（能当天安排就说当天）",
    ]),
    "meeting_interest": ("买家想见面 / 约会议", [
        "提议 2 个具体时间段（务必按买家时区换算好再发）",
        "确认线上还是线下，线下需给地址与展位号",
    ]),
    "missing_info": ("买家信息不全，还需补充", [
        "一次性问清缺口（资质 / 认证 / 产能 / 产品规格），别挤牙膏",
    ]),
    "no_reply_due": ("到期未回复，该跟进了", [
        "发一封 80–100 词的短跟进，给一个新理由（新品 / 展会 / 产能）",
        "别催单，转到“提供价值”的角度",
    ]),
    "bounced": ("地址无效，信没送到", [
        "换联系人重发，或先用 LinkedIn / 电话验证邮箱",
    ]),
    "failed": ("投递失败", [
        "确认地址与对方域名是否可收信，再决定是否重发",
    ]),
}

_INTENT_LABELS = {
    "quote_request": "报价请求",
    "sample_request": "样品请求",
    "meeting_interest": "会议意向",
    "missing_info": "信息补充",
    "no_reply_due": "到期未回",
}

NO_SIGNAL_BRIEF = ("暂未看出明确意向（可能是自动回复或寒暄）", [
    "先不急着回，标记为「培育中」，等对方下一封有实质内容再动",
    "如果是老板本人回的，可以人工看一眼再决定是否跟进",
])


def interpret_signals(signals: list | None) -> dict:
    """把 signals 汇总成 ``{"intent", "labels", "actions", "evidence"}``。

    - 多个信号时按出现顺序合并动作建议，去重保序；
    - 无信号时给"无明显意向"的保守解读（而不是报错或空通知）。
    """
    sigs = [s for s in (signals or []) if isinstance(s, dict)]
    labels: list[str] = []
    actions: list[str] = []
    evidence: list[str] = []
    for s in sigs:
        stype = str(s.get("signal_type") or "").strip()
        brief = SIGNAL_BRIEFS.get(stype)
        label = _INTENT_LABELS.get(stype) or stype or "未分类"
        if brief:
            labels.append(brief[0])
            for act in brief[1]:
                if act not in actions:
                    actions.append(act)
        else:
            labels.append(label)
        ev = str(s.get("evidence") or "").strip()
        if ev and ev not in evidence:
            evidence.append(ev)
    if not actions:
        labels.append(NO_SIGNAL_BRIEF[0])
        actions = list(NO_SIGNAL_BRIEF[1])
    return {
        "count": len(sigs),
        "intent": "、".join(dict.fromkeys(labels)),
        "actions": actions,
        "evidence": evidence[:3],
    }


def compose_brief(
    *,
    sender: str,
    subject: str,
    received_at: str = "",
    signals: list | None = None,
    excerpt: str = "",
) -> str:
    """组装一条"解读 + 下一步动作"的通知正文（小元口吻，可直接读）。"""
    info = interpret_signals(signals)
    lines = [
        "【回信 · 需要你定一下】买家回复了你的开发信",
        "",
        f"发件人：{sender or '未知'}",
        f"主题：{subject or '（无主题）'}",
    ]
    if received_at:
        lines.append(f"到达时间：{received_at}")
    lines += ["", f"解读：{info['intent']}"]
    if info["evidence"]:
        lines.append("关键信息：" + "；".join(info["evidence"]))
    if excerpt:
        lines += ["原文摘录：", excerpt]
    lines += ["", "建议下一步："]
    lines += [f"{i}. {act}" for i, act in enumerate(info["actions"], start=1)]
    lines += ["", "回「按这个发」我就照上面的动作起草；也可以直接说你想改哪儿。"]
    return "\n".join(lines)
