#!/usr/bin/env python3
"""
DC-BuyerState — 买家画像校准摘要持久化

每个 (enterprise_id, user_open_id) 绑定一份 buyer profile calibration summary。
脚本保存事实和建议，Agent 结合用户自然语言自行规划下一步。

数据结构:
    {
      "enterprise_id": "yiwu-yijie-jewelry",
      "user_open_id": "ou_xxx",
      "buyer_profile_status": "draft",
      "confidence": "medium",
      "ask_before_next_search": true,
      "next_action": "continue_current_profile",
      "next_batch_size": 10,
      "current_round": 0,
      "annotation_batch_count": 0,
      "consecutive_good_rounds": 0,
      "positive_examples": [],
      "negative_examples": [],
      "learned_rules": [],
      "current_search_profile": {},
      "pending_preferences": [],
      "last_user_correction": null,
      "updated_at": "2026-08-10T..."
    }

核心原则:
  - continue ≠ confirmed — "继续"只影响当前会话，不授权 cron 自动搜索
  - confirmed 才允许 cron 自动搜索
  - should_auto_search() 严格判断 confirmed + ask_before_next_search=false

用法:
    from dc_buyer_state import BuyerState

    state = BuyerState()
    profile = state.get_state("yiwu-yijie", "ou_xxx")
    state.update_state("yiwu-yijie", "ou_xxx", {"next_action": "enter_daily_automation"})
"""

import json
import os
from datetime import datetime, timezone
from typing import Optional


