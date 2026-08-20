#!/usr/bin/env python3
"""Render guarded buyer leads as deterministic Feishu interactive cards."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from typing import Any
from urllib.parse import unquote, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import delivery_guard


def push_timezone():
    """Resolve the fixed push timezone with a Windows-safe fallback.

    Hosts without the tzdata package cannot resolve IANA names; Asia/Shanghai
    has used a fixed UTC+8 offset since 1991, so the fallback is exact.
    """
    try:
        return ZoneInfo("Asia/Shanghai")
    except ZoneInfoNotFoundError:
        from datetime import timedelta, timezone as _tz
        return _tz(timedelta(hours=8), "Asia/Shanghai")


class CardRenderError(RuntimeError):
    """Raised when a lead card cannot be rendered safely."""


MEDALS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"]
MAX_FIELD_LENGTHS = {
    "买家公司名称": 120,
    "需求意向": 500,
    "关注产品": 300,
    "买家特征": 300,
    "报名参展展会": 200,
    "买家国家": 100,
}
REASON_DIMENSION_ORDER = (
    "产品名称",
    "产品类别",
    "买家国家",
    "买家类型",
    "MOQ",
    "买家标签",
    "企业简介",
    "需求意向",
    "线索时间",
)
DIMENSION_WEIGHTS = {
    "产品名称": 32,
    "产品类别": 24,
    "买家国家": 18,
    "买家类型": 10,
    "MOQ": 6,
    "买家标签": 4,
    "企业简介": 2,
    "需求意向": 2,
    "线索时间": 2,
}


def require_text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise CardRenderError(f"{field} must be a non-empty string")
    return result


def optional_text(value: Any, field: str) -> str:
    if value is None or value == "":
        return ""
    if not isinstance(value, str):
        raise CardRenderError(f"{field} must be a string when present")
    return " ".join(value.split())


def display_text(value: Any, field: str) -> str:
    text = optional_text(value, field)
    maximum = MAX_FIELD_LENGTHS[field]
    if len(text) > maximum:
        text = text[: maximum - 1].rstrip() + "…"
    return text


def escape_lark_md(value: str) -> str:
    value = value.replace("<", "＜").replace(">", "＞")
    return re.sub(r"([\\`*_{}\[\]()#+\-.!|~])", r"\\\1", value)


def validate_url(value: Any, field: str, token: str) -> str:
    url = require_text(value, field)
    parsed = urlparse(url)
    host = (parsed.hostname or "").casefold()
    if parsed.scheme != "https" or not host:
        raise CardRenderError(f"{field} must be an HTTPS Feishu URL")
    if any(character in url for character in " \t\r\n<>()"):
        raise CardRenderError(f"{field} contains unsafe URL characters")
    if not (host == "feishu.cn" or host.endswith(".feishu.cn") or host == "larksuite.com" or host.endswith(".larksuite.com")):
        raise CardRenderError(f"{field} host is not an allowed Feishu/Lark domain")
    if parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
        raise CardRenderError(f"{field} contains unsupported authority, port, or fragment data")
    raw_segments = [segment for segment in parsed.path.split("/") if segment]
    segments = [unquote(segment) for segment in raw_segments]
    if len(segments) != 2 or segments[0] != "base" or segments[1] != token:
        raise CardRenderError(f"{field} path must be exactly /base/<bound base_app_token>")
    if raw_segments[1] != token:
        raise CardRenderError(f"{field} must not encode or transform the bound token")
    return url


def score(value: Any, field: str) -> int:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise CardRenderError(f"{field} must be numeric")
    if value < 0 or value > 100:
        raise CardRenderError(f"{field} must be from 0 to 100")
    return int(round(value))


def recommendation_reason(record: dict[str, Any]) -> str:
    details = record.get("评分明细")
    if not isinstance(details, list) or len(details) != 9:
        raise CardRenderError("评分明细 must contain the authoritative nine dimensions")
    by_dimension: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(details):
        if not isinstance(raw, dict):
            raise CardRenderError(f"评分明细[{index}] must be an object")
        dimension = require_text(raw.get("维度"), f"评分明细[{index}].维度")
        if dimension in by_dimension:
            raise CardRenderError("评分明细 contains duplicate dimensions")
        points = raw.get("得分")
        if not isinstance(points, (int, float)) or isinstance(points, bool) or points < 0:
            raise CardRenderError(f"评分明细[{index}].得分 must be non-negative")
        by_dimension[dimension] = raw
    if set(by_dimension) != set(REASON_DIMENSION_ORDER):
        raise CardRenderError("评分明细 dimensions do not match the approved nine-dimension policy")
    positive = []
    for dimension in REASON_DIMENSION_ORDER:
        detail = by_dimension[dimension]
        points = int(round(detail["得分"]))
        if points <= 0:
            continue
        canonical = optional_text(detail.get("画像依据"), f"评分明细.{dimension}.画像依据")
        lead = optional_text(detail.get("线索依据"), f"评分明细.{dimension}.线索依据")
        evidence = ""
        if canonical and lead:
            evidence = f"（画像：{canonical}；线索：{lead}）"
        positive.append(f"{dimension}匹配{evidence}，+{points}分")
    if not positive:
        raise CardRenderError("评分明细 has no positive recommendation evidence")
    penalty = record.get("反馈扣分", 0)
    if not isinstance(penalty, (int, float)) or isinstance(penalty, bool) or penalty < 0:
        raise CardRenderError("反馈扣分 must be non-negative")
    reason = "；".join(positive)
    if penalty:
        reason += f"；历史反馈规则扣{int(round(penalty))}分"
    return reason + "。"


def validate_score_consistency(record: dict[str, Any]) -> None:
    details = record.get("评分明细")
    if not isinstance(details, list) or len(details) != len(DIMENSION_WEIGHTS):
        raise CardRenderError("评分明细 must contain exactly nine dimensions")
    points_by_dimension: dict[str, int] = {}
    for index, detail in enumerate(details):
        if not isinstance(detail, dict):
            raise CardRenderError(f"评分明细[{index}] must be an object")
        dimension = require_text(detail.get("维度"), f"评分明细[{index}].维度")
        if dimension not in DIMENSION_WEIGHTS or dimension in points_by_dimension:
            raise CardRenderError("评分明细 contains an unknown or duplicate dimension")
        value = detail.get("得分")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise CardRenderError(f"评分明细[{index}].得分 must be numeric")
        rounded = int(round(value))
        if rounded != value or not 0 <= rounded <= DIMENSION_WEIGHTS[dimension]:
            raise CardRenderError(f"评分明细[{index}].得分 exceeds its approved weight")
        points_by_dimension[dimension] = rounded
    if set(points_by_dimension) != set(DIMENSION_WEIGHTS):
        raise CardRenderError("评分明细 dimensions do not match the approved policy")
    raw_score = sum(points_by_dimension.values())
    if record.get("AI原始分") != raw_score:
        raise CardRenderError("AI原始分 does not equal the nine-dimension score sum")
    penalty = record.get("反馈扣分", 0)
    if not isinstance(penalty, int) or isinstance(penalty, bool) or penalty < 0:
        raise CardRenderError("反馈扣分 must be a non-negative integer")
    final_score = max(0, min(100, raw_score - penalty))
    if record.get("AI匹配分") != final_score:
        raise CardRenderError("AI匹配分 is inconsistent with raw score and feedback penalty")
    core_pass = all(
        points_by_dimension[name] == DIMENSION_WEIGHTS[name]
        for name in ("产品名称", "产品类别", "买家国家")
    )
    if record.get("核心匹配通过") is not core_pass:
        raise CardRenderError("核心匹配通过 is inconsistent with the three core dimensions")
    expected_action = "push" if final_score >= 70 and core_pass else "pool_only" if final_score >= 65 else "exclude"
    if record.get("匹配动作") != expected_action:
        raise CardRenderError("匹配动作 is inconsistent with the approved score and core gate")


def lead_block(record: dict[str, Any], rank: int) -> dict[str, Any]:
    validate_score_consistency(record)
    company = display_text(record.get("买家公司名称"), "买家公司名称")
    if not company:
        raise CardRenderError("A pushed lead has no buyer company name")
    reason = recommendation_reason(record)
    lines = [
        f"{MEDALS[rank]} **买家公司：{escape_lark_md(company)}**    ⭐ **匹配分数：{score(record.get('AI匹配分'), 'AI匹配分')}/100**"
    ]
    labels = (
        ("需求意向", "需求意向"),
        ("关注产品", "关注产品"),
        ("买家特征", "买家特征"),
        ("报名参展", "报名参展展会"),
    )
    for label, key in labels:
        value = display_text(record.get(key), key)
        if value:
            lines.append(f"**{label}：** {escape_lark_md(value)}")
    lines.append(f"💡 **推荐理由：** {escape_lark_md(reason[:499] + ('…' if len(reason) > 500 else ''))}")
    return {"tag": "div", "text": {"tag": "lark_md", "content": "\n\n".join(lines)}}


def render(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise CardRenderError("input must be an object")
    if set(payload) != {"delivery", "selected_lead_ids", "base_url"}:
        raise CardRenderError("input must contain only delivery, selected_lead_ids, and base_url")
    delivery_payload = payload.get("delivery")
    proof = delivery_guard.validate(delivery_payload)
    binding = delivery_payload["current_state"]["binding"]
    base_url = validate_url(payload.get("base_url"), "base_url", binding["base_app_token"])
    selected = payload.get("selected_lead_ids")
    if not isinstance(selected, list) or not selected:
        raise CardRenderError("selected_lead_ids must be a non-empty array")
    if len(selected) > 5:
        raise CardRenderError("At most 5 leads may be rendered per batch")
    selected_ids = [require_text(value, "selected_lead_ids[]") for value in selected]
    if len(set(selected_ids)) != len(selected_ids):
        raise CardRenderError("selected_lead_ids contains duplicates")

    records = delivery_payload["pipeline_result"]["records"]
    by_id = {record.get("线索ID"): record for record in records}
    chosen = []
    for lead_id in selected_ids:
        record = by_id.get(lead_id)
        if not isinstance(record, dict):
            raise CardRenderError("A selected lead is absent from guarded pipeline output")
        if record.get("匹配动作") != "push":
            raise CardRenderError("Only records with 匹配动作=push may be rendered")
        country = display_text(record.get("买家国家"), "买家国家")
        if not country:
            raise CardRenderError("A pushed lead has no buyer country")
        chosen.append((country, record))

    try:
        delivery_at = datetime.fromisoformat(proof["delivery_at"].replace("Z", "+00:00"))
        batch_date = delivery_at.astimezone(push_timezone()).date().isoformat()
    except (ValueError, KeyError) as exc:
        raise CardRenderError("Guarded delivery time is invalid") from exc
    batch_material = "\n".join([proof["chat_id"], batch_date, *sorted(selected_ids)])
    batch_id = "sha256:" + hashlib.sha256(batch_material.encode("utf-8")).hexdigest()

    grouped: dict[str, list[dict[str, Any]]] = {}
    country_order = []
    for country, record in chosen:
        if country not in grouped:
            grouped[country] = []
            country_order.append(country)
        grouped[country].append(record)

    messages = []
    rank_by_id = {lead_id: index for index, lead_id in enumerate(selected_ids)}
    for country in country_order:
        country_records = grouped[country]
        elements = []
        for index, record in enumerate(country_records):
            if index:
                elements.append({"tag": "hr"})
            elements.append(lead_block(record, rank_by_id[record["线索ID"]]))
        elements.extend(
            [
                {"tag": "hr"},
                {
                    "tag": "div",
                    "text": {
                        "tag": "lark_md",
                        "content": (
                            "📊 **企业线索池：**\n"
                            f"[{base_url}]({base_url})\n\n"
                            "💬 请在企业线索池中标记每条线索的匹配结果"
                            "（待确认/✅匹配/❌不匹配），系统将根据你的反馈优化后续推送。\n\n"
                            "🔓 需要买家联系方式？在企业线索池把该线索的「是否解锁」改为「已解锁」，"
                            "或在本群回复「解锁线索 线索ID」，系统会把该买家的联系方式推送到本群。"
                        ),
                    },
                },
                {
                    "tag": "action",
                    "actions": [
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "📊 打开企业线索池"},
                            "type": "primary",
                            "url": base_url,
                        }
                    ],
                },
            ]
        )
        card = {
            "config": {"wide_screen_mode": True, "enable_forward": False},
            "header": {
                "template": "blue",
                "title": {
                    "tag": "plain_text",
                    "content": f"AI猎客｜来自{country}买家的采购机会",
                },
            },
            "elements": elements,
        }
        messages.append(
            {
                "receive_id_type": "chat_id",
                "receive_id": proof["chat_id"],
                "msg_type": "interactive",
                "card": card,
                "lead_ids": [record["线索ID"] for record in country_records],
                "batch_id": batch_id,
            }
        )
    return {
        "chat_id": proof["chat_id"],
        "delivery_id": proof["delivery_id"],
        "batch_id": batch_id,
        "batch_date": batch_date,
        "message_count": len(messages),
        "lead_count": len(chosen),
        "messages": messages,
    }


def fixture() -> dict[str, Any]:
    delivery = delivery_guard.fixture()
    record = delivery["pipeline_result"]["records"][0]
    record.update(
        {
            "买家公司名称": "巴西优质家居进口商",
            "AI匹配分": 91,
            "AI原始分": 91,
            "核心匹配通过": True,
            "需求意向": "寻找绗缝被供应商",
            "关注产品": "绗缝被",
            "买家特征": "连锁零售买家",
            "报名参展展会": "HomeLife Brazil 2026",
            "买家国家": "巴西",
            "反馈扣分": 0,
            "评分明细": [
                {"维度": "产品名称", "得分": 32, "画像依据": "绗缝被", "线索依据": "绗缝被", "说明": ""},
                {"维度": "产品类别", "得分": 24, "画像依据": "床上用品", "线索依据": "床上用品", "说明": ""},
                {"维度": "买家国家", "得分": 18, "画像依据": "巴西", "线索依据": "Brazil", "说明": ""},
                {"维度": "买家类型", "得分": 10, "画像依据": "进口商", "线索依据": "进口商", "说明": ""},
                {"维度": "MOQ", "得分": 0, "画像依据": "", "线索依据": "", "说明": ""},
                {"维度": "买家标签", "得分": 4, "画像依据": "连锁零售", "线索依据": "连锁零售", "说明": ""},
                {"维度": "企业简介", "得分": 0, "画像依据": "", "线索依据": "", "说明": ""},
                {"维度": "需求意向", "得分": 2, "画像依据": "寻找供应商", "线索依据": "寻找供应商", "说明": ""},
                {"维度": "线索时间", "得分": 1, "画像依据": "近7天", "线索依据": "近7天", "说明": ""},
            ],
        }
    )
    return {
        "delivery": delivery,
        "selected_lead_ids": ["lead-1"],
        "base_url": "https://example.feishu.cn/base/base-a",
    }


def self_test() -> None:
    result = render(fixture())
    assert result["message_count"] == 1 and result["lead_count"] == 1
    assert result["batch_id"].startswith("sha256:")
    message = result["messages"][0]
    assert message["msg_type"] == "interactive" and message["receive_id"] == "oc_a"
    encoded = json.dumps(message["card"], ensure_ascii=False)
    for expected in (
        "巴西优质家居进口商",
        "匹配分数：91/100",
        "需求意向",
        "关注产品",
        "买家特征",
        "HomeLife Brazil 2026",
        "推荐理由",
        "打开企业线索池",
        "待确认/✅匹配/❌不匹配",
        "是否解锁",
        "解锁线索",
        "https://example.feishu.cn/base/base-a",
    ):
        assert expected in encoded

    no_exhibition = fixture()
    no_exhibition["delivery"]["pipeline_result"]["records"][0]["报名参展展会"] = ""
    assert "报名参展" not in json.dumps(render(no_exhibition)["messages"][0]["card"], ensure_ascii=False)

    two_leads = fixture()
    second = json.loads(json.dumps(two_leads["delivery"]["pipeline_result"]["records"][0], ensure_ascii=False))
    second["线索ID"] = "lead-2"
    second["买家公司名称"] = "第二家巴西买家"
    two_leads["delivery"]["pipeline_result"]["records"].append(second)
    two_leads["selected_lead_ids"] = ["lead-1", "lead-2"]
    forward = render(two_leads)
    reverse = json.loads(json.dumps(two_leads, ensure_ascii=False))
    reverse["selected_lead_ids"] = ["lead-2", "lead-1"]
    assert render(reverse)["batch_id"] == forward["batch_id"]
    only_second = json.loads(json.dumps(two_leads, ensure_ascii=False))
    only_second["selected_lead_ids"] = ["lead-2"]
    assert render(only_second)["batch_id"] != result["batch_id"]

    unsafe = []
    wrong_url = fixture()
    wrong_url["base_url"] = "https://example.com/base/base-a"
    unsafe.append(wrong_url)
    pool_only = fixture()
    pool_only["delivery"]["pipeline_result"]["records"][0]["匹配动作"] = "pool_only"
    unsafe.append(pool_only)
    crossed = fixture()
    crossed["delivery"]["current_state"]["resource_permissions"]["base"]["permission_chat_id"] = "oc_b"
    unsafe.append(crossed)
    token_in_query = fixture()
    token_in_query["base_url"] = "https://example.feishu.cn/base/wrong?token=base-a"
    unsafe.append(token_in_query)
    inconsistent_score = fixture()
    inconsistent_score["delivery"]["pipeline_result"]["records"][0]["AI匹配分"] = 0
    unsafe.append(inconsistent_score)
    for item in unsafe:
        try:
            render(item)
        except (CardRenderError, delivery_guard.DeliveryGuardError):
            pass
        else:
            raise AssertionError("Unsafe card input was not rejected")
    print("lead_card_renderer self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("render", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = render(json.load(sys.stdin))
    except (CardRenderError, delivery_guard.DeliveryGuardError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
