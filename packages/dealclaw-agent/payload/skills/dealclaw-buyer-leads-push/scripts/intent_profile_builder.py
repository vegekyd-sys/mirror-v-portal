#!/usr/bin/env python3
"""Intent-based profile builder (意图式画像确认).

Replaces hard draft-version confirmation for the intent path. The minimum
viable hunting profile is 产品(含类目) + 目标国家. Fields the user stated
themselves (`user_stated`) need no further confirmation; fields inferred from
group history or websites (`inferred`) require one explicit approval signal.
When core slots are missing, the builder emits exactly one follow-up
question and never repeats it daily.

Commands:
    assess    — validate an intent projection and decide readiness
    confirm   — recognize an approval signal in a same-group user message
    self-test
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from typing import Any


class IntentProfileError(RuntimeError):
    """Raised when an intent projection cannot produce a safe profile."""


APPROVAL_SIGNALS = (
    "这批没问题", "没问题", "继续往下推", "继续推", "继续", "再找",
    "就按这个方向", "按这个方向", "可以", "就这样", "好的", "确认",
)
REJECTION_SIGNALS = (
    "不对", "不是", "别推", "停止", "取消", "修改", "换一个", "不行",
)
CORE_SLOTS = ("products", "target_countries")
SLOT_LABELS = {
    "products": "主营产品及所属类目",
    "target_countries": "目标国家/市场",
}


def normalized(value: Any) -> str:
    return " ".join(value.split()).casefold() if isinstance(value, str) else ""


def require_text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise IntentProfileError(f"{field} must be a non-empty string")
    return result


def require_timestamp(value: Any, field: str) -> str:
    text = require_text(value, field)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise IntentProfileError(f"{field} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise IntentProfileError(f"{field} must include a timezone offset")
    return text


def text_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise IntentProfileError(f"{field} must be an array")
    out: dict[str, str] = {}
    for index, item in enumerate(value):
        out.setdefault(normalized(require_text(item, f"{field}[{index}]")),
                       require_text(item, f"{field}[{index}]"))
    return [out[key] for key in sorted(out)]


def named_items(value: Any, field: str, require_categories: bool) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise IntentProfileError(f"{field} must be an array")
    out = []
    seen = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise IntentProfileError(f"{field}[{index}] must be an object")
        unknown = set(item) - {"name", "aliases", "categories", "origin"}
        if unknown:
            raise IntentProfileError(f"{field}[{index}] has disallowed keys: {sorted(unknown)}")
        name = require_text(item.get("name"), f"{field}[{index}].name")
        key = normalized(name)
        if key in seen:
            raise IntentProfileError(f"{field} contains duplicate names")
        seen.add(key)
        origin = item.get("origin", "user_stated")
        if origin not in ("user_stated", "inferred"):
            raise IntentProfileError(f"{field}[{index}].origin must be user_stated or inferred")
        entry = {
            "name": name,
            "aliases": text_list(item.get("aliases", []), f"{field}[{index}].aliases"),
            "origin": origin,
        }
        if require_categories:
            entry["categories"] = text_list(item.get("categories", []),
                                            f"{field}[{index}].categories")
        out.append(entry)
    return sorted(out, key=lambda item: normalized(item["name"]))


def profile_hash(chat_id: str, profile: dict[str, Any]) -> str:
    canonical = json.dumps({"chat_id": chat_id, "profile": profile},
                           ensure_ascii=False, sort_keys=True)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_question(missing: list[str], inferred_pending: bool) -> str:
    parts = [f"{SLOT_LABELS[slot]}" for slot in missing]
    if parts:
        return ("为了给您精准推荐买家，请回复补充：" + "、".join(parts) +
                "。例如「主营绗缝被（床上用品），目标巴西」。")
    if inferred_pending:
        return ("以上画像信息来自群历史/公开资料推断，请确认是否准确；"
                "回复「没问题/继续」即按此方向推荐买家。")
    return ""


def assess(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise IntentProfileError("input must be an object")
    unknown = set(payload) - {"chat_id", "intent", "actor_open_id", "captured_at"}
    if unknown:
        raise IntentProfileError(f"unexpected input keys: {sorted(unknown)}")
    chat_id = require_text(payload.get("chat_id"), "chat_id")
    actor = require_text(payload.get("actor_open_id"), "actor_open_id")
    captured_at = require_timestamp(payload.get("captured_at"), "captured_at")
    intent = payload.get("intent")
    if not isinstance(intent, dict):
        raise IntentProfileError("intent must be an object")
    unknown = set(intent) - {"products", "target_countries", "buyer_types", "moq",
                             "desired_buyer_tags", "buyer_profile_keywords", "intent_keywords"}
    if unknown:
        raise IntentProfileError(f"intent has disallowed keys: {sorted(unknown)}")

    products = named_items(intent.get("products", []), "intent.products", True)
    countries = named_items(intent.get("target_countries", []), "intent.target_countries", False)

    missing = []
    if not products or any(not p["categories"] for p in products):
        missing.append("products")
    if not countries:
        missing.append("target_countries")

    core_inferred = any(p["origin"] == "inferred" for p in products + countries)

    score_profile = {
        "source_chat_id": chat_id,
        "products": [{"name": p["name"], "aliases": p["aliases"],
                      "categories": p["categories"]} for p in products],
        "buyer_types": [{"name": b["name"], "aliases": b["aliases"]}
                        for b in named_items(intent.get("buyer_types", []),
                                             "intent.buyer_types", False)],
        "target_countries": [{"name": c["name"], "aliases": c["aliases"]} for c in countries],
        "moq": intent.get("moq"),
        "desired_buyer_tags": text_list(intent.get("desired_buyer_tags", []),
                                        "intent.desired_buyer_tags"),
        "buyer_profile_keywords": text_list(intent.get("buyer_profile_keywords", []),
                                            "intent.buyer_profile_keywords"),
        "intent_keywords": text_list(intent.get("intent_keywords", []),
                                     "intent.intent_keywords"),
    }
    hashed = profile_hash(chat_id, score_profile)

    if missing:
        return {
            "readiness": "needs_input",
            "missing_slots": missing,
            "question": build_question(missing, False),
            "profile": None,
            "profile_hash": None,
        }

    result = {
        "profile_hash": hashed,
        "missing_slots": [],
        "profile": {
            **score_profile,
            "source_kind": "user_intent",
            "source_doc_token": "",
            "status": "active",
            "normalized_hash": hashed,
            "intent_confirmation": {
                "actor_open_id": actor,
                "signal": "user_stated" if not core_inferred else "pending",
                "confirmed_at": captured_at,
            },
            "updated_at": captured_at,
        },
    }
    if core_inferred:
        result["readiness"] = "needs_confirmation"
        result["question"] = build_question([], True)
        result["profile"]["status"] = "pending_confirmation"
    else:
        result["readiness"] = "ready"
        result["question"] = ""
    return result


def confirm(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise IntentProfileError("input must be an object")
    if set(payload) != {"text"}:
        raise IntentProfileError('input must contain only "text"')
    text = require_text(payload.get("text"), "text")
    for signal in REJECTION_SIGNALS:
        if signal in text:
            return {"confirmed": False, "matched_signal": signal, "kind": "rejection"}
    for signal in APPROVAL_SIGNALS:
        if signal in text:
            return {"confirmed": True, "matched_signal": signal, "kind": "approval"}
    return {"confirmed": False, "matched_signal": "", "kind": "none"}


def self_test() -> None:
    # 用户亲口说全了核心要素 → 直接 ready，无需确认
    ready = assess({
        "chat_id": "oc_a",
        "actor_open_id": "ou_user1",
        "captured_at": "2026-08-20T10:00:00+08:00",
        "intent": {
            "products": [{"name": "绗缝被", "categories": ["床上用品"],
                          "aliases": ["Quilt"], "origin": "user_stated"}],
            "target_countries": [{"name": "沙特", "aliases": ["Saudi Arabia"],
                                  "origin": "user_stated"}],
        }})
    assert ready["readiness"] == "ready"
    assert ready["profile"]["status"] == "active"
    assert ready["profile"]["source_kind"] == "user_intent"
    assert ready["profile"]["intent_confirmation"]["signal"] == "user_stated"

    # 缺目标国 → needs_input，反问一次且只问缺的槽位
    partial = assess({
        "chat_id": "oc_a", "actor_open_id": "ou_user1",
        "captured_at": "2026-08-20T10:00:00+08:00",
        "intent": {"products": [{"name": "绗缝被", "categories": ["床上用品"]}]}})
    assert partial["readiness"] == "needs_input"
    assert partial["missing_slots"] == ["target_countries"]
    assert "目标国家" in partial["question"] and "主营产品" not in partial["question"]
    assert partial["profile"] is None

    # 产品缺类目也算缺 products 槽位
    no_category = assess({
        "chat_id": "oc_a", "actor_open_id": "ou_user1",
        "captured_at": "2026-08-20T10:00:00+08:00",
        "intent": {"products": [{"name": "绗缝被"}],
                   "target_countries": [{"name": "沙特"}]}})
    assert no_category["readiness"] == "needs_input"
    assert no_category["missing_slots"] == ["products"]

    # 推断来源的核心字段 → needs_confirmation，等一个认可信号
    inferred = assess({
        "chat_id": "oc_a", "actor_open_id": "ou_user1",
        "captured_at": "2026-08-20T10:00:00+08:00",
        "intent": {
            "products": [{"name": "绗缝被", "categories": ["床上用品"],
                          "origin": "inferred"}],
            "target_countries": [{"name": "沙特", "origin": "inferred"}],
        }})
    assert inferred["readiness"] == "needs_confirmation"
    assert inferred["profile"]["status"] == "pending_confirmation"
    assert "确认" in inferred["question"]

    # 确认信号识别
    assert confirm({"text": "这批没问题，继续往下推"})["confirmed"] is True
    assert confirm({"text": "就按这个方向，再找5家"})["confirmed"] is True
    assert confirm({"text": "不对，我们不做这个国家"})["confirmed"] is False
    assert confirm({"text": "今天天气不错"})["kind"] == "none"
    # 否定优先于肯定
    mixed = confirm({"text": "别推了，这批没问题之前的不算"})
    assert mixed["confirmed"] is False and mixed["kind"] == "rejection"

    print("intent_profile_builder self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("assess", "confirm", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        payload = json.load(sys.stdin)
        result = assess(payload) if args.command == "assess" else confirm(payload)
    except (IntentProfileError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
