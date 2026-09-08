#!/usr/bin/env python3
"""market-report 实时进度卡：四节点推进 + 终态状态机。

套用 find-buyers 卡的四节点 + 终态状态机模式；渲染/发卡/原地更新交给
共享运行时 CardAdapter（work/mio-api/cards/card_adapter.py）。

用法：
    card = MarketReportCard(chat_id="oc_xxx")
    card.start()                       # 起卡
    card.scoping()                     # 步骤 1/4：国家+品类+证据口径锁定
    card.researching(tam="USD 120M")   # 步骤 2/4：市场规模/需求竞争/合规闸门
    card.scoring()                     # 步骤 3/4：选品评分+进入方案
    card.rendering()                   # 步骤 4/4：生成 HTML + 检查交付物
    card.finish_done(report_url="...") # 终态绿卡附报告链接
    # 或 card.fail() / card.partial(report_url=...) / card.cancel() / card.waiting_user()
"""
from __future__ import annotations

from card_adapter import CardAdapter

TERMINAL_STATES = {"done", "partial", "failed", "cancelled", "waiting_user"}

STEP_LABELS = {
    "scoping": "步骤 1/4",
    "researching": "步骤 2/4",
    "scoring": "步骤 3/4",
    "rendering": "步骤 4/4",
}
STEP_ORDER = {"scoping": 1, "researching": 2, "scoring": 3, "rendering": 4}

TITLE = "市场报告"


class MarketReportCard:
    """一张市场报告进度卡：从开始一路原地更新到终态。"""

    def __init__(self, chat_id: str, dry_run: bool = False):
        if not chat_id:
            raise ValueError("chat_id 不能为空（oc_ 群 id）")
        self.chat_id = chat_id
        self.dry_run = dry_run
        self.adapter = CardAdapter(chat_id=chat_id, dry_run=dry_run)
        self.state = "queued"
        self._last_step = ""

    def _advance(self, step: str, status: str, metrics: dict | None = None) -> None:
        if self.state in TERMINAL_STATES:
            return  # 终态不可被 running 覆盖
        if STEP_ORDER.get(step, 0) < STEP_ORDER.get(self._last_step, 0):
            return  # 旧阶段不可覆盖新阶段
        self.state = "running"
        self._last_step = step
        dsl = {
            "title": TITLE,
            "status": status,
            "state": "running",
            "step": STEP_LABELS.get(step, step),
            "metrics": [{"label": k, "value": v} for k, v in (metrics or {}).items() if v],
        }
        self.adapter.update(dsl)

    def _final(self, state: str, status: str, links: list | None = None,
               summary: list | None = None) -> None:
        if self.state in TERMINAL_STATES:
            return  # 终态不可被二次覆盖
        self.state = state
        dsl = {
            "title": TITLE,
            "status": status,
            "state": state,
            "links": links or [],
            "summary": summary or [],
        }
        self.adapter.update(dsl)

    def start(self) -> None:
        if self.adapter.message_id:
            return
        self.state = "running"
        self.adapter.send({
            "title": TITLE,
            "status": "开始处理",
            "state": "running",
            "summary": ["已收到报告请求"],
        })

    def scoping(self) -> None:
        self._advance("scoping", "已确认国家、品类与证据口径")

    def researching(self, **metrics) -> None:
        self._advance("researching", "市场规模 / 需求竞争 / 合规闸门核查中", metrics)

    def scoring(self, **metrics) -> None:
        self._advance("scoring", "选品池评分与进入方案制定中", metrics)

    def rendering(self) -> None:
        self._advance("rendering", "HTML 生成与交付物检查中")

    def finish_done(self, report_url: str = "") -> None:
        links = [{"text": "打开报告", "url": report_url}] if report_url else []
        self._final("done", "已完成", links=links, summary=["报告已生成并交付"])

    def partial(self, report_url: str = "") -> None:
        links = [{"text": "打开报告", "url": report_url}] if report_url else []
        self._final("partial", "部分完成（数据不足）", links=links,
                    summary=["部分维度数据不足，已在报告中标注缺口"])

    def fail(self) -> None:
        self._final("failed", "生成失败", summary=["报告生成中断，请稍后重试"])

    def cancel(self) -> None:
        self._final("cancelled", "已取消")

    def waiting_user(self) -> None:
        self._final("waiting_user", "等待补充信息",
                    summary=["缺少关键输入（国家或品类），请补充后继续"])
