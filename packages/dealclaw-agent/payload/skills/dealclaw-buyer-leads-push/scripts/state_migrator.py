#!/usr/bin/env python3
"""Create a validated v10 chat state from a deliberately deactivated legacy state."""

from __future__ import annotations

import argparse
import copy
from datetime import datetime
import json
import sys
from typing import Any

import delivery_guard


class MigrationError(RuntimeError):
    """Raised when a legacy state cannot be migrated without ambiguity."""


TARGET_SCHEMA_VERSION = 10
SUPPORTED_SOURCE_VERSIONS = {7, 8, 9}


def text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise MigrationError(f"{field} must be a non-empty string")
    return result


def integer(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise MigrationError(f"{field} must be an integer")
    return value


def obj(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise MigrationError(f"{field} must be an object")
    return value


def instant(value: Any, field: str) -> datetime:
    raw = text(value, field)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MigrationError(f"{field} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise MigrationError(f"{field} must include a timezone offset")
    return parsed


def migrate(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {
        "chat_id",
        "source_state",
        "target_state_exists",
        "formal_document",
        "live_permission_proofs",
        "migration_at",
        "migration_actor",
    }:
        raise MigrationError(
            "input must contain only chat_id, source_state, target_state_exists, formal_document, "
            "live_permission_proofs, migration_at, and migration_actor"
        )
    chat_id = text(payload.get("chat_id"), "chat_id")
    if payload.get("target_state_exists") is not False:
        raise MigrationError("The v10 target key must not already exist")
    source = obj(payload.get("source_state"), "source_state")
    source_version = integer(source.get("schema_version"), "source_state.schema_version")
    if source_version not in SUPPORTED_SOURCE_VERSIONS:
        raise MigrationError("Only v7-v9 state can be migrated by this program")
    source_revision = integer(source.get("revision"), "source_state.revision")
    if source.get("status") != "inactive_for_v10_migration":
        raise MigrationError("Legacy state must first be atomically marked inactive_for_v10_migration")
    if source.get("chat_id") != chat_id:
        raise MigrationError("Legacy state crosses the requested chat_id")
    binding = obj(source.get("binding"), "source_state.binding")
    profile = obj(source.get("profile"), "source_state.profile")
    if binding.get("chat_id") != chat_id or profile.get("source_chat_id") != chat_id:
        raise MigrationError("Legacy binding/profile crosses the requested chat_id")
    company = text(binding.get("company_name"), "binding.company_name")
    doc_token = text(binding.get("knowledge_doc_token"), "binding.knowledge_doc_token")
    base_token = text(binding.get("base_app_token"), "binding.base_app_token")
    text(binding.get("base_table_id"), "binding.base_table_id")
    formal = obj(payload.get("formal_document"), "formal_document")
    if set(formal) != {"token", "title", "profile_hash"}:
        raise MigrationError("formal_document must contain only token, title, and profile_hash")
    if formal.get("token") != doc_token or formal.get("title") != f"{company}｜企业知识库":
        raise MigrationError("Direct formal-document projection differs from the legacy binding")
    if formal.get("profile_hash") != profile.get("normalized_hash"):
        raise MigrationError("Direct formal-document profile hash differs from legacy state")

    migration_at = instant(payload.get("migration_at"), "migration_at")
    migration_actor = text(payload.get("migration_actor"), "migration_actor")
    context_id = f"migration:{chat_id}:{source_revision}"
    proofs = obj(payload.get("live_permission_proofs"), "live_permission_proofs")
    if set(proofs) != {"formal_document", "base"}:
        raise MigrationError("live_permission_proofs must contain only formal_document and base")
    try:
        doc_observation = delivery_guard.permission_proof(
            proofs["formal_document"], "formal_document", chat_id, "docx", doc_token,
            run_context_id=context_id, delivery_at=migration_at,
        )
        base_observation = delivery_guard.permission_proof(
            proofs["base"], "base", chat_id, "bitable", base_token,
            run_context_id=context_id, delivery_at=migration_at,
        )
    except delivery_guard.DeliveryGuardError as exc:
        raise MigrationError(str(exc)) from exc
    if doc_observation == base_observation:
        raise MigrationError("Docx and Base migration proofs must be distinct live readbacks")

    target = copy.deepcopy(source)
    old_feedback = target.get("feedback") if isinstance(target.get("feedback"), dict) else {}
    dropped_rules = len(old_feedback.get("learned_rules", [])) if isinstance(old_feedback.get("learned_rules"), list) else 0
    target["schema_version"] = TARGET_SCHEMA_VERSION
    target["revision"] = source_revision + 1
    target["status"] = "active"
    target["resource_permissions"] = {
        "policy_version": delivery_guard.PERMISSION_POLICY_VERSION,
        "permission_chat_id": chat_id,
        "formal_document": copy.deepcopy(proofs["formal_document"]),
        "base": copy.deepcopy(proofs["base"]),
    }
    target["feedback"] = {
        "feedback_cursor": "",
        "learned_rules": [],
        "rule_evidence": [],
        "weight_version": "v10-32-24-18-10-6-4-2-2-2",
    }
    target["migration"] = {
        "source_schema_version": source_version,
        "source_revision": source_revision,
        "migrated_at": migration_at.isoformat(),
        "migrated_by": migration_actor,
        "target_key": f"dealclaw-buyer-leads-push/v10/{chat_id}",
        "feedback_replay_required": True,
        "dropped_legacy_rule_count": dropped_rules,
    }
    return {
        "chat_id": chat_id,
        "source_key": f"dealclaw-buyer-leads-push/v{source_version}/{chat_id}",
        "target_key": f"dealclaw-buyer-leads-push/v10/{chat_id}",
        "expected_source_revision": source_revision,
        "target_state": target,
        "post_commit_action": "mark source state retired only after target compare-and-set succeeds",
    }


def fixture() -> dict[str, Any]:
    source = {
        "schema_version": 7,
        "revision": 8,
        "status": "inactive_for_v10_migration",
        "chat_id": "oc_a",
        "binding": {
            "chat_id": "oc_a", "company_name": "真实企业", "knowledge_doc_token": "docx_formal_a",
            "base_app_token": "base_a", "base_table_id": "table_a", "tradechina_supplier_id": "supplier-for-oc-a",
            "document_origin": "group_supplied_formal", "bound_at": "2026-08-12T09:00:00+08:00", "bound_by": "ou_admin",
        },
        "profile": {
            "source_chat_id": "oc_a", "source_doc_token": "docx_formal_a", "source_kind": "group_document",
            "status": "active", "normalized_hash": "sha256:profile-a",
            "products": [{"name": "绗缝被", "aliases": ["Quilt"], "categories": ["床上用品"]}],
            "buyer_types": [], "target_countries": [{"name": "巴西", "aliases": ["Brazil"]}],
            "moq": None, "desired_buyer_tags": [], "buyer_profile_keywords": [], "intent_keywords": [],
            "updated_at": "2026-08-12T09:00:00+08:00",
        },
        "feedback": {"learned_rules": []},
        "push": {"batches": {}},
    }
    migration_at = "2026-08-12T10:00:30+08:00"
    context_id = f"migration:oc_a:{source['revision']}"
    proofs = {}
    for key, resource_type, token, observation_id in (
        ("formal_document", "docx", "docx_formal_a", "migration-docx-1"),
        ("base", "bitable", "base_a", "migration-base-1"),
    ):
        proofs[key] = {
            "status": "verified", "policy_version": "chat-isolation-v3", "permission_chat_id": "oc_a",
            "resource_type": resource_type, "token_fingerprint": delivery_guard.fingerprint(token),
            "external_access_entity": "closed", "link_share_entity": "closed", "group_permission": "edit",
            "observed_at": "2026-08-12T10:00:00+08:00", "verified_at": "2026-08-12T10:00:05+08:00",
            "expires_at": "2026-08-12T10:01:00+08:00", "verification_context_id": context_id,
            "observation_id": observation_id,
            "owner_fingerprint": delivery_guard.fingerprint("ou_creator"),
            "permission_actor_fingerprint": delivery_guard.fingerprint("ou_dealclaw_app"),
            "permission_actor_role": "full_access", "permission_credential_type": "tenant_access_token",
            "automation_principal_fingerprint": delivery_guard.fingerprint("ou_dealclaw_app"),
            "automation_role": "full_access",
        }
    return {
        "chat_id": "oc_a", "source_state": source, "target_state_exists": False,
        "formal_document": {"token": "docx_formal_a", "title": "真实企业｜企业知识库", "profile_hash": "sha256:profile-a"},
        "live_permission_proofs": proofs, "migration_at": migration_at, "migration_actor": "ou_admin",
    }


def self_test() -> None:
    result = migrate(fixture())
    assert result["target_state"]["schema_version"] == 10
    assert result["target_state"]["feedback"]["feedback_cursor"] == ""
    invalid = fixture()
    invalid["source_state"]["status"] = "active"
    try:
        migrate(invalid)
    except MigrationError:
        pass
    else:
        raise AssertionError("Active legacy state was migrated without a stop-the-world transition")
    print("state_migrator self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("migrate", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = migrate(json.load(sys.stdin))
    except (MigrationError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
