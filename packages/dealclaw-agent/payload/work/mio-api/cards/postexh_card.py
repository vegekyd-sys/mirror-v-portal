#!/usr/bin/env python3
"""DealClaw 展后报告实时进度卡（CardAdapter 版，迁移自旧 Node runner 机制）。

复用共享运行时 CardAdapter：纯 Python 同步调 lark-cli 发卡/原地更新，不起 Node 进程、无孤儿 WebSocket。
state_path 只用于持久化 message_id，跨进程恢复同一张卡原地更新。

状态机：awaiting_data → cleaning → scoring → drafting → done / failed

「重试」按钮（failed 态）callback 是 OpenClaw 结构化 quick 信封（推送机制，必须保留）：
    {"oc": "ocf1", "k": "quick", "a": "after_exhibition.retry", "q": "<命令>"}
用户点击后 OpenClaw 把 q 作为合成命令分发给本群绑定的 agent（小元），据此重新触发报告生成。

CLI（与旧版兼容，路径指向共享运行时）：
    python3 work/mio-api/cards/postexh_card.py <target> <state_path> awaiting_data
    python3 work/mio-api/cards/postexh_card.py <target> <state_path> cleaning
    python3 work/mio-api/cards/postexh_card.py <target> <state_path> scoring
    python3 work/mio-api/cards/postexh_card.py <target> <state_path> drafting
    python3 work/mio-api/cards/postexh_card.py <target> <state_path> done --report-url ... --leads-url ...
    python3 work/mio-api/cards/postexh_card.py <target> <state_path> failed --retry-q "..."
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from card_adapter import CardAdapter

SUBTITLE = "出海精灵小元 · 展后线索整理与报告"

_STAGES: dict[str, dict] = {
    "awaiting_data": {
        "title": "展后报告 · 生成中",
        "status": "等待数据就绪",
        "color": "purple",
        "progress": 5,
        "summary": ["展会线索已进入线索池", "等待会议/互动记录完整入库", "幂等与并发 lease 校验中"],
    },
    "cleaning": {
        "title": "展后报告 · 生成中",
        "status": "线索清洗",
        "color": "purple",
        "progress": 20,
        "summary": ["去重、隐私脱敏、字段收敛进行中", "会议采集与互动记录整合中"],
    },
    "scoring": {
        "title": "展后报告 · 生成中",
        "status": "线索优先级排序",
        "color": "purple",
        "progress": 50,
        "summary": ["已按意向度 / 活跃度 / 行业匹配打分", "Top 线索已锁定"],
    },
    "drafting": {
        "title": "展后报告 · 生成中",
        "status": "生成报告正文",
        "color": "purple",
        "progress": 70,
        "summary": ["正在撰写报告", "同步写入交付物"],
    },
    "done": {
        "title": "展后报告 · 已完成",
        "status": "已交付",
        "color": "green",
        "progress": 100,
        "summary": ["报告已生成", "线索清单已写入飞书表格"],
        "state": "done",
    },
    "failed": {
        "title": "展后报告 · 失败",
        "status": "生成失败",
        "color": "red",
        "progress": 100,
        "summary": ["报告生成中断", "可点击重试，或稍后查看日志"],
        "state": "failed",
    },
}


def _build_dsl(stage: str, report_url: str | None = None, leads_url: str | None = None,
               retry_q: str | None = None) -> dict:
    if stage not in _STAGES:
        raise ValueError(f"unknown stage: {stage!r}; valid: {sorted(_STAGES)}")
    spec = _STAGES[stage]
    dsl = {
        "title": spec["title"],
        "subtitle": SUBTITLE,
        "status": spec["status"],
        "state": spec.get("state", "running"),
        "color": spec["color"],
        "progress": spec["progress"],
        "summary": spec["summary"],
    }
    if stage == "done":
        # done 态两个交付物是 URL 按钮（open_url，无回调）
        dsl["actions"] = [
            {"text": "打开展后报告", "type": "primary", "url": report_url or "https://example.com/report"},
            {"text": "查看线索表", "type": "default", "url": leads_url or "https://example.com/leads"},
        ]
    elif stage == "failed":
        # 重试按钮 = OpenClaw 结构化 quick 信封（推送机制，必须保留）
        dsl["actions"] = [
            {"text": "重试", "type": "primary",
             "callback": {"oc": "ocf1", "k": "quick", "a": "after_exhibition.retry",
                          "q": retry_q or "重新生成展后报告"}},
        ]
    return dsl


def _load_message_id(state_path: str) -> str:
    try:
        data = json.loads(Path(state_path).read_text(encoding="utf-8"))
        return str((data or {}).get("message_id") or "").strip()
    except (OSError, json.JSONDecodeError):
        return ""


def _persist(state_path: str, message_id: str, stage: str) -> None:
    p = Path(state_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps({"message_id": message_id, "stage": stage},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def _run(target: str, state_path: str, stage: str, report_url: str | None = None,
         leads_url: str | None = None, retry_q: str | None = None,
         dry_run: bool = False) -> dict:
    if not target:
        raise ValueError("target 不能为空（oc_ 群 id 或 ou_ 用户 id）")
    dsl = _build_dsl(stage, report_url=report_url, leads_url=leads_url, retry_q=retry_q)
    adapter = CardAdapter(chat_id=target, dry_run=dry_run)
    adapter.message_id = _load_message_id(state_path)

    if stage == "awaiting_data" or not adapter.message_id:
        # 首次起卡：发新卡；之后原地更新同一张卡
        result = adapter.send(dsl)
    else:
        result = adapter.update(dsl)

    _persist(state_path, adapter.message_id, stage)
    return {"ok": result.ok, "stage": stage, "message_id": adapter.message_id,
            "state_path": state_path, "skipped": result.skipped}


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="DealClaw 展后报告实时进度卡（CardAdapter 版）")
    ap.add_argument("target", help="oc_ 群 id 或 ou_ 用户 id（仅起卡时需要）")
    ap.add_argument("state_path", help="state.json 路径（持久化 message_id）")
    ap.add_argument("stage", nargs="?", default="awaiting_data", choices=sorted(_STAGES),
                    help="阶段，可选 " + "/".join(sorted(_STAGES)))
    ap.add_argument("--report-url", default=None, help="done 态：报告链接")
    ap.add_argument("--leads-url", default=None, help="done 态：线索表链接")
    ap.add_argument("--retry-q", default=None, help="failed 态：重试按钮分发回 agent 的命令文本")
    ap.add_argument("--dry-run", action="store_true", help="只渲染不实际发卡")
    args = ap.parse_args()

    try:
        out = _run(args.target, args.state_path, args.stage,
                   report_url=args.report_url, leads_url=args.leads_url,
                   retry_q=args.retry_q, dry_run=args.dry_run)
    except ValueError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(2)
    print(json.dumps(out, ensure_ascii=False))
