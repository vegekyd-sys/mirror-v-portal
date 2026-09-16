#!/usr/bin/env python3
"""dc_brief_render — 早晚报渲染器（日常营销早报 / 展会营销早报 / 晚报）。

口径来源：田耕郡 2026-09-17 定稿（含 00:16 的总结与 00:30 的确认）：
  · 早报分两类：**日常营销早报**（看节奏：多轮触达 + 回信处理 + 线索推进）
    与**展会营销早报**（看当下：到馆/约见/现场推荐）；骨架共用、特有块不同。
  · 骨架：我帮你做了（近 24h）→ 我的判断（带理由）→ 今天要你决定（≤3）
    → 多轮触达（今天）→ 最近又学会了 → 链接只出现一次。
  · 晚报关键词是**收尾**：今日核销（不粉饰）→ 今日战果 → 等待中的盘面 → 明日第一件事。
  · 写作原则：先价值后数字；数字必须可追溯（真做了才写）；行动 ≤3 条；不重复；不吹。

本模块是**纯渲染 + 纯计算**（无网络、无副作用），便于测试与在任意数据源上复用：
  - 多轮触达引擎（R1→R2→R3，T1/T2 节奏，硬门槛，幂等）→ `plan_touch_rounds`
  - 三个渲染入口 → `render_morning(kind="daily"|"exhibition")` / `render_evening`
  - 飞书卡片形态 → `to_feishu_card(text_or_sections)`
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

# ── 多轮触达参数（客户可调；集中定义，不散落硬编码）───────────────
MAX_ROUND = 3                      # R1 首触 / R2 / R3；之后转培育池
ROUND_GAP_DAYS = {"T1": (3, 5), "T2": (7, 10)}   # (R1→R2, R2→R3) 间隔天数
TIER_FIELD = "跟进优先级"           # 线索池字段 → T1/T2（不新造字段名）
TIER_T1_VALUES = {"高", "highest", "high", "t1"}

# 硬门槛：这些状态的买家不进入下一轮
BLOCKED_STATES = {"bounced", "complained", "unsubscribed", "rejected",
                  "auto_reply", "退信", "投诉", "退订", "明确拒绝", "自动回复"}

ROUND_ANGLES = {                   # 每轮内容角度必须不同（配置化）
    1: "首触：产品 + 能力",
    2: "价值强化：认证 / 产能 / 案例 / 价格锚点",
    3: "机会型：展会邀约 / 限时 / 样品",
}

LINK_LINE = "跟进明细 → {url}"

# ── agent-in-the-loop（2026-09-17 客户定稿）─────────────────────────
# 分工：代码只做确定性的事（候选筛选 / 硬门槛 / 上限 / 幂等 / 发送前确认）；
# 策略与内容交给 agent，用**记忆 + 反思**决定「今天碰谁、隔几天、讲什么角度」，
# 且每次判断落一条 **decision log**（可审计），每轮结果回写成 **reflection**（自进化输入端）。
DECISION_LOG_NAME = "touch-decisions.jsonl"      # 落在 DC_DATA_DIR 下
REFLECTIONS_REL = ("memory", "projects", "dealclaw", "reflections.jsonl")   # 与早晚报「最近又学会了」同源


def effective_gap_days(tier: str, current_round: int, *, overrides: dict | None = None) -> int:
    """间隔天数：**默认建议表** + agent 覆盖。

    节奏表（T1=3/5、T2=7/10）是**默认建议**而非硬规则：agent 可依据反思（哪个市场、
    什么角度回得快）给出 `overrides`，例如 ``{"T1": 1}`` 表示高优先后隔 1 天就碰。
    覆盖值必须为正整数，非法值忽略（回退默认）—— 不让模型把节奏改坏。
    """
    if overrides:
        raw = overrides.get(tier)
        try:
            days = int(raw)
            if days > 0:
                return days
        except (TypeError, ValueError):
            pass
    return round_gap_days(tier, current_round)


def record_decision(data_dir, entry: dict) -> dict:
    """落一条触达决策日志（append-only，可审计/可回放）。"""
    from pathlib import Path
    import json as _json
    import os as _os

    base = Path(data_dir or _os.environ.get("DC_DATA_DIR") or ".")
    base.mkdir(parents=True, exist_ok=True)
    path = base / DECISION_LOG_NAME
    record = {"ts": datetime.now(timezone.utc).isoformat(), **(entry or {})}
    with path.open("a", encoding="utf-8") as fh:
        fh.write(_json.dumps(record, ensure_ascii=False) + "\n")
    return record


def list_decisions(data_dir, limit: int = 20) -> list[dict]:
    """读最近 N 条决策日志（坏的行走跳过，不抛）。"""
    from pathlib import Path
    import json as _json
    import os as _os

    path = Path(data_dir or _os.environ.get("DC_DATA_DIR") or ".") / DECISION_LOG_NAME
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            out.append(_json.loads(line))
        except Exception:  # noqa: BLE001
            continue
    return out[-limit:]


def write_reflection(what: str, *, round_no: int | None = None, angle: str = "",
                     outcome: str = "", workspace_root=None) -> bool:
    """把一轮触达的所学写回反思文件（早晚报「最近又学会了」同源）。

    写入位置：``<workspace_root>/memory/projects/dealclaw/reflections.jsonl``（append）；
    失败静默返回 False（反思不能影响主流程）。
    """
    from pathlib import Path
    import json as _json

    text = str(what or "").strip()
    if not text:
        return False
    try:
        root = Path(workspace_root) if workspace_root else Path(__file__).resolve().parent.parent.parent
        path = root.joinpath(*REFLECTIONS_REL)
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = {"ts": datetime.now(timezone.utc).isoformat(), "what": text,
                 "source": "touch_round"}
        if round_no is not None:
            entry["round"] = int(round_no)
        if angle:
            entry["angle"] = str(angle)
        if outcome:
            entry["outcome"] = str(outcome)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(_json.dumps(entry, ensure_ascii=False) + "\n")
        return True
    except Exception:  # noqa: BLE001
        return False


def decide_touch_plan(candidates: dict, *, decisions: list[dict] | None = None,
                      overrides: dict | None = None, now: datetime | None = None) -> dict:
    """把候选清单 × agent 决策合成「今天的触达计划」（确定性部分仍由代码兜底）。

    ``decisions`` 形如 ``[{"buyer": "A", "reason": "上周发了认证，本周发案例", "angle": "案例"}]``：
    agent 给的 **reason 必预保留**（早晚报要显示“为什么今天碰他”），但**硬门槛不可绕过**：
    不在候选里的买家（已回/退信/超轮次）即使被 agent 点名也不会被执行。
    """
    due = list((candidates or {}).get("due") or [])
    by_name = {str(d.get("buyer") or ""): dict(d) for d in due}
    plan: list[dict] = []
    rejected: list[dict] = []
    for item in decisions or []:
        name = str((item or {}).get("buyer") or "")
        if name not in by_name:
            rejected.append({"buyer": name, "reason": "不在候选（已回/退信/超轮次/未到期）"})
            continue
        merged = by_name[name]
        if item.get("reason"):
            merged["why"] = str(item["reason"])
        if item.get("angle"):
            merged["angle"] = str(item["angle"])
        merged["gap_days_used"] = effective_gap_days(merged.get("tier", "T2"),
                                                      max(1, int(merged.get("round", 2)) - 1),
                                                      overrides=overrides)
        plan.append(merged)
    plan.sort(key=lambda x: (x.get("tier") != "T1", str(x.get("due_at") or "")))
    return {"plan": plan, "rejected": rejected, "waiting": (candidates or {}).get("waiting") or {},
            "generated_at": (now or datetime.now(timezone.utc)).isoformat()}


def render_touch_plan_section(plan: dict) -> str:
    """早晚报里的「多轮触达（今天）」段：带 **为什么今天碰他**（agent 判断）。"""
    items = list((plan or {}).get("plan") or [])
    lines: list[str] = []
    for tier in ("T1", "T2"):
        tier_items = [i for i in items if i.get("tier") == tier]
        if not tier_items:
            continue
        lines.append(f"· {tier} {len(tier_items)} 家该做第 {tier_items[0].get('round')} 轮"
                     + (" → 一键生成草稿" if tier == "T1" else ""))
        for item in tier_items[:2]:
            why = str(item.get("why") or item.get("reason") or "").strip()
            angle = str(item.get("angle") or "").strip()
            if why or angle:
                lines.append(f"    - {item.get('buyer')}：{why}" + (f"（本轮角度：{angle}）" if angle else ""))
    waiting = {k: v for k, v in ((plan or {}).get("waiting") or {}).items() if v}
    if waiting:
        lines.append("（等待回复中：" + " · ".join(f"{k} {v}" for k, v in waiting.items()) + "）")
    return _section("■ 多轮触达（今天）", lines)


def tier_of(priority: str | None) -> str:
    """线索池「跟进优先级」→ T1 / T2（T1=高优先级）。未知一律按 T2（不激进）。"""
    value = str(priority or "").strip().lower()
    return "T1" if value in TIER_T1_VALUES else "T2"


def round_gap_days(tier: str, current_round: int) -> int:
    """当前轮次 → 下一轮间隔天数（按分层；越界返回最后一档）。"""
    gaps = ROUND_GAP_DAYS.get(tier, ROUND_GAP_DAYS["T2"])
    index = max(0, min(int(current_round or 1) - 1, len(gaps) - 1))
    return gaps[index]


def _parse_ts(value) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def plan_touch_rounds(records: Iterable[dict], *, now: datetime | None = None) -> dict:
    """多轮触达引擎（纯函数）：算「今天该做第 N 轮」的买家 + 等待中分布。

    每条 record 需要（缺省即跳过，不猜）：
      ``company``/``buyer`` 买家标识、``priority`` 线索池跟进优先级、
      ``touch_number`` 当前轮次（0=还没发过首触）、``last_touch_at`` 最近触达时间、
      ``replied`` 是否已回复、``state`` 状态（命中 BLOCKED_STATES 即停止序列）。
    返回 ``{"due": [...], "waiting": {"R1": n, "R2": n, "R3": n}, "stopped": [...]}``。
    """
    now = now or datetime.now(timezone.utc)
    due: list[dict] = []
    stopped: list[dict] = []
    waiting = {f"R{i}": 0 for i in range(1, MAX_ROUND + 1)}

    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        name = rec.get("company") or rec.get("buyer") or ""
        state = str(rec.get("state") or "").strip().lower()
        if rec.get("replied") or state in {s.lower() for s in BLOCKED_STATES}:
            stopped.append({"buyer": name, "reason": "replied" if rec.get("replied") else state})
            continue
        touch = max(0, int(rec.get("touch_number") or 0))
        if touch >= MAX_ROUND:
            stopped.append({"buyer": name, "reason": f"达到上限 R{MAX_ROUND}"})
            continue
        tier = tier_of(rec.get("priority"))
        if touch == 0:
            # 还没发过首触 → 今天就该发 R1（不依赖间隔）
            due.append({"buyer": name, "tier": tier, "round": 1, "angle": ROUND_ANGLES[1],
                        "due_at": now.isoformat(), "reason": "尚未首触"})
            continue
        last = _parse_ts(rec.get("last_touch_at"))
        if last is None:
            continue  # 没有触达时间就无法判断到期，不猜
        gaps = ROUND_GAP_DAYS.get(tier, ROUND_GAP_DAYS["T2"])
        gap = gaps[min(touch - 1, len(gaps) - 1)]
        due_at = last + timedelta(days=gap)
        entry = {"buyer": name, "tier": tier, "round": touch + 1,
                 "angle": ROUND_ANGLES.get(touch + 1, ""), "due_at": due_at.isoformat(),
                 "reason": f"R{touch} 后 {gap} 天未回"}
        if due_at <= now:
            due.append(entry)
        else:
            waiting[f"R{touch}"] += 1

    due.sort(key=lambda x: (x["tier"] != "T1", x["due_at"]))
    return {"due": due, "waiting": waiting, "stopped": stopped}


# ── 渲染 ────────────────────────────────────────────────────────────
def _bullets(items: Iterable[str], limit: int | None = None) -> list[str]:
    out = [f"· {str(x).strip()}" for x in items if str(x or "").strip()]
    return out[:limit] if limit else out


def _section(title: str, lines: list[str]) -> str:
    return title + "\n" + "\n".join(lines) if lines else ""


def render_morning(*, kind: str = "daily", date_label: str = "", done: list[str] | None = None,
                   judgement: list[str] | None = None, decisions: list[str] | None = None,
                   rounds: dict | None = None, learned: list[str] | None = None,
                   link: str = "", exhibition: str = "", stage_line: str = "") -> str:
    """早报渲染。``kind``: ``daily``（日常营销）｜``exhibition``（展会营销）。"""
    head = f"早上好 · {date_label}" if date_label else "早上好"
    head += " ｜ 日常" if kind == "daily" else (f" ｜ 展会·{exhibition}" if exhibition else " ｜ 展会")
    blocks: list[str] = [head]
    if stage_line:
        blocks.append(stage_line)                      # 只在阶段变化那天由调用方传入
    blocks.append(_section("■ 我帮你做了（近 24h）", _bullets(done or [])))
    blocks.append(_section("■ 我的判断（今天最值得先做）" if kind == "daily" else "■ 我的判断（展中优先级）",
                           _bullets(judgement or [], 3)))
    blocks.append(_section("■ 今天要你决定", _bullets(decisions or [], 3)))
    blocks.append(_render_rounds(rounds))
    blocks.append(_section("■ 最近又学会了", _bullets(learned or [], 3)))
    if link:
        blocks.append(LINK_LINE.format(url=link))       # 链接只出现一次
    return "\n\n".join(b for b in blocks if b)


def _render_rounds(rounds: dict | None) -> str:
    if not rounds:
        return ""
    due = rounds.get("due") or []
    waiting = rounds.get("waiting") or {}
    lines: list[str] = []
    for tier in ("T1", "T2"):
        items = [d for d in due if d.get("tier") == tier]
        if items:
            lines.append(f"· {tier} {len(items)} 家该做第 {items[0].get('round')} 轮"
                         + (" → 一键生成草稿" if tier == "T1" else ""))
    if not lines and not any(waiting.values()):
        return ""
    dist = " · ".join(f"{k} {v}" for k, v in waiting.items() if v)
    if dist:
        lines.append(f"（等待回复中：{dist}）")
    return _section("■ 多轮触达（今天）", lines)


def render_evening(*, date_label: str = "", settled: list[str] | None = None,
                   results: list[str] | None = None, rounds: dict | None = None,
                   first_thing_tomorrow: list[str] | None = None, link: str = "") -> str:
    """晚报渲染。关键词：收尾（核销不粉饰 / 战果 / 盘面 / 明日第一件事）。"""
    head = f"晚上好 · {date_label} ｜ 收尾" if date_label else "晚上好 ｜ 收尾"
    blocks = [
        head,
        _section("■ 今日核销", _bullets(settled or [])),
        _section("■ 今日战果", _bullets(results or [])),
        _section("■ 等待中的盘面", _bullets(_waiting_lines(rounds))),
        _section("■ 明日第一件事", _bullets(first_thing_tomorrow or [], 3)),
    ]
    if link:
        blocks.append(LINK_LINE.format(url=link))
    return "\n\n".join(b for b in blocks if b)


def _waiting_lines(rounds: dict | None) -> list[str]:
    if not rounds:
        return []
    waiting = {k: v for k, v in (rounds.get("waiting") or {}).items() if v}
    out = [" · ".join(f"{k} {v} 家" for k, v in waiting.items())] if waiting else []
    due = rounds.get("due") or []
    if due:
        t1 = len([d for d in due if d.get("tier") == "T1"])
        out.append(f"明天该触达 {len(due)} 家（T1 占 {t1}）")
    return out


def default_brief_actions(link: str = "") -> list[dict]:
    """早晚报卡片的底部按钮（**最轻量**：一个链接 + 两个待接线的动作）。

    ``value`` 形式的按钮由卡片回调消费；在回调接线前，它们只是按钮、不会自己发信。
    """
    actions: list[dict] = []
    if link:
        actions.append({"label": "📊 打开线索池", "url": str(link), "style": "primary"})
    actions.append({"label": "✍️ 一键生成草稿", "value": "brief:gen_draft"})
    actions.append({"label": "✅ 标记已处理", "value": "brief:mark_done"})
    return actions


def to_feishu_card(text: str, *, title: str = "DealClaw 早晚报",
                   actions: list[dict] | None = None) -> dict:
    """文本 → 飞书交互卡片（按「■ 段」拆块，可选底部按钮区）。"""
    elements: list[dict] = []
    for block in str(text or "").split("\n\n"):
        block = block.strip()
        if not block:
            continue
        elements.append({"tag": "div", "text": {"tag": "lark_md", "content": block}})
    buttons: list[dict] = []
    for action in actions or []:
        label = str((action or {}).get("label") or "").strip()
        if not label:
            continue
        button: dict = {"tag": "button", "type": str(action.get("style") or "default"),
                        "text": {"tag": "plain_text", "content": label}}
        if action.get("url"):
            button["url"] = str(action["url"])
        else:
            button["value"] = {"action": str(action.get("value") or "")}
        buttons.append(button)
    if buttons:
        elements.append({"tag": "action", "actions": buttons})
    return {
        "config": {"wide_screen_mode": True},
        "header": {"template": "blue", "title": {"tag": "plain_text", "content": title}},
        "elements": elements or [{"tag": "div", "text": {"tag": "lark_md", "content": "(空)"}}],
    }
