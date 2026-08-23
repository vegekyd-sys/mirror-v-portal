#!/usr/bin/env python3
"""DC-Feedback — 自然语言买家画像纠偏入口（buyer-turn）

dealclaw-review 的唯一落盘入口。Agent 判断语义 → 脚本落盘：
  - profile_patch           → BuyerState（搜索画像快照，这轮生效）
  - explicit_long_term_rules → dc_rules.append_rule（长期规则 → rules.md，当轮原子写）

用法:
  python3 dc_feedback.py buyer-turn <enterprise> <user_open_id> <message> '<interpretation_json>'
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
FEEDBACK_FILE = DATA_DIR / "feedback.jsonl"


def _now():
    return datetime.now(timezone.utc).isoformat()


def record_buyer_feedback_turn(
    enterprise: str,
    user_open_id: str,
    user_message: str,
    interpretation: dict,
) -> dict:
    """记录一次自然语言买家画像反馈，并返回给 Agent 可读的校准摘要。

    interpretation 由 Agent 基于完整语义给出：

      {
        "assessment": "correcting",
        "profile_patch": {"buyer_type": {"prefer": ["品牌商"], "avoid_current": ["分销商"]}},
        "positive_examples": ["A GmbH"],
        "negative_examples": ["B Trading"],
        "explicit_long_term_rules": ["东南亚只做印尼、越南，泰国不碰"],
        "behavior": ["用户跳过贸易商", "用户追问交期"]
      }

    assessment: continue | correcting | unclear | stable
    """
    if not enterprise:
        raise ValueError("enterprise is required")
    if not user_message or not user_message.strip():
        raise ValueError("user_message is required")
    if not isinstance(interpretation, dict):
        raise ValueError("interpretation must be an object")

    assessment = interpretation.get("assessment", "unclear")
    profile_patch = interpretation.get("profile_patch") or {}
    positives = interpretation.get("positive_examples") or []
    negatives = interpretation.get("negative_examples") or []
    long_term_rules = interpretation.get("explicit_long_term_rules") or []
    behavior = interpretation.get("behavior") or []

    entry = {
        "_ts": _now(),
        "type": "buyer_feedback_turn",
        "user_message": user_message[:500],
        "enterprise": enterprise,
        "user_open_id": user_open_id or "default",
        "interpretation": {
            "assessment": assessment,
            "profile_patch": profile_patch,
            "positive_examples": positives,
            "negative_examples": negatives,
            "explicit_long_term_rules": long_term_rules,
            "behavior": behavior,
        },
        "applied": True,
        "applied_at": _now(),
    }
    os.makedirs(str(DATA_DIR), exist_ok=True)
    with open(FEEDBACK_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    from dc_buyer_state import BuyerState
    state = BuyerState().record_feedback_turn(
        enterprise,
        user_open_id or "default",
        assessment=assessment,
        profile_patch=profile_patch,
        positive_examples=positives,
        negative_examples=negatives,
        explicit_long_term_rules=long_term_rules,
        user_message=user_message,
    )

    # 长期规则当轮原子写入 rules.md（接上 SOUL「记进画像」承诺，避免「假装做过」）
    rules_written = []
    if long_term_rules:
        try:
            from dc_rules import append_rule
            for rule in long_term_rules:
                r = append_rule(enterprise, rule, source=f"纠偏：{user_message[:60]}")
                if r.get("status") == "ok":
                    rules_written.append(rule)
        except Exception as e:
            rules_written = [f"error: {e}"]

    return {
        "assessment": assessment,
        "current_round": state.get("current_round", 0),
        "current_search_profile": state.get("current_search_profile", {}),
        "confirmed": state.get("buyer_profile_status") == "confirmed",
        "ask_one_question": state.get("next_action") == "ask_one_clarifying_question",
        "recommended_action": state.get("next_action"),
        "should_auto_search": BuyerState().should_auto_search(
            enterprise, user_open_id or "default"
        ),
        "long_term_rules_written": rules_written,
    }


if __name__ == "__main__":
    if len(sys.argv) < 6 or sys.argv[1] != "buyer-turn":
        print("用法: dc_feedback.py buyer-turn <enterprise> <user_open_id> <message> '<interpretation_json>'")
        sys.exit(1)
    result = record_buyer_feedback_turn(
        enterprise=sys.argv[2],
        user_open_id=sys.argv[3],
        user_message=sys.argv[4],
        interpretation=json.loads(sys.argv[5]),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
