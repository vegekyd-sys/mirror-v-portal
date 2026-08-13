#!/usr/bin/env python3
"""Validate a host-normalized Feishu resource permission snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timedelta
from typing import Any


class PermissionGuardError(RuntimeError):
    """Raised when a document or Base is not isolated to one bound chat."""


POLICY_VERSION = "chat-isolation-v3"
RESOURCE_TYPES = {"docx", "bitable"}
MAX_PROOF_AGE_SECONDS = 60
CREDENTIAL_TYPES = {"user_access_token", "tenant_access_token"}


def require_text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise PermissionGuardError(f"{field} must be a non-empty string")
    return result


def require_object(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PermissionGuardError(f"{field} must be an object")
    return value


def reject_extra(value: dict[str, Any], allowed: set[str], field: str) -> None:
    extra = sorted(set(value) - allowed)
    if extra:
        raise PermissionGuardError(f"{field} contains unsupported fields: {', '.join(extra)}")


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def instant(value: Any, field: str) -> datetime:
    raw = require_text(value, field)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PermissionGuardError(f"{field} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise PermissionGuardError(f"{field} must include a timezone offset")
    return parsed


def principal(value: Any, field: str) -> dict[str, str]:
    item = require_object(value, field)
    reject_extra(item, {"member_type", "member_id"}, field)
    if item.get("member_type") != "openid":
        raise PermissionGuardError(f"{field}.member_type must be openid")
    return {"member_type": "openid", "member_id": require_text(item.get("member_id"), f"{field}.member_id")}


def validate(payload: Any) -> dict[str, Any]:
    payload = require_object(payload, "input")
    reject_extra(
        payload,
        {
            "expected_chat_id",
            "resource_token",
            "resource_type",
            "observed_at",
            "validation_time",
            "verification_context_id",
            "observation_id",
            "resource_owner",
            "permission_actor",
            "automation_principal",
            "public_permission",
            "collaborators",
            "allowed_manager_member_ids",
        },
        "input",
    )
    chat_id = require_text(payload.get("expected_chat_id"), "expected_chat_id")
    token = require_text(payload.get("resource_token"), "resource_token")
    resource_type = require_text(payload.get("resource_type"), "resource_type")
    if resource_type not in RESOURCE_TYPES:
        raise PermissionGuardError("resource_type must be docx or bitable")
    observed_at = instant(payload.get("observed_at"), "observed_at")
    validation_time = instant(payload.get("validation_time"), "validation_time")
    age = (validation_time - observed_at).total_seconds()
    if age < 0:
        raise PermissionGuardError("observed_at cannot be later than validation_time")
    if age > MAX_PROOF_AGE_SECONDS:
        raise PermissionGuardError("Permission snapshot is stale; obtain a new live readback")
    context_id = require_text(payload.get("verification_context_id"), "verification_context_id")
    observation_id = require_text(payload.get("observation_id"), "observation_id")
    owner = principal(payload.get("resource_owner"), "resource_owner")
    automation = principal(payload.get("automation_principal"), "automation_principal")
    actor = require_object(payload.get("permission_actor"), "permission_actor")
    reject_extra(
        actor,
        {"member_type", "member_id", "credential_type", "resource_role", "can_manage_collaborators"},
        "permission_actor",
    )
    actor_principal = principal(
        {"member_type": actor.get("member_type"), "member_id": actor.get("member_id")},
        "permission_actor principal",
    )
    credential_type = require_text(actor.get("credential_type"), "permission_actor.credential_type")
    if credential_type not in CREDENTIAL_TYPES:
        raise PermissionGuardError("permission_actor.credential_type is unsupported")
    actor_role = require_text(actor.get("resource_role"), "permission_actor.resource_role")
    if actor_role not in {"owner", "full_access"}:
        raise PermissionGuardError("permission_actor.resource_role must be owner or full_access")
    if actor.get("can_manage_collaborators") is not True:
        raise PermissionGuardError("Permission actor lacks verified collaborator-management authority")
    if actor_role == "owner" and actor_principal["member_id"] != owner["member_id"]:
        raise PermissionGuardError("Permission actor claims owner role but differs from the resource owner")

    public = require_object(payload.get("public_permission"), "public_permission")
    reject_extra(
        public,
        {
            "external_access_entity",
            "link_share_entity",
            "manage_collaborator_entity",
            "security_entity",
        },
        "public_permission",
    )
    if public.get("external_access_entity") != "closed":
        raise PermissionGuardError("External access must be closed")
    if public.get("link_share_entity") != "closed":
        raise PermissionGuardError("Link sharing must be closed")
    if public.get("manage_collaborator_entity") != "collaborator_full_access":
        raise PermissionGuardError("Only full-access collaborators may manage collaborators")
    if public.get("security_entity") != "only_full_access":
        raise PermissionGuardError("Copy, download, and print must be limited to full-access collaborators")

    managers_raw = payload.get("allowed_manager_member_ids", [])
    if not isinstance(managers_raw, list):
        raise PermissionGuardError("allowed_manager_member_ids must be an array")
    manager_ids = {require_text(value, "allowed_manager_member_ids[]") for value in managers_raw}
    if chat_id in manager_ids:
        raise PermissionGuardError("The bound chat cannot be declared as a management exception")
    required_managers = {owner["member_id"], automation["member_id"], actor_principal["member_id"]}
    if not required_managers.issubset(manager_ids):
        raise PermissionGuardError("Owner, permission actor, and DealClaw automation principal must be trusted managers")

    collaborators = payload.get("collaborators")
    if not isinstance(collaborators, list):
        raise PermissionGuardError("collaborators must be an array")
    group_matches = 0
    full_access_ids = set()
    for index, raw in enumerate(collaborators):
        item = require_object(raw, f"collaborators[{index}]")
        reject_extra(item, {"member_type", "member_id", "perm", "type"}, f"collaborators[{index}]")
        member_type = require_text(item.get("member_type"), f"collaborators[{index}].member_type")
        member_id = require_text(item.get("member_id"), f"collaborators[{index}].member_id")
        perm = require_text(item.get("perm"), f"collaborators[{index}].perm")
        subject_type = require_text(item.get("type"), f"collaborators[{index}].type")
        if member_type == "openchat":
            if member_id != chat_id or perm != "edit" or subject_type != "chat":
                raise PermissionGuardError("An unexpected group collaborator is present")
            group_matches += 1
            continue
        if member_id not in manager_ids or perm != "full_access":
            raise PermissionGuardError("An unexpected non-group collaborator is present")
        full_access_ids.add(member_id)
    if group_matches != 1:
        raise PermissionGuardError("Exactly one edit collaborator for the bound chat is required")
    if actor_role == "full_access" and actor_principal["member_id"] not in full_access_ids:
        raise PermissionGuardError("Permission actor is not a full-access collaborator")
    if automation["member_id"] != owner["member_id"] and automation["member_id"] not in full_access_ids:
        raise PermissionGuardError("DealClaw automation principal lacks full_access after creator handoff")

    return {
        "status": "verified",
        "policy_version": POLICY_VERSION,
        "permission_chat_id": chat_id,
        "resource_type": resource_type,
        "token_fingerprint": fingerprint(token),
        "external_access_entity": "closed",
        "link_share_entity": "closed",
        "group_permission": "edit",
        "observed_at": observed_at.isoformat(),
        "verified_at": validation_time.isoformat(),
        "expires_at": (observed_at + timedelta(seconds=MAX_PROOF_AGE_SECONDS)).isoformat(),
        "verification_context_id": context_id,
        "observation_id": observation_id,
        "owner_fingerprint": fingerprint(owner["member_id"]),
        "permission_actor_fingerprint": fingerprint(actor_principal["member_id"]),
        "permission_actor_role": actor_role,
        "permission_credential_type": credential_type,
        "automation_principal_fingerprint": fingerprint(automation["member_id"]),
        "automation_role": "owner" if automation["member_id"] == owner["member_id"] else "full_access",
    }


def fixture() -> dict[str, Any]:
    return {
        "expected_chat_id": "oc_a",
        "resource_token": "docx_a",
        "resource_type": "docx",
        "observed_at": "2026-08-12T10:00:00+08:00",
        "validation_time": "2026-08-12T10:00:20+08:00",
        "verification_context_id": "binding:oc_a:1",
        "observation_id": "perm-read-docx-1",
        "resource_owner": {"member_type": "openid", "member_id": "ou_owner"},
        "permission_actor": {
            "member_type": "openid",
            "member_id": "ou_owner",
            "credential_type": "user_access_token",
            "resource_role": "owner",
            "can_manage_collaborators": True,
        },
        "automation_principal": {"member_type": "openid", "member_id": "ou_dealclaw_app"},
        "public_permission": {
            "external_access_entity": "closed",
            "link_share_entity": "closed",
            "manage_collaborator_entity": "collaborator_full_access",
            "security_entity": "only_full_access",
        },
        "collaborators": [
            {"member_type": "openchat", "member_id": "oc_a", "perm": "edit", "type": "chat"},
            {"member_type": "openid", "member_id": "ou_owner", "perm": "full_access", "type": "user"},
            {"member_type": "openid", "member_id": "ou_dealclaw_app", "perm": "full_access", "type": "user"},
        ],
        "allowed_manager_member_ids": ["ou_owner", "ou_dealclaw_app"],
    }


def self_test() -> None:
    proof = validate(fixture())
    assert proof["permission_chat_id"] == "oc_a"
    assert proof["group_permission"] == "edit"
    assert proof["policy_version"] == "chat-isolation-v3"
    assert proof["automation_role"] == "full_access"
    assert "resource_token" not in proof
    invalid = []
    for mutate in ("public", "wrong_group", "outsider", "duplicate_group", "stale", "no_handoff", "wrong_actor"):
        item = json.loads(json.dumps(fixture()))
        if mutate == "public":
            item["public_permission"]["link_share_entity"] = "anyone_editable"
        elif mutate == "wrong_group":
            item["collaborators"][0]["member_id"] = "oc_b"
        elif mutate == "outsider":
            item["collaborators"].append(
                {"member_type": "openid", "member_id": "ou_other", "perm": "view", "type": "user"}
            )
        elif mutate == "duplicate_group":
            item["collaborators"].append(dict(item["collaborators"][0]))
        elif mutate == "stale":
            item["observed_at"] = "2026-08-12T09:58:00+08:00"
        elif mutate == "no_handoff":
            item["collaborators"] = [
                value for value in item["collaborators"] if value["member_id"] != "ou_dealclaw_app"
            ]
        else:
            item["permission_actor"]["member_id"] = "ou_dealclaw_app"
            item["permission_actor"]["resource_role"] = "owner"
        invalid.append(item)
    for item in invalid:
        try:
            validate(item)
        except PermissionGuardError:
            pass
        else:
            raise AssertionError("Unsafe permission snapshot was not rejected")
    print("resource_permission_guard self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = validate(json.load(sys.stdin))
    except (PermissionGuardError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
