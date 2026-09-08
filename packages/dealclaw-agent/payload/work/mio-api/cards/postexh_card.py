#!/usr/bin/env python3
"""DealClaw 展后报告实时卡片状态机。

在 report 生成 worker 里这样用：:

    from postexh_card import write_card_state, launch

    state_path = "/tmp/after_exh_state.json"
    launch(target="oc_xxx", state_path=state_path)          # 起后台 runner，先显示「等待数据就绪」
    write_card_state(state_path, "cleaning")                # 每个阶段更新同一张卡
    write_card_state(state_path, "scoring")
    write_card_state(state_path, "drafting")
    write_card_state(state_path, "done", report_url="https://...", leads_url="https://...")
    # 或失败： write_card_state(state_path, "failed")

终端态卡片按钮：done = 「打开展后报告」「查看线索表」两个 URL 按钮（无回调）；
failed = 「重试」回调按钮，callback 值 `{"a": "after_exhibition.retry"}`。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
RUNNER = SCRIPT_DIR / "live-card-state-runner.cjs"
NODE = "node"

SUBTITLE = "出海精灵小元 · 展后线索整理与报告"

_STAGES: dict[str, dict] = {
    "awaiting_data": {
        "title": "展后报告 · 生成中",
        "subtitle": SUBTITLE,
        "status": "等待数据就绪",
        "color": "purple",
        "progress": 5,
        "summary": ["展会线索已进入线索池", "等待会议/互动记录完整入库", "幂等与并发 lease 校验中"],
    },
    "cleaning": {
        "title": "展后报告 · 生成中",
        "subtitle": SUBTITLE,
        "status": "线索清洗",
        "color": "purple",
        "progress": 20,
        "summary": ["去重、隐私脱敏、字段收敛进行中", "会议采集与互动记录整合中"],
    },
    "scoring": {
        "title": "展后报告 · 生成中",
        "subtitle": SUBTITLE,
        "status": "线索优先级排序",
        "color": "purple",
        "progress": 50,
        "summary": ["已按意向度 / 活跃度 / 行业匹配打分", "Top 线索已锁定"],
    },
    "drafting": {
        "title": "展后报告 · 生成中",
        "subtitle": SUBTITLE,
        "status": "生成报告正文",
        "color": "purple",
        "progress": 70,
        "summary": ["正在撰写报告", "同步写入交付物"],
    },
    "done": {
        "title": "展后报告 · 已完成",
        "subtitle": SUBTITLE,
        "status": "已交付",
        "color": "green",
        "progress": 100,
        "summary": ["报告已生成", "线索清单已写入飞书表格"],
        "done": True,
    },
    "failed": {
        "title": "展后报告 · 失败",
        "subtitle": SUBTITLE,
        "status": "生成失败",
        "color": "red",
        "progress": 100,
        "summary": ["报告生成中断", "可点击重试，或稍后查看日志"],
        "failed": True,
    },
}


def _build_dsl(stage: str, report_url: str | None = None, leads_url: str | None = None,
               timeout_ms: int | None = None, retry_q: str | None = None) -> dict:
    if stage not in _STAGES:
        raise ValueError(f"unknown stage: {stage!r}; valid: {sorted(_STAGES)}")
    dsl = dict(_STAGES[stage])
    if stage == "done":
        dsl["sections"] = [
            {"title": "报告要点", "lines": ["意向线索已清洗入库", "重点跟进线索已排序", "会议与互动记录已整合"]},
        ]
        dsl["actions"] = [
            {"text": "打开展后报告", "type": "primary_filled", "url": report_url or "https://example.com/report"},
            {"text": "查看线索表", "type": "default", "url": leads_url or "https://example.com/leads"},
        ]
    elif stage == "failed":
        # 重试按钮回调 = OpenClaw 结构化 quick 信封；用户点击后 OpenClaw 会把 q 作为
        # 合成命令分发给本群绑定的 agent（小元），从而重新触发报告生成。
        dsl["actions"] = [
            {"text": "重试", "type": "primary_filled",
             "callback": {"oc": "ocf1", "k": "quick", "a": "after_exhibition.retry",
                          "q": retry_q or "重新生成展后报告"}},
        ]
    if timeout_ms:
        dsl["timeoutMs"] = timeout_ms
    return dsl


def write_card_state(state_path: str, stage: str, report_url: str | None = None,
                     leads_url: str | None = None, timeout_ms: int | None = None,
                     retry_q: str | None = None) -> dict:
    """把某个阶段的卡片 DSL 原子写入 state.json，供 live-card-state-runner.cjs 原地更新。"""
    dsl = _build_dsl(stage, report_url, leads_url, timeout_ms, retry_q)
    p = Path(state_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(dsl, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)  # 原子替换，避免 runner 读到半截 JSON
    return dsl


def launch(target: str, state_path: str, timeout_ms: int | None = None):
    """起后台 live-card-state-runner.cjs，watch state.json 原地更新同一张卡。

    target 为 oc_ 群 id 或 ou_ 用户 id。返回 subprocess.Popen。
    """
    if not target:
        raise ValueError("target 不能为空（oc_ 群 id 或 ou_ 用户 id）")
    write_card_state(state_path, "awaiting_data", timeout_ms=timeout_ms)
    cmd = [NODE, str(RUNNER), target, str(state_path)]
    return subprocess.Popen(cmd, cwd=str(SCRIPT_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="DealClaw 展后报告实时卡片 CLI")
    ap.add_argument("target", nargs="?", default="",
                    help="oc_ 群 id 或 ou_ 用户 id（仅 awaiting_data 起卡时需要）")
    ap.add_argument("state_path", help="state.json 路径")
    ap.add_argument("stage", nargs="?", default="awaiting_data", choices=sorted(_STAGES),
                    help="阶段，可选 " + "/".join(sorted(_STAGES)))
    ap.add_argument("--report-url", default=None, help="done 态：报告链接")
    ap.add_argument("--leads-url", default=None, help="done 态：线索表链接")
    ap.add_argument("--retry-q", default=None, help="failed 态：重试按钮分发回 agent 的命令文本")
    ap.add_argument("--timeout-ms", type=int, default=None, help="runner 超时（毫秒）")
    args = ap.parse_args()

    if args.stage == "awaiting_data" and not args.target:
        ap.error("awaiting_data 阶段需要 target（oc_ 群 id 或 ou_ 用户 id）")

    write_card_state(args.state_path, args.stage,
                     report_url=args.report_url, leads_url=args.leads_url,
                     timeout_ms=args.timeout_ms, retry_q=args.retry_q)
    if args.stage == "awaiting_data":
        launch(args.target, args.state_path, timeout_ms=args.timeout_ms)
    print(json.dumps({"stage": args.stage, "state_path": args.state_path}, ensure_ascii=False))
