#!/usr/bin/env python3
"""Validate same-group enterprise review commands against one exact draft state."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from typing import Any


class ConfirmationError(RuntimeError):
    """Raised when a draft review event is unauthorized, stale, or ambiguous."""


def text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise ConfirmationError(f"{field} must be a non-empty string")
    return result


def integer(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ConfirmationError(f"{field} must be a positive integer")
    return value


def exact_keys(value: Any, allowed: set[str], field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfirmationError(f"{field} must be an object")
    extra = sorted(set(value) - allowed)
    if extra:
        raise ConfirmationError(f"{field} contains disallowed fields: {', '.join(extra)}")
    return value


def validate(payload: Any) -> dict[str, Any]:
    payload = exact_keys(payload, {"chat_id", "state_revision", "onboarding", "event"}, "input")
    chat_id = text(payload.get("chat_id"), "chat_id")
    state_revision = integer(payload.get("state_revision"), "state_revision")
    onboarding = exact_keys(
        payload.get("onboarding"),
        {
            "status",
            "draft_doc_token",
            "draft_version",
            "draft_hash",
            "current_doc_hash",
            "confirmation_ready",
            "enterprise_approver_open_ids",
        },
        "onboarding",
    )
    status = text(onboarding.get("status"), "onboarding.status")
    if status not in {"draft_incomplete", "ready_for_confirmation"}:
        raise ConfirmationError("Draft is not open for review")
    draft_token = text(onboarding.get("draft_doc_token"), "onboarding.draft_doc_token")
    draft_version = integer(onboarding.get("draft_version"), "onboarding.draft_version")
    draft_hash = text(onboarding.get("draft_hash"), "onboarding.draft_hash")
    current_doc_hash = text(onboarding.get("current_doc_hash"), "onboarding.current_doc_hash")
    if current_doc_hash != draft_hash:
        raise ConfirmationError("Draft document contains unverified edits")
    confirmation_ready = onboarding.get("confirmation_ready")
    if not isinstance(confirmation_ready, bool):
        raise ConfirmationError("onboarding.confirmation_ready must be boolean")
    approvers = onboarding.get("enterprise_approver_open_ids")
    if not isinstance(approvers, list):
        raise ConfirmationError("onboarding.enterprise_approver_open_ids must be an array")
    approver_ids = {text(item, "enterprise_approver_open_ids[]") for item in approvers}

    event = exact_keys(
        payload.get("event"),
        {
            "chat_id",
            "actor_open_id",
            "actor_is_current_group_admin",
            "event_type",
            "channel",
            "signature_verified",
            "message_or_action_id",
            "draft_doc_token",
            "draft_version",
            "draft_hash",
            "command_text",
        },
        "event",
    )
    if text(event.get("chat_id"), "event.chat_id") != chat_id:
        raise ConfirmationError("Review event crosses the current chat_id boundary")
    actor = text(event.get("actor_open_id"), "event.actor_open_id")
    is_admin = event.get("actor_is_current_group_admin")
    if not isinstance(is_admin, bool):
        raise ConfirmationError("event.actor_is_current_group_admin must be boolean")
    if actor not in approver_ids and not is_admin:
        raise ConfirmationError("Actor is not an authorized enterprise approver")
    if text(event.get("draft_doc_token"), "event.draft_doc_token") != draft_token:
        raise ConfirmationError("Review event targets another draft token")
    if integer(event.get("draft_version"), "event.draft_version") != draft_version:
        raise ConfirmationError("Review event targets a stale draft version")
    if text(event.get("draft_hash"), "event.draft_hash") != draft_hash:
        raise ConfirmationError("Review event targets a stale draft hash")
    event_id = text(event.get("message_or_action_id"), "event.message_or_action_id")
    event_type = text(event.get("event_type"), "event.event_type")
    if event_type not in {"confirm", "modify"}:
        raise ConfirmationError("event.event_type must be confirm or modify")
    channel = text(event.get("channel"), "event.channel")
    if channel not in {"group_command", "signed_callback"}:
        raise ConfirmationError("event.channel is unsupported")
    signature_verified = event.get("signature_verified")
    if not isinstance(signature_verified, bool):
        raise ConfirmationError("event.signature_verified must be boolean")
    if channel == "signed_callback" and not signature_verified:
        raise ConfirmationError("Interactive callback signature is not verified")

    command = text(event.get("command_text"), "event.command_text")
    if event_type == "confirm":
        if status != "ready_for_confirmation" or not confirmation_ready:
            raise ConfirmationError("Draft core fields are not ready for confirmation")
        if channel == "group_command" and command != f"确认企业画像 v{draft_version}":
            raise ConfirmationError("Confirmation command must exactly name the current draft version")
        material = f"{chat_id}\n{draft_token}\n{draft_version}\n{draft_hash}"
        return {
            "chat_id": chat_id,
            "state_revision": state_revision,
            "decision": "formalize",
            "actor_open_id": actor,
            "message_or_action_id": event_id,
            "draft_version": draft_version,
            "draft_hash": draft_hash,
            "formalization_id": "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest(),
        }

    if channel == "group_command":
        match = re.fullmatch(rf"修改企业画像\s+v{draft_version}\s*[：:]\s*(.+)", command, flags=re.DOTALL)
        if not match or not match.group(1).strip():
            raise ConfirmationError("Modification command must name the current version and explicit changes")
        detail = match.group(1).strip()
    else:
        prefix = f"修改企业画像 v{draft_version}："
        if not command.startswith(prefix) or not command[len(prefix):].strip():
            raise ConfirmationError("Signed modification action lacks explicit changes")
        detail = command[len(prefix):].strip()
    return {
        "chat_id": chat_id,
        "state_revision": state_revision,
        "decision": "revise",
        "actor_open_id": actor,
        "message_or_action_id": event_id,
        "draft_version": draft_version,
        "draft_hash": draft_hash,
        "change_request": detail,
    }


def sample(command: str = "确认企业画像 v2", event_type: str = "confirm") -> dict[str, Any]:
    return {
        "chat_id": "oc_a",
        "state_revision": 4,
        "onboarding": {
            "status": "ready_for_confirmation",
            "draft_doc_token": "docx_draft",
            "draft_version": 2,
            "draft_hash": "sha256:abc",
            "current_doc_hash": "sha256:abc",
            "confirmation_ready": True,
            "enterprise_approver_open_ids": ["ou_approver"],
        },
        "event": {
            "chat_id": "oc_a",
            "actor_open_id": "ou_approver",
            "actor_is_current_group_admin": False,
            "event_type": event_type,
            "channel": "group_command",
            "signature_verified": False,
            "message_or_action_id": "om_1",
            "draft_doc_token": "docx_draft",
            "draft_version": 2,
            "draft_hash": "sha256:abc",
            "command_text": command,
        },
    }


def self_test() -> None:
    confirmed = validate(sample())
    assert confirmed["decision"] == "formalize"
    assert confirmed["formalization_id"].startswith("sha256:")

    revised = validate(sample("修改企业画像 v2：目标市场改为墨西哥", "modify"))
    assert revised["decision"] == "revise"
    assert revised["change_request"] == "目标市场改为墨西哥"

    cases = []
    bare = sample("确认")
    cases.append(bare)
    stale = sample()
    stale["event"]["draft_version"] = 1
    cases.append(stale)
    crossed = sample()
    crossed["event"]["chat_id"] = "oc_b"
    cases.append(crossed)
    unauthorized = sample()
    unauthorized["event"]["actor_open_id"] = "ou_member"
    cases.append(unauthorized)
    edited = sample()
    edited["onboarding"]["current_doc_hash"] = "sha256:changed"
    cases.append(edited)
    incomplete = sample()
    incomplete["onboarding"]["status"] = "draft_incomplete"
    incomplete["onboarding"]["confirmation_ready"] = False
    cases.append(incomplete)
    for payload in cases:
        try:
            validate(payload)
        except ConfirmationError:
            pass
        else:
            raise AssertionError("Invalid review event was not rejected")
    print("profile_confirmation_validator self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = validate(json.load(sys.stdin))
    except (ConfirmationError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
