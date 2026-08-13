#!/usr/bin/env python3
"""Plan a safe Feishu creator-to-DealClaw permission handoff."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from typing import Any


class HandoffError(RuntimeError):
    """Raised when ownership and caller identity are ambiguous."""


RESOURCE_TYPES = {"docx", "bitable"}
ROLES = {"none", "view", "edit", "full_access", "owner"}


def text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise HandoffError(f"{field} must be a non-empty string")
    return result


def boolean(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise HandoffError(f"{field} must be boolean")
    return value


def principal(value: Any, field: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"member_type", "member_id", "credential_type"}:
        raise HandoffError(f"{field} must contain member_type, member_id, and credential_type")
    if value.get("member_type") != "openid":
        raise HandoffError(f"{field}.member_type must be openid")
    credential = text(value.get("credential_type"), f"{field}.credential_type")
    if credential not in {"user_access_token", "tenant_access_token"}:
        raise HandoffError(f"{field}.credential_type is unsupported")
    return {"member_type": "openid", "member_id": text(value.get("member_id"), f"{field}.member_id"), "credential_type": credential}


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def plan(payload: Any) -> dict[str, Any]:
    required = {
        "chat_id", "resource_token", "resource_type", "resource_origin", "resource_owner",
        "creation_actor", "creation_actor_role", "creation_actor_available",
        "creation_actor_can_see_chat", "dealclaw_principal", "dealclaw_current_role",
        "dealclaw_is_in_chat",
    }
    if not isinstance(payload, dict) or set(payload) != required:
        raise HandoffError("input has unsupported or missing fields")
    chat_id = text(payload.get("chat_id"), "chat_id")
    token = text(payload.get("resource_token"), "resource_token")
    resource_type = text(payload.get("resource_type"), "resource_type")
    if resource_type not in RESOURCE_TYPES:
        raise HandoffError("resource_type must be docx or bitable")
    origin = text(payload.get("resource_origin"), "resource_origin")
    if origin not in {"newly_created", "existing_bound"}:
        raise HandoffError("resource_origin is unsupported")
    owner = principal(payload.get("resource_owner"), "resource_owner")
    creator = principal(payload.get("creation_actor"), "creation_actor")
    dealclaw = principal(payload.get("dealclaw_principal"), "dealclaw_principal")
    creator_role = text(payload.get("creation_actor_role"), "creation_actor_role")
    dealclaw_role = text(payload.get("dealclaw_current_role"), "dealclaw_current_role")
    if creator_role not in ROLES or dealclaw_role not in ROLES:
        raise HandoffError("Resource roles are unsupported")
    creator_available = boolean(payload.get("creation_actor_available"), "creation_actor_available")
    creator_can_see_chat = boolean(payload.get("creation_actor_can_see_chat"), "creation_actor_can_see_chat")
    dealclaw_in_chat = boolean(payload.get("dealclaw_is_in_chat"), "dealclaw_is_in_chat")
    if creator_role == "owner" and creator["member_id"] != owner["member_id"]:
        raise HandoffError("creation_actor claims owner but differs from resource_owner")

    common = {
        "chat_id": chat_id,
        "resource_type": resource_type,
        "token_fingerprint": fingerprint(token),
        "public_link_policy": "closed",
        "group_collaborator": {"member_type": "openchat", "member_id": chat_id, "perm": "edit", "type": "chat"},
        "dealclaw_collaborator": {"member_type": "openid", "member_id": dealclaw["member_id"], "perm": "full_access", "type": "user"},
    }
    if dealclaw_role in {"owner", "full_access"}:
        if dealclaw["credential_type"] == "tenant_access_token" and not dealclaw_in_chat:
            return {
                **common,
                "status": "blocked",
                "mode": "add_dealclaw_bot_to_chat",
                "publish_allowed": False,
                "reason_code": "DEALCLAW_APP_NOT_VISIBLE_TO_CHAT",
            }
        return {
            **common,
            "status": "ready",
            "mode": "dealclaw_direct",
            "permission_actor": dealclaw,
            "publish_allowed": False,
            "required_actions": ["close_public_and_link_access", "upsert_chat_edit", "remove_unexpected_collaborators", "live_readback_v3"],
        }

    creator_can_manage = creator_role in {"owner", "full_access"}
    if creator_available and creator_can_manage:
        if creator["credential_type"] == "tenant_access_token" and not creator_can_see_chat:
            return {
                **common,
                "status": "blocked",
                "mode": "add_creator_app_to_chat",
                "publish_allowed": False,
                "reason_code": "CREATOR_APP_NOT_VISIBLE_TO_CHAT",
            }
        return {
            **common,
            "status": "ready",
            "mode": "creator_handoff",
            "permission_actor": creator,
            "publish_allowed": False,
            "required_actions": [
                "close_public_and_link_access",
                "upsert_chat_edit",
                "upsert_dealclaw_full_access",
                "remove_unexpected_collaborators",
                "live_readback_v3_with_dealclaw_handoff",
            ],
        }

    if origin == "newly_created":
        return {
            **common,
            "status": "blocked",
            "mode": "discard_private_and_recreate",
            "publish_allowed": False,
            "reason_code": "NEW_RESOURCE_CREATOR_CANNOT_HANDOFF",
        }
    return {
        **common,
        "status": "blocked",
        "mode": "manual_owner_repair_required",
        "publish_allowed": False,
        "reason_code": "EXISTING_RESOURCE_OWNER_ACTION_REQUIRED",
        "owner_fingerprint": fingerprint(owner["member_id"]),
    }


def fixture() -> dict[str, Any]:
    return {
        "chat_id": "oc_a", "resource_token": "base-a", "resource_type": "bitable",
        "resource_origin": "newly_created",
        "resource_owner": {"member_type": "openid", "member_id": "ou_ai_hunter", "credential_type": "tenant_access_token"},
        "creation_actor": {"member_type": "openid", "member_id": "ou_ai_hunter", "credential_type": "tenant_access_token"},
        "creation_actor_role": "owner", "creation_actor_available": True,
        "creation_actor_can_see_chat": True,
        "dealclaw_principal": {"member_type": "openid", "member_id": "ou_dealclaw", "credential_type": "tenant_access_token"},
        "dealclaw_current_role": "none", "dealclaw_is_in_chat": True,
    }


def self_test() -> None:
    result = plan(fixture())
    assert result["mode"] == "creator_handoff"
    assert "upsert_dealclaw_full_access" in result["required_actions"]
    unavailable = fixture()
    unavailable["creation_actor_available"] = False
    assert plan(unavailable)["mode"] == "discard_private_and_recreate"
    existing = fixture()
    existing["resource_origin"] = "existing_bound"
    existing["creation_actor_available"] = False
    assert plan(existing)["mode"] == "manual_owner_repair_required"
    invisible = fixture()
    invisible["creation_actor_can_see_chat"] = False
    assert plan(invisible)["mode"] == "add_creator_app_to_chat"
    print("permission_handoff_guard self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("plan", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = plan(json.load(sys.stdin))
    except (HandoffError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
