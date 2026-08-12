#!/usr/bin/env python3
"""Validate a host-normalized Feishu resource permission snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from typing import Any


class PermissionGuardError(RuntimeError):
    """Raised when a document or Base is not isolated to one bound chat."""


POLICY_VERSION = "chat-isolation-v1"
RESOURCE_TYPES = {"docx", "bitable"}


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


def validate(payload: Any) -> dict[str, Any]:
    payload = require_object(payload, "input")
    reject_extra(
        payload,
        {
            "expected_chat_id",
            "resource_token",
            "resource_type",
            "verified_at",
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
    verified_at = require_text(payload.get("verified_at"), "verified_at")

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

    collaborators = payload.get("collaborators")
    if not isinstance(collaborators, list):
        raise PermissionGuardError("collaborators must be an array")
    group_matches = 0
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
    if group_matches != 1:
        raise PermissionGuardError("Exactly one edit collaborator for the bound chat is required")

    return {
        "status": "verified",
        "policy_version": POLICY_VERSION,
        "permission_chat_id": chat_id,
        "resource_type": resource_type,
        "token_fingerprint": fingerprint(token),
        "external_access_entity": "closed",
        "link_share_entity": "closed",
        "group_permission": "edit",
        "verified_at": verified_at,
    }


def fixture() -> dict[str, Any]:
    return {
        "expected_chat_id": "oc_a",
        "resource_token": "docx_a",
        "resource_type": "docx",
        "verified_at": "2026-08-12T10:00:00+08:00",
        "public_permission": {
            "external_access_entity": "closed",
            "link_share_entity": "closed",
            "manage_collaborator_entity": "collaborator_full_access",
            "security_entity": "only_full_access",
        },
        "collaborators": [
            {"member_type": "openchat", "member_id": "oc_a", "perm": "edit", "type": "chat"},
            {"member_type": "openid", "member_id": "ou_owner", "perm": "full_access", "type": "user"},
        ],
        "allowed_manager_member_ids": ["ou_owner"],
    }


def self_test() -> None:
    proof = validate(fixture())
    assert proof["permission_chat_id"] == "oc_a"
    assert proof["group_permission"] == "edit"
    assert "resource_token" not in proof
    invalid = []
    for mutate in ("public", "wrong_group", "outsider", "duplicate_group"):
        item = json.loads(json.dumps(fixture()))
        if mutate == "public":
            item["public_permission"]["link_share_entity"] = "anyone_editable"
        elif mutate == "wrong_group":
            item["collaborators"][0]["member_id"] = "oc_b"
        elif mutate == "outsider":
            item["collaborators"].append(
                {"member_type": "openid", "member_id": "ou_other", "perm": "view", "type": "user"}
            )
        else:
            item["collaborators"].append(dict(item["collaborators"][0]))
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
