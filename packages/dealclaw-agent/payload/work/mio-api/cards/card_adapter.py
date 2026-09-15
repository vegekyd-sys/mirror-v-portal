#!/usr/bin/env python3
"""统一飞书卡片适配器（Card Adapter）— 共享运行时能力。

定位（田耕郡 2026-09-08 定）：
  放共享运行时目录 work/mio-api/cards/，供 find-buyers、展后报告等 skill 引用；
  Skill 只引用本共享能力，不拥有公共基础设施。

第一版实现方式（关键修订）：
  不采用「一任务一个轮询 Node 进程」（旧 live-card-state-runner.cjs 模式）。
  编排器在业务节点直接调用本适配器，通过 lark-cli：
    - 发卡：`im +messages-send --msg-type interactive` 拿 message_id
    - 原地更新：`im messages patch --message-id <id>` 更新同一张卡
  全程纯 Python 同步调用，无常驻进程、无孤儿 Node WebSocket。

职责边界：
  - 本适配器只负责「把 DSL 渲染成卡片 JSON + 发卡 + 按 message_id 原地更新 + 节流」。
  - 不负责业务状态机（4 节点、终态规则、job 状态文件）——那些由 find_buyers_card.py 管。
  - 不显示内部评分、个人联系方式、接口错误栈；不伪造百分比或 ETA。
"""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from typing import Optional

# 飞书卡片 header 支持的颜色模板（template 字段）
HEADER_COLORS = {"blue", "wathet", "turquoise", "green", "yellow",
                 "orange", "red", "carmine", "violet", "purple", "indigo", "grey"}

# 步骤→颜色映射：进行中用紫，done 绿，failed/cancelled 灰，waiting_user/partial 黄
_STATUS_COLOR = {
    "running": "purple",
    "queued": "grey",
    "done": "green",
    "partial": "yellow",
    "waiting_user": "yellow",
    "failed": "red",
    "cancelled": "grey",
}

# 状态→emoji：让卡片更有辨识度
_STATUS_EMOJI = {
    "running": "🔄",
    "queued": "⏳",
    "done": "✅",
    "partial": "⚠️",
    "waiting_user": "⏸️",
    "failed": "❌",
    "cancelled": "🚫",
}

# 四个步骤→图标（按步骤序号）
_STEP_ICON = {"1": "🎯", "2": "🔍", "3": "🧪", "4": "📥"}

# 指标 label→图标
_METRIC_ICON = {
    "已翻页": "📄",
    "候选买家": "🏢",
    "合格买家": "✅",
    "入池": "📥",
    "找到买家": "🎯",
}

# 卡片内买家明细的渲染上限。
# 2026-09-15：原为硬编码 `buyers[:10]`，超过 10 家时**静默丢明细**（现场 49 家事故的同源问题）。
# 现改为：默认对齐红线「单次交付上限 50 家」，可由 DSL `max_buyers` 覆盖；
# 万一仍超出上限，也必须显式告知剩余条数，不再静默丢弃。
MAX_CARD_BUYERS = 50


def _step_number(step: str) -> int:
    """从「步骤 2/4」这类文案里解析当前步骤序号，解析不到返回 0。"""
    m = re.search(r"(\d+)\s*/\s*(\d+)", str(step or ""))
    if m:
        return int(m.group(1))
    return 0


def _progress_dots(current: int, total: int, done: bool = False) -> str:
    """把步骤进度渲染成圆点：已完成🟢 / 当前🔵 / 待处理⚪；终态全绿。"""
    if total < 1:
        return ""
    parts = []
    for i in range(1, total + 1):
        if done:
            parts.append("🟢")
        elif i < current:
            parts.append("🟢")
        elif i == current:
            parts.append("🔵")
        else:
            parts.append("⚪")
    return "".join(parts)


@dataclass
class SendResult:
    ok: bool
    message_id: str = ""
    error: str = ""
    dry_run: bool = False
    skipped: bool = False  # 节流命中，未实际更新


def _normalize_color(color: str) -> str:
    return color if color in HEADER_COLORS else "purple"