_DATA_DIR = os.environ.get("DC_DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
_STATE_FILE = os.path.join(_DATA_DIR, "buyer_profile_states.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


_DEFAULT_STATE = {
    "enterprise_id": "",
    "user_open_id": "",
    "buyer_profile_status": "draft",
    "confidence": "medium",
    "ask_before_next_search": True,
    "next_action": "continue_current_profile",
    "next_batch_size": 10,
    "current_round": 0,
    "annotation_batch_count": 0,
    "consecutive_good_rounds": 0,
    "positive_examples": [],
    "negative_examples": [],
    "learned_rules": [],
    "current_search_profile": {},
    "pending_preferences": [],
    "last_user_correction": None,
    "updated_at": None,
}


def _state_key(enterprise_id: str, user_open_id: str) -> str:
    return f"{enterprise_id}:{user_open_id}"


class BuyerState:
    """买家画像校准摘要 — 保存证据，给 Agent 提供下一步参考"""

    def __init__(self):
        os.makedirs(_DATA_DIR, exist_ok=True)
        self._states = self._load()

    def _load(self) -> dict:
        if os.path.exists(_STATE_FILE):
            try:
                with open(_STATE_FILE, encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return {}
        return {}

    def _save(self):
        with open(_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(self._states, f, ensure_ascii=False, indent=2)

    def _init_state(self, enterprise_id: str, user_open_id: str) -> dict:
        return {
            **_DEFAULT_STATE,
            "enterprise_id": enterprise_id,
            "user_open_id": user_open_id,
        }

    def get_state(self, enterprise_id: str, user_open_id: str = "default") -> dict:
        """获取当前状态，不存在的返回默认值"""
        key = _state_key(enterprise_id, user_open_id)
        if key not in self._states:
            self._states[key] = self._init_state(enterprise_id, user_open_id)
            self._save()
        return self._states[key]

    def update_state(self, enterprise_id: str, user_open_id: str, patch: dict) -> dict:
        """部分更新 state 字段。返回更新后的 state。"""
        key = _state_key(enterprise_id, user_open_id)
        current = self.get_state(enterprise_id, user_open_id)
        current.update(patch)
        current["updated_at"] = _now()
        self._states[key] = current
        self._save()
        return current

    @staticmethod
    def _merge_dict(base: dict, patch: dict) -> dict:
        """递归合并画像 patch；列表去重，标量以后者为准。"""
        result = dict(base or {})
        for key, value in (patch or {}).items():
            if isinstance(value, dict) and isinstance(result.get(key), dict):
                result[key] = BuyerState._merge_dict(result[key], value)
            elif isinstance(value, list) and isinstance(result.get(key), list):
                result[key] = list(dict.fromkeys(result[key] + value))
            else:
                result[key] = value
        return result

    @staticmethod
    def _profile_values(value, *keys: str) -> list:
        """Read a flexible profile node as a unique list of non-empty strings."""
        if isinstance(value, str):
            values = [value]
        elif isinstance(value, list):
            values = value
        elif isinstance(value, dict):
            values = []
            for key in keys:
                item = value.get(key)
                if isinstance(item, str):
                    values.append(item)
                elif isinstance(item, list):
                    values.extend(item)
        else:
            values = []
        return list(dict.fromkeys(str(item).strip() for item in values if str(item).strip()))

    @classmethod
    def compile_search_plan(cls, state: dict) -> dict:
        """Compile persisted profile corrections into concrete search inputs.

        The Agent may write a compact profile patch, but the next search needs
        executable values rather than a vague status.  This method deliberately
        accepts a few compatible field names while returning one stable schema.
        """
        profile = state.get("current_search_profile") or {}
        country_node = (
            profile.get("country")
            or profile.get("countries")
            or profile.get("target_countries")
        )
        buyer_node = profile.get("buyer_type") or profile.get("buyer_types")
        product_node = (
            profile.get("product")
            or profile.get("products")
            or profile.get("search_term")
            or profile.get("keywords")
        )

        countries = [v.upper() for v in cls._profile_values(
            country_node, "include", "prefer", "target", "values"
        )]
        excluded_countries = [v.upper() for v in cls._profile_values(
            country_node, "exclude", "avoid", "avoid_current"
        )]
        preferred_types = cls._profile_values(
            buyer_node, "include", "prefer", "target", "values"
        )
        avoided_types = cls._profile_values(
            buyer_node, "exclude", "avoid", "avoid_current", "suppress"
        )
        products = cls._profile_values(
            product_node, "include", "prefer", "target", "values"
        )

        type_codes = {
            "制造商": 1, "生产商": 1, "manufacturer": 1,
            "分销商": 2, "经销商": 2, "distributor": 2,
            "零售商": 3, "retailer": 3, "retail chain": 3,
            "电商": 4, "电商平台": 4, "ecommerce": 4,
            "代理商": 5, "承包商": 5, "agent": 5, "contractor": 5,
            "大型商超": 9, "商超": 9, "supermarket": 9,
        }
        company_attributes = []
        for label in preferred_types:
            code = type_codes.get(label.lower(), type_codes.get(label))
            if code and code not in company_attributes:
                company_attributes.append(code)

        return {
            "countries": countries,
            "excluded_countries": excluded_countries,
            "products": products,
            "preferred_buyer_types": preferred_types,
            "avoided_buyer_types": avoided_types,
            "company_attributes": company_attributes,
            "source_updated_at": state.get("updated_at"),
        }

    def get_search_plan(self, enterprise_id: str, user_open_id: str = "default") -> dict:
        """Return concrete parameters that the next search must consume."""
        return self.compile_search_plan(self.get_state(enterprise_id, user_open_id))

    def record_feedback_turn(
        self,
        enterprise_id: str,
        user_open_id: str,
        *,
        assessment: str,
        profile_patch: Optional[dict] = None,
        positive_examples: Optional[list] = None,
        negative_examples: Optional[list] = None,
        explicit_long_term_rules: Optional[list] = None,
        user_message: str = "",
    ) -> dict:
        """
        结算一次用户自然语言反馈。

        assessment 由 Agent 根据整句/整批反馈判断，而不是脚本做关键词分类：
          continue   — 只沿用当前方向继续这一轮
          correcting — 已识别偏差，并给出 profile_patch
          unclear    — 无法归因，需要问一个关键问题
          stable     — 用户明确认可，或 Agent 判断多轮方向已经稳定

        一次调用只算一轮。单条线索的内部 annotate 不推进轮次。
        """
        allowed = {"continue", "correcting", "unclear", "stable"}
        if assessment not in allowed:
            raise ValueError(f"invalid assessment: {assessment}")

        state = self.get_state(enterprise_id, user_open_id)
        state["current_round"] = state.get("current_round", 0) + 1

        for example in positive_examples or []:
            if example and example not in state["positive_examples"]:
                state["positive_examples"].append(example)
        for example in negative_examples or []:
            if example and example not in state["negative_examples"]:
                state["negative_examples"].append(example)

        if profile_patch:
            state["current_search_profile"] = self._merge_dict(
                state.get("current_search_profile", {}), profile_patch
            )
        if user_message:
            state["last_user_correction"] = user_message[:500]

        # 只有用户明确表达的长期规则才晋升；其余只作为候选证据。
        for rule in explicit_long_term_rules or []:
            if rule and rule not in state["learned_rules"]:
                state["learned_rules"].append(rule)

        if assessment == "continue":
            state["next_action"] = "continue_current_profile"
            state["ask_before_next_search"] = False
            # 不改变 confirmed/confidence。
        elif assessment == "correcting":
            state["buyer_profile_status"] = "corrected" if profile_patch else "correcting"
            state["confidence"] = "medium" if profile_patch else "low"
            state["next_action"] = (
                "rerun_with_updated_profile" if profile_patch
                else "ask_one_clarifying_question"
            )
            state["ask_before_next_search"] = not bool(profile_patch)
            state["consecutive_good_rounds"] = 0
        elif assessment == "unclear":
            state["buyer_profile_status"] = "correcting"
            state["confidence"] = "low"
            state["next_action"] = "ask_one_clarifying_question"
            state["ask_before_next_search"] = True
            state["consecutive_good_rounds"] = 0
        elif assessment == "stable":
            state["consecutive_good_rounds"] = state.get("consecutive_good_rounds", 0) + 1
            state["buyer_profile_status"] = "confirmed"
            state["confidence"] = "high"
            state["next_action"] = "continue_current_profile"
            state["ask_before_next_search"] = False

        state["updated_at"] = _now()
        self._states[_state_key(enterprise_id, user_open_id)] = state
        self._save()
        return state

    def record_review_round(self, enterprise_id: str, user_open_id: str,
                            positive_count: int, negative_count: int,
                            total_count: Optional[int] = None) -> dict:
        """
        兼容旧调用方：记录一批按钮标注的证据，但不把它算作自然语言对话轮次，
        也绝不因两个 ✅ 自动确认画像或进入自动化。
        """
        state = self.get_state(enterprise_id, user_open_id)
        state["annotation_batch_count"] = state.get("annotation_batch_count", 0) + 1
        total = total_count or (positive_count + negative_count)
        total = max(total, 1)
        state["last_annotation_batch"] = {
            "positive": positive_count,
            "negative": negative_count,
            "total": total,
        }

        if negative_count > positive_count:
            state["buyer_profile_status"] = "correcting"
            state["confidence"] = "low"
            state["consecutive_good_rounds"] = 0
            state["next_action"] = "attribute_feedback_or_ask_one_question"
        elif positive_count / total >= 0.5:
            state["buyer_profile_status"] = "corrected"
            state["confidence"] = "medium"
            state["next_action"] = "continue_current_profile"
        else:
            state["confidence"] = "medium"

        state["updated_at"] = _now()
        self._states[_state_key(enterprise_id, user_open_id)] = state
        self._save()
        return state

    def should_auto_search(self, enterprise_id: str, user_open_id: str = "default") -> bool:
        """
        严格判断：morning cron 是否应该自动搜索。

        条件:
          - buyer_profile_status == "confirmed"
          - ask_before_next_search is False
          - next_action in ("continue_current_profile", "enter_daily_automation")

        注意：用户说"继续"时，should_auto_search 不能变 true，除非 state 已 confirmed。
        """
        state = self.get_state(enterprise_id, user_open_id)
        return (
            state.get("buyer_profile_status") == "confirmed"
            and state.get("ask_before_next_search", True) is False
            and state.get("next_action") in (
                "continue_current_profile",
                "enter_daily_automation",
            )
        )

    def add_example(self, enterprise_id: str, user_open_id: str,
                    example: str, positive: bool) -> dict:
        """添加正/负例，不触发偏好晋升"""
        state = self.get_state(enterprise_id, user_open_id)
        if positive:
            if example not in state["positive_examples"]:
                state["positive_examples"].append(example)
        else:
            if example not in state["negative_examples"]:
                state["negative_examples"].append(example)
        state["updated_at"] = _now()
        self._states[_state_key(enterprise_id, user_open_id)] = state
        self._save()
        return state

    def add_learned_rule(self, enterprise_id: str, user_open_id: str,
                         rule: str) -> dict:
        """添加 learned rule（仅用户明确长期排除时调用）"""
        state = self.get_state(enterprise_id, user_open_id)
        if rule not in state["learned_rules"]:
            state["learned_rules"].append(rule)
        state["updated_at"] = _now()
        self._states[_state_key(enterprise_id, user_open_id)] = state
        self._save()
        return state

    def record_correction(self, enterprise_id: str, user_open_id: str,
                          correction: str) -> dict:
        """记录用户纠偏内容"""
        return self.update_state(enterprise_id, user_open_id, {
            "last_user_correction": correction,
            "buyer_profile_status": "correcting",
            "confidence": "low",
            "next_action": "rerun_with_updated_profile",
        })

    def confirm_profile(self, enterprise_id: str, user_open_id: str) -> dict:
        """用户说「这批不错 / 就按这个方向」→ 确认画像"""
        return self.update_state(enterprise_id, user_open_id, {
            "buyer_profile_status": "confirmed",
            "confidence": "high",
            "ask_before_next_search": False,
            "next_action": "continue_current_profile",
        })

    def continue_current(self, enterprise_id: str, user_open_id: str) -> dict:
        """
        用户说「继续」→ 不影响 confirmed 状态，只设 ask_before_next_search=false。

        注意：不设 buyer_profile_status=confirmed，不设 confidence=high。
        should_auto_search() 在此状态下仍返回 false（除非之前已 confirmed）。
        """
        return self.update_state(enterprise_id, user_open_id, {
            "ask_before_next_search": False,
            "next_action": "continue_current_profile",
        })


# ── CLI ──
if __name__ == "__main__":
    import sys
    bs = BuyerState()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"

    if cmd == "get":
        enterprise = sys.argv[2] if len(sys.argv) > 2 else "default"
        user = sys.argv[3] if len(sys.argv) > 3 else "default"
        print(json.dumps(bs.get_state(enterprise, user), ensure_ascii=False, indent=2))

    elif cmd == "update":
        enterprise = sys.argv[2]
        user = sys.argv[3] if len(sys.argv) > 3 else "default"
        fields = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
        print(json.dumps(bs.update_state(enterprise, user, fields), ensure_ascii=False, indent=2))

    elif cmd == "review":
        enterprise = sys.argv[2]
        user = sys.argv[3] if len(sys.argv) > 3 else "default"
        pos = int(sys.argv[4]) if len(sys.argv) > 4 else 0
        neg = int(sys.argv[5]) if len(sys.argv) > 5 else 0
        print(json.dumps(bs.record_review_round(enterprise, user, pos, neg),
                         ensure_ascii=False, indent=2))

    elif cmd == "auto_ready":
        enterprise = sys.argv[2]
        user = sys.argv[3] if len(sys.argv) > 3 else "default"
        print(json.dumps({"should_auto_search": bs.should_auto_search(enterprise, user)}))

    elif cmd == "continue":
        enterprise = sys.argv[2]
        user = sys.argv[3] if len(sys.argv) > 3 else "default"
        bs.continue_current(enterprise, user)
        print(json.dumps({
            "state": bs.get_state(enterprise, user),
            "should_auto_search": bs.should_auto_search(enterprise, user),
        }, ensure_ascii=False, indent=2))

    elif cmd == "confirm":
        enterprise = sys.argv[2]
        user = sys.argv[3] if len(sys.argv) > 3 else "default"
        bs.confirm_profile(enterprise, user)
        print(json.dumps({
            "state": bs.get_state(enterprise, user),
            "should_auto_search": bs.should_auto_search(enterprise, user),
        }, ensure_ascii=False, indent=2))

    else:
        print("Usage: get|update|review|auto_ready|continue|confirm")
