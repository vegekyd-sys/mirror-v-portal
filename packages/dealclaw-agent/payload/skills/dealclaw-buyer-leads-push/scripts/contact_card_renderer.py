#!/usr/bin/env python3
"""Render an unlocked buyer's contact data as one Feishu interactive card.

Input must pair the ``contact_unlock_guard.py authorize`` output with the
``tradechina_buyer_leads.py buyer-detail`` output produced for the same lead
under the same ``unlock_id``. The rendered card is the only approved carrier
of buyer contact data: it goes only to the originating group, is never
written to the Base, durable state, or logs, and must not be rebuilt or
rewritten by a model.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any


class ContactCardError(RuntimeError):
    """Raised when a contact card cannot be rendered safely."""


UNLOCK_ID_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
MAX_FIELD_LENGTHS = {
    "买家公司名称": 120,
    "联系人姓名": 80,
    "职位": 80,
    "邮箱": 200,
    "电话": 60,
    "WhatsApp": 60,
    "公司官网": 200,
}


def require_text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise ContactCardError(f"{field} must be a non-empty string")
    return result


def optional_text(value: Any, field: str) -> str:
    if value is None or value == "":
        return ""
    if not isinstance(value, str):
        raise ContactCardError(f"{field} must be a string when present")
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


def valid_badge(flag: Any) -> str:
    if flag == 1:
        return "（已验证）"
    if flag == 0:
        return "（未验证）"
    return ""


def validate_unlock(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContactCardError("unlock must be the contact_unlock_guard authorize output")
    if value.get("unlock_authorized") is not True:
        raise ContactCardError("unlock was not authorized")
    unlock_id = require_text(value.get("unlock_id"), "unlock.unlock_id")
    if not UNLOCK_ID_PATTERN.fullmatch(unlock_id):
        raise ContactCardError("unlock.unlock_id has an invalid format")
    require_text(value.get("chat_id"), "unlock.chat_id")
    require_text(value.get("lead_id"), "unlock.lead_id")
    require_text(value.get("actor_open_id"), "unlock.actor_open_id")
    if value.get("trigger") not in ("base_field", "group_command"):
        raise ContactCardError("unlock.trigger is invalid")
    return value


def validate_contact(value: Any, unlock: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContactCardError("contact must be the buyer-detail output")
    if value.get("contactFieldsReleased") is not True:
        raise ContactCardError("buyer-detail output did not release contact fields")
    if value.get("unlock_id") != unlock["unlock_id"]:
        raise ContactCardError("buyer-detail unlock_id does not match the guard authorization")
    if value.get("线索ID") != unlock["lead_id"]:
        raise ContactCardError("buyer-detail 线索ID does not match the authorized lead")
    return value


def render(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ContactCardError("input must be an object")
    if set(payload) != {"unlock", "contact"}:
        raise ContactCardError("input must contain only unlock and contact")
    unlock = validate_unlock(payload.get("unlock"))
    contact = validate_contact(payload.get("contact"), unlock)

    company = display_text(contact.get("买家公司名称"), "买家公司名称")
    if not company:
        raise ContactCardError("an unlocked lead has no buyer company name")

    field_lines = []
    released = 0
    rows = (
        ("👤 联系人", "联系人姓名", None),
        ("💼 职位", "职位", None),
        ("📧 邮箱", "邮箱", "邮箱有效"),
        ("📱 电话", "电话", "电话有效"),
        ("💬 WhatsApp", "WhatsApp", "WhatsApp有效"),
        ("🌐 公司官网", "公司官网", None),
    )
    for label, key, flag_key in rows:
        value = display_text(contact.get(key), key)
        if not value:
            continue
        released += 1
        badge = valid_badge(contact.get(flag_key)) if flag_key else ""
        field_lines.append(f"**{label}：** {escape_lark_md(value)}{badge}")
    if released == 0:
        raise ContactCardError(
            "the detail response contains no contact values; send the no-contact "
            "notice instead of a card")

    lead_id = escape_lark_md(require_text(contact.get("线索ID"), "线索ID"))
    elements = [
        {
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": (
                    f"🔓 **买家公司：{escape_lark_md(company)}**\n"
                    f"线索ID：{lead_id}"
                ),
            },
        },
        {"tag": "hr"},
        {
            "tag": "div",
            "text": {"tag": "lark_md", "content": "\n\n".join(field_lines)},
        },
        {"tag": "hr"},
        {
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": (
                    "联系方式来自 TradeChina 买家详情，仅发送至本群，"
                    "不会写入AI猎客商机池。请合规使用，勿二次分发。"
                ),
            },
        },
    ]
    card = {
        "config": {"wide_screen_mode": True, "enable_forward": False},
        "header": {
            "template": "green",
            "title": {"tag": "plain_text", "content": "AI猎客｜买家联系方式已解锁"},
        },
        "elements": elements,
    }
    return {
        "receive_id_type": "chat_id",
        "receive_id": unlock["chat_id"],
        "msg_type": "interactive",
        "card": card,
        "lead_id": contact["线索ID"],
        "unlock_id": unlock["unlock_id"],
        "idempotency_key": unlock["idempotency_key"],
    }


def fixture() -> dict[str, Any]:
    return {
        "unlock": {
            "unlock_authorized": True,
            "unlock_id": "sha256:" + "b" * 64,
            "idempotency_key": "sha256:" + "b" * 64,
            "chat_id": "oc_a",
            "lead_id": "2077311290711822337",
            "actor_open_id": "ou_member",
            "trigger": "base_field",
            "requested_at": "2026-08-12T22:00:00+08:00",
        },
        "contact": {
            "线索ID": "2077311290711822337",
            "买家公司名称": "Example Buyer Co",
            "联系人姓名": "Ana Example",
            "职位": "Purchasing Manager",
            "邮箱": "ana@example.com",
            "电话": "+5511900000000",
            "WhatsApp": "+5511900000000",
            "公司官网": "www.example.com",
            "邮箱有效": 1,
            "电话有效": 0,
            "WhatsApp有效": None,
            "unlockStatus": 1,
            "解锁状态": "unlocked",
            "unlock_id": "sha256:" + "b" * 64,
            "contactFieldsReleased": True,
        },
    }


def self_test() -> None:
    result = render(fixture())
    assert result["msg_type"] == "interactive"
    assert result["receive_id"] == "oc_a"
    assert result["idempotency_key"] == "sha256:" + "b" * 64
    encoded = json.dumps(result["card"], ensure_ascii=False)
    text_content = "".join(
        element["text"]["content"]
        for element in result["card"]["elements"]
        if element.get("tag") == "div"
    )
    for expected in (
        "Example Buyer Co",
        "Ana Example",
        escape_lark_md("ana@example.com"),
        "（已验证）",
        "（未验证）",
        "不会写入AI猎客商机池",
    ):
        assert expected in text_content, f"missing {expected}"
    for expected in ("买家联系方式已解锁", "enable_forward"):
        assert expected in encoded, f"missing {expected}"
    assert result["card"]["config"]["enable_forward"] is False

    bad = []
    not_authorized = fixture()
    not_authorized["unlock"]["unlock_authorized"] = False
    bad.append(not_authorized)
    mismatched_unlock = fixture()
    mismatched_unlock["contact"]["unlock_id"] = "sha256:" + "c" * 64
    bad.append(mismatched_unlock)
    mismatched_lead = fixture()
    mismatched_lead["contact"]["线索ID"] = "other"
    bad.append(mismatched_lead)
    not_released = fixture()
    not_released["contact"]["contactFieldsReleased"] = False
    bad.append(not_released)
    empty_contacts = fixture()
    for key in ("联系人姓名", "职位", "邮箱", "电话", "WhatsApp", "公司官网"):
        empty_contacts["contact"][key] = ""
    bad.append(empty_contacts)
    bad_id = fixture()
    bad_id["unlock"]["unlock_id"] = "plain"
    bad.append(bad_id)
    for item in bad:
        try:
            render(item)
        except ContactCardError:
            pass
        else:
            raise AssertionError("unsafe contact card input was not rejected")
    print("contact_card_renderer self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("render", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = render(json.load(sys.stdin))
    except (ContactCardError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
