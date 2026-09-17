#!/usr/bin/env python3
"""dc_exhibition_policy.py — 展会邮件执行闸门（单一判定源，2026-09-15 用户定稿）

背景：skill 文档写了"谁自动发、谁需确认"，但过去只靠人/模型读规则判断，
代码里没有统一判定，容易出现"规则写了、跑起来还是照发"。

本模块把判定收敛成**一个函数**，发送侧与回信侧都调它，不允许各自再写一套：

发送侧 ``decide_send``
  · 展中 · 邀约到展位            → ✅ 免确认自动发
  · 展中 · 展中推荐 / 扫码 / 名片 OCR / 慧译慧记 → ⚠️ 需确认
  · 展后 · 邀约到展位跟进         → ⚠️ 需确认（大概率有意向与会谈记录）
  · 展后 · 推荐买家              → ⚠️ 需确认（先出名单）
  · 常态（非展会期）             → ⚠️ 需确认（常态外发铁律）

回信侧 ``decide_reply``
  · 展会期间 · 邀约到展位回信 + 资料齐备 → ✅ 自动回
  · 其余任何回信                 → ⚠️ 需确认

统一兜底：缺字段 / 缺资料 / 需报价 / 预约会议 / 意图不明 / 来源不明
            → ⚠️ 需确认（最保守）

用法::

    python3 dc_exhibition_policy.py send --source 邀约到展位 --stage 展中
    python3 dc_exhibition_policy.py reply --source 扫码买家 --stage 展中 --materials-ready
"""

from __future__ import annotations

import argparse
import json
import sys

# ── 来源取值（与线索池「来源」列一致）──────────────────────
CH_INVITED = "邀约到展位"
CH_ONSITE_RECOMMEND = "展中推荐"
CH_SCAN = "扫码买家"
CH_OCR_CARD = "名片OCR"
CH_HUIYI = "慧译慧记"
CH_EXPO_LEAD = "展会线索"
CH_AFTER_RECOMMEND = "展后推荐"
CH_BUYER_REFERRAL = "买家推荐"

# 展会阶段
STAGE_DURING = "展中"
STAGE_AFTER = "展后"
STAGE_NONE = "常态"

# 动作
AUTO_SEND = "auto_send"
CONFIRM = "confirm"

# ── 回落确认的硬条件（任一命中 → 必须确认，不看来源）───────────────
FALLBACK_FLAGS = {
    "missing_fields": "缺字段",
    "missing_materials": "缺资料",
    "needs_quote": "需报价",
    "needs_meeting": "预约会议",
    "intent_unclear": "意图不明",
    "source_unknown": "来源不明",
}


def _normalize_stage(stage: str, *, in_exhibition: bool | None = None) -> str:
    """把阶段归一到 展中 / 展后 / 常态。

    显式 stage 优先；没给就用 ``in_exhibition`` 判定（展会期内按「展中」处理）。
    """
    s = (stage or "").strip()
    if s in (STAGE_DURING, STAGE_AFTER, STAGE_NONE):
        return s
    if in_exhibition is True:
        return STAGE_DURING
    return STAGE_NONE


def decide_send(
    source_channel: str,
    *,
    stage: str = "",
    in_exhibition: bool | None = None,
    **flags,
) -> dict:
    """发送侧判定：返回 ``{"action", "reason", "source_channel", "stage"}``。

    ``action`` 为 ``auto_send``（免确认自动发）或 ``confirm``（需用户确认）。
    ``flags`` 支持 FALLBACK_FLAGS 里的键，任一为 True → 强制确认。
    """
    src = (source_channel or "").strip()
    st = _normalize_stage(stage, in_exhibition=in_exhibition)

    # 1) 最保守兜底：来源不明 / 缺料 / 需报价等，一律确认
    if not src:
        return _out(CONFIRM, "来源不明 → 按最保守处理", src, st)
    for key, label in FALLBACK_FLAGS.items():
        if flags.get(key):
            return _out(CONFIRM, f"{label} → 回落确认", src, st)

    # 2) 只有「展中 · 邀约到展位」免确认
    if st == STAGE_DURING and src == CH_INVITED:
        return _out(AUTO_SEND, "展中·邀约到展位：既定动作，免确认", src, st)

    # 3) 展后即使同来源也必须确认（大概率有意向与会谈记录）
    if st == STAGE_AFTER:
        return _out(CONFIRM, "展后跟进：需人工把关", src, st)

    return _out(CONFIRM, "非展中·邀约到展位 → 需确认", src, st)


def decide_reply(
    source_channel: str,
    *,
    stage: str = "",
    in_exhibition: bool | None = None,
    materials_ready: bool = False,
    **flags,
) -> dict:
    """回信侧判定：返回 ``{"action", "reason", ...}``。

    ``action`` 为 ``auto_reply``（自动回）或 ``confirm``（需用户确认）。
    只有「展会期间 · 邀约到展位 + 资料齐备」可自动回。
    """
    src = (source_channel or "").strip()
    st = _normalize_stage(stage, in_exhibition=in_exhibition)

    if not src:
        return _out(CONFIRM, "来源不明 → 回信按最保守处理", src, st, verb="auto_reply")
    for key, label in FALLBACK_FLAGS.items():
        if flags.get(key):
            return _out(CONFIRM, f"{label} → 回落确认", src, st, verb="auto_reply")

    if st != STAGE_DURING:
        return _out(CONFIRM, "非展会期间回信 → 需确认", src, st, verb="auto_reply")
    if src != CH_INVITED:
        return _out(CONFIRM, "非邀约来源回信 → 需确认", src, st, verb="auto_reply")
    if not materials_ready:
        return _out(CONFIRM, "邀约来源但资料不齐 → 需确认", src, st, verb="auto_reply")

    return _out(AUTO_SEND, "展会期间·邀约到展位且资料齐备 → 自动回", src, st, verb="auto_reply")


def _out(action: str, reason: str, src: str, stage: str, *, verb: str = "auto_send") -> dict:
    return {
        "action": action,
        "auto": action == AUTO_SEND,
        "reason": reason,
        "source_channel": src,
        "stage": stage,
        "verb": verb,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="展会邮件执行闸门判定")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("send", help="发送侧判定")
    sp.add_argument("--source", required=True, help="来源")
    sp.add_argument("--stage", default="", help="展中 / 展后 / 常态")
    sp.add_argument("--in-exhibition", action="store_true", help="当前处于展会期")
    for f in FALLBACK_FLAGS:
        sp.add_argument(f"--{f.replace('_', '-')}", action="store_true")

    rp = sub.add_parser("reply", help="回信侧判定")
    rp.add_argument("--source", required=True, help="来源")
    rp.add_argument("--stage", default="", help="展中 / 展后 / 常态")
    rp.add_argument("--in-exhibition", action="store_true", help="当前处于展会期")
    rp.add_argument("--materials-ready", action="store_true", help="资料齐备")
    for f in FALLBACK_FLAGS:
        rp.add_argument(f"--{f.replace('_', '-')}", action="store_true")

    a = p.parse_args(argv)
    flags = {f: getattr(a, f) for f in FALLBACK_FLAGS}
    if a.cmd == "send":
        res = decide_send(a.source, stage=a.stage, in_exhibition=a.in_exhibition or None, **flags)
    else:
        res = decide_reply(a.source, stage=a.stage, in_exhibition=a.in_exhibition or None,
                           materials_ready=a.materials_ready, **flags)
    res["ok"] = True
    print(json.dumps(res, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