def _run_lark(args: list[str], timeout: int = 30) -> tuple[bool, dict, str]:
    """执行 lark-cli，返回 (ok, parsed_json, errmsg)。"""
    cmd = ["lark-cli"] + args
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return False, {}, "lark-cli not found"
    except subprocess.TimeoutExpired:
        return False, {}, "lark-cli timeout"
    out = (p.stdout or "").strip()
    if p.returncode != 0:
        err = (p.stderr or out or "lark-cli failed")[-300:]
        return False, {}, err
    try:
        data = json.loads(out) if out else {}
    except json.JSONDecodeError:
        return False, {}, f"lark-cli 返回非 JSON: {out[:200]}"
    if not data.get("ok"):
        err = (data.get("error") or {}).get("message") if isinstance(data.get("error"), dict) else "未知错误"
        return False, data, str(err)
    return True, data, ""


def _extract_message_id(data: dict) -> str:
    """从 lark-cli send 响应里尽力提取 message_id。"""
    d = data.get("data") if isinstance(data.get("data"), dict) else data
    return str(d.get("message_id") or d.get("messageId") or "")


def render_card(dsl: dict) -> dict:
    """DSL → 飞书卡片 JSON v2（完整结构，send / patch 通用）。

    DSL 字段：
      title           卡片标题（header.title）
      status          状态文案（一行突出显示）
      color           header 模板色，缺省按 status 映射
      step            「步骤 2/4」这类步骤标识（可选，有才显示）
      summary         1-3 条关键结论（可选）
      metrics         真实数字列表 [{label, value}]，有值才显示，不伪造
      links           open_url 按钮 [{text, url}]
      buyers          买家明细列表（可选，终态卡用）：[{name, website, country, need, reason}]，
                      reason 必须是用户可理解的短解释，不含内部评分/权重（红线）
      max_buyers      卡片内买家明细的渲染上限（可选，默认 MAX_CARD_BUYERS=50，对齐单次交付上限）；
                      超出上限会显式告知剩余条数，不再静默丢弃明细
      subtitle        顶部灰字（可选，如「出海精灵小元 · 展后线索整理与报告」）
      progress        进度百分比 0-100（可选，渲染进度条）
      actions         通用按钮 [{text, type, url | callback}]：url → open_url，callback → callback
                      （callback 用于「重试」等回推机制，不能丢）
    """
    title = str(dsl.get("title") or "任务")
    status = str(dsl.get("status") or "")
    state = str(dsl.get("state") or "")
    color = _normalize_color(dsl.get("color") or _STATUS_COLOR.get(state, "purple"))
    emoji = _STATUS_EMOJI.get(state, "")

    elements: list = []

    # 顶部灰字（subtitle）
    subtitle = str(dsl.get("subtitle") or "").strip()
    if subtitle:
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md", "content": f"<font color='grey'>{subtitle}</font>"},
        })

    # 步骤标识（「步骤 2/4」+ 图标 + 进度圆点，不用百分比）
    step = dsl.get("step")
    if step:
        n = _step_number(str(step))
        icon = _STEP_ICON.get(str(n), "📍")
        dots = _progress_dots(n, 4)
        content = f"**{icon} {step}**"
        if dots:
            content += f"　{dots}"
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md", "content": content},
        })

    # 状态行（带 emoji）
    if status:
        prefix = f"{emoji} " if emoji else ""
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md", "content": f"<font color='{color}'>●</font> {prefix}{status}"},
        })

    # 进度条（百分比，可选）
    progress = dsl.get("progress")
    if isinstance(progress, (int, float)):
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md", "content": _progress_bar(progress)},
        })

    # 真实数字（有才显示，不伪造），带指标图标
    metrics = [m for m in (dsl.get("metrics") or []) if isinstance(m, dict) and m.get("value")]
    if metrics:
        lines = "  ".join(
            f"{_METRIC_ICON.get(m.get('label', ''), '•')} {m.get('label', '')} **{m.get('value')}**"
            for m in metrics
        )
        elements.append({"tag": "div", "text": {"tag": "lark_md", "content": lines}})

    # 摘要
    summary = [s for s in (dsl.get("summary") or []) if s]
    if summary:
        marker = "▫"
        lines = "\n".join(f"{marker} {s}" for s in summary[:3])
        elements.append({"tag": "div", "text": {"tag": "lark_md", "content": lines}})

    # 买家明细（仅终态卡用；reason 必须是用户可理解的短解释，不含内部评分/权重）
    buyers = [b for b in (dsl.get("buyers") or []) if isinstance(b, dict)]
    if buyers:
        cap = dsl.get("max_buyers")
        if not isinstance(cap, int) or isinstance(cap, bool) or cap < 1:
            cap = MAX_CARD_BUYERS
        shown = buyers[:cap]
        elements.append({"tag": "hr"})
        for i, b in enumerate(shown, 1):
            name = str(b.get("name") or "").strip()
            website = str(b.get("website") or "").strip()
            country = str(b.get("country") or "").strip()
            need = str(b.get("need") or "").strip()
            reason = str(b.get("reason") or "").strip()
            lines = [f"**{i}. {name}**"]
            meta = "  ".join(x for x in (
                f"🌐 {website}" if website else "",
                f"📍 {country}" if country else "",
            ) if x)
            if meta:
                lines.append(meta)
            if need:
                lines.append(f"采购需求：{need}")
            if reason:
                lines.append(f"🟢 {reason}")
            elements.append({"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(lines)}})
        if len(buyers) > len(shown):
            # 不再静默丢明细：显式告知剩余条数与去向。
            elements.append({
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": f"… 另有 {len(buyers) - len(shown)} 家未在卡片展开（超出卡片长度上限），完整名单见企业线索池。",
                },
            })

    # open_url 按钮（links，向后兼容）
    links = [l for l in (dsl.get("links") or []) if isinstance(l, dict) and l.get("url")]
    if links:
        if len(links) == 1:
            buttons = [_button(links[0]["text"], links[0]["url"])]
        else:
            cols = []
            for l in links[:2]:
                cols.append({
                    "tag": "column",
                    "width": "weighted",
                    "weight": 1,
                    "elements": [_button(l["text"], l["url"])],
                })
            buttons = [{"tag": "column_set", "flex_mode": "bisect",
                        "background_style": "default", "columns": cols}]
        elements.append({"tag": "hr"})
        elements.extend(buttons)

    # 通用动作按钮（actions：open_url 或 callback；callback 用于「重试」等回推机制）
    actions = [a for a in (dsl.get("actions") or []) if isinstance(a, dict)]
    if actions:
        if len(actions) == 1:
            buttons = [_action_button(actions[0])]
        else:
            cols = []
            for a in actions[:2]:
                cols.append({
                    "tag": "column",
                    "width": "weighted",
                    "weight": 1,
                    "elements": [_action_button(a)],
                })
            buttons = [{"tag": "column_set", "flex_mode": "bisect",
                        "background_style": "default", "columns": cols}]
        elements.append({"tag": "hr"})
        elements.extend(buttons)

    return {
        "schema": "2.0",
        "config": {"width_mode": "fill"},
        "header": {"template": color, "title": {"tag": "plain_text", "content": title}},
        "body": {"elements": elements},
    }


def _button(text: str, url: str) -> dict:
    return {
        "tag": "button",
        "text": {"tag": "plain_text", "content": text},
        "type": "primary",
        "width": "fill",
        "behaviors": [{"type": "open_url", "default_url": url}],
    }


def _action_button(action: dict) -> dict:
    """通用按钮：有 url → open_url；否则 → callback（value 为 action['callback']）。

    用于「重试」等回推机制（OpenClaw 结构化 quick 信封），不能丢。
    """
    btn = {
        "tag": "button",
        "text": {"tag": "plain_text", "content": str(action.get("text") or "按钮")},
        "type": action.get("type") or "primary",
        "width": "fill",
    }
    if action.get("url"):
        btn["behaviors"] = [{"type": "open_url", "default_url": str(action["url"])}]
    else:
        btn["behaviors"] = [{"type": "callback", "value": action.get("callback") or {}}]
    return btn


def _progress_bar(pct) -> str:
    """把 0-100 渲染成进度条（▰▱ 12 段 + 百分比）。"""
    try:
        p = max(0, min(100, int(round(float(pct)))))
    except (TypeError, ValueError):
        return ""
    n = 12
    done = round(p / 100 * n)
    return "▰" * done + f"<font color='grey'>{'▱' * (n - done)}</font>  {p}%"


def _throttle_key(dsl: dict) -> str:
    """节流键：只含影响卡片显示的字段。summary 文案同一步内不变，不计入。

    这样「阶段不变 + 真实数字不变」时 key 不变 → 跳过 patch。
    """
    return json.dumps({
        "step": dsl.get("step"),
        "status": dsl.get("status"),
        "color": dsl.get("color"),
        "metrics": [(m.get("label"), m.get("value")) for m in (dsl.get("metrics") or [])],
        "links": [(l.get("text"), l.get("url")) for l in (dsl.get("links") or [])],
        "subtitle": dsl.get("subtitle"),
        "progress": dsl.get("progress"),
        "actions": [(a.get("text"), a.get("url"), a.get("callback")) for a in (dsl.get("actions") or [])],
    }, ensure_ascii=False, sort_keys=True)


class CardAdapter:
    """一张卡：发一次，之后原地更新同一 message_id。带节流。"""

    def __init__(self, chat_id: str = "", dry_run: bool = False):
        self.chat_id = chat_id
        self.dry_run = dry_run
        self.message_id = ""
        self._last_key: Optional[str] = None

    # ── 发卡 ──
    def send(self, dsl: dict, chat_id: str = "") -> SendResult:
        target = chat_id or self.chat_id
        if not target:
            return SendResult(ok=False, error="缺少 chat_id（oc_ 群 id）")
        card_json = json.dumps(render_card(dsl), ensure_ascii=False)
        if self.dry_run:
            self.message_id = "dry_run_id"
            self.chat_id = target
            self._last_key = _throttle_key(dsl)
            return SendResult(ok=True, dry_run=True, message_id="dry_run_id")
        ok, data, err = _run_lark([
            "im", "+messages-send", "--chat-id", target,
            "--msg-type", "interactive", "--content", card_json,
            "--as", "bot", "--json",
        ])
        if not ok:
            return SendResult(ok=False, error=err)
        mid = _extract_message_id(data)
        self.message_id = mid
        self.chat_id = target
        self._last_key = _throttle_key(dsl)
        return SendResult(ok=True, message_id=mid)

    # ── 原地更新（带节流）──
    def update(self, dsl: dict) -> SendResult:
        if not self.message_id:
            return self.send(dsl)
        key = _throttle_key(dsl)
        if key == self._last_key:
            # 同一状态重复写入 → 不更新
            return SendResult(ok=True, message_id=self.message_id, skipped=True)
        card_json = json.dumps(render_card(dsl), ensure_ascii=False)
        if self.dry_run:
            self._last_key = key
            return SendResult(ok=True, message_id=self.message_id, dry_run=True)
        ok, data, err = _run_lark([
            "im", "messages", "patch", "--message-id", self.message_id,
            "--data", json.dumps({"content": card_json}, ensure_ascii=False),
            "--as", "bot", "--json",
        ])
        if not ok:
            # patch 失败不影响搜索事实，返回失败但不抛
            return SendResult(ok=False, message_id=self.message_id, error=err)
        self._last_key = key
        return SendResult(ok=True, message_id=self.message_id)


if __name__ == "__main__":
    # 独立调试：打印 DSL 渲染结果
    import sys
    demo = {
        "title": "找买家",
        "status": "正在建立候选池",
        "state": "running",
        "step": "步骤 2/4",
        "metrics": [{"label": "已翻页", "value": "3 页"}, {"label": "候选买家", "value": "200 家"}],
        "summary": ["已确认国家、产品、买家类型", "展会范围已锁定"],
        "links": [{"text": "打开线索池", "url": "https://example.com"}],
    }
    print(json.dumps(render_card(demo), ensure_ascii=False, indent=2))
