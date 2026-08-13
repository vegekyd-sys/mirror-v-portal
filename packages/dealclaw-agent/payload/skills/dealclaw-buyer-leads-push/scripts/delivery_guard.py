#!/usr/bin/env python3
"""Validate guarded pipeline output immediately before Base write and group send."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from typing import Any


class DeliveryGuardError(RuntimeError):
    """Raised when pipeline output or delivery target is stale or cross-tenant."""


STATE_SCHEMA_VERSION = 10
PERMISSION_POLICY_VERSION = "chat-isolation-v3"
MAX_LIVE_PROOF_AGE_SECONDS = 60


def text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise DeliveryGuardError(f"{field} must be a non-empty string")
    return result


def integer(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise DeliveryGuardError(f"{field} must be an integer")
    return value


def obj(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DeliveryGuardError(f"{field} must be an object")
    return value


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def instant(value: Any, field: str) -> datetime:
    raw = text(value, field)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise DeliveryGuardError(f"{field} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DeliveryGuardError(f"{field} must include a timezone offset")
    return parsed


def permission_proof(
    value: Any,
    field: str,
    chat_id: str,
    resource_type: str,
    token: str,
    *,
    run_context_id: str | None = None,
    delivery_at: datetime | None = None,
) -> str:
    proof = obj(value, field)
    if proof.get("status") != "verified" or proof.get("policy_version") != PERMISSION_POLICY_VERSION:
        raise DeliveryGuardError(f"{field} is not verified")
    if proof.get("permission_chat_id") != chat_id:
        raise DeliveryGuardError(f"{field} crosses the invocation group")
    if proof.get("resource_type") != resource_type or proof.get("token_fingerprint") != fingerprint(token):
        raise DeliveryGuardError(f"{field} differs from the current binding")
    if proof.get("external_access_entity") != "closed" or proof.get("link_share_entity") != "closed":
        raise DeliveryGuardError(f"{field} permits external or link access")
    if proof.get("group_permission") != "edit":
        raise DeliveryGuardError(f"{field} lacks the required group edit proof")
    if proof.get("permission_actor_role") not in {"owner", "full_access"}:
        raise DeliveryGuardError(f"{field} lacks a permission-management actor")
    if proof.get("permission_credential_type") not in {"user_access_token", "tenant_access_token"}:
        raise DeliveryGuardError(f"{field} has an unsupported permission credential")
    if proof.get("automation_role") not in {"owner", "full_access"}:
        raise DeliveryGuardError(f"{field} does not prove DealClaw can manage the resource")
    for key in ("owner_fingerprint", "permission_actor_fingerprint", "automation_principal_fingerprint"):
        text(proof.get(key), f"{field}.{key}")
    observed_at = instant(proof.get("observed_at"), f"{field}.observed_at")
    verified_at = instant(proof.get("verified_at"), f"{field}.verified_at")
    expires_at = instant(proof.get("expires_at"), f"{field}.expires_at")
    observation_id = text(proof.get("observation_id"), f"{field}.observation_id")
    text(proof.get("verification_context_id"), f"{field}.verification_context_id")
    if observed_at > verified_at or verified_at > expires_at:
        raise DeliveryGuardError(f"{field} has an invalid proof time interval")
    if run_context_id is not None:
        if delivery_at is None:
            raise DeliveryGuardError("Internal error: delivery_at is required for a live proof")
        if proof.get("verification_context_id") != run_context_id:
            raise DeliveryGuardError(f"{field} was not collected for this run context")
        if not (observed_at <= verified_at <= delivery_at <= expires_at):
            raise DeliveryGuardError(f"{field} is stale or was collected after delivery")
        if (delivery_at - observed_at).total_seconds() > MAX_LIVE_PROOF_AGE_SECONDS:
            raise DeliveryGuardError(f"{field} is older than {MAX_LIVE_PROOF_AGE_SECONDS} seconds")
    return observation_id


def validate(payload: Any) -> dict[str, Any]:
    payload = obj(payload, "input")
    if set(payload) != {
        "invocation_chat_id",
        "current_state",
        "delivery_target",
        "pipeline_result",
        "live_permission_proofs",
        "delivery_at",
    }:
        raise DeliveryGuardError(
            "input must contain only invocation_chat_id, current_state, delivery_target, "
            "pipeline_result, live_permission_proofs, and delivery_at"
        )
    chat_id = text(payload.get("invocation_chat_id"), "invocation_chat_id")
    state = obj(payload.get("current_state"), "current_state")
    if integer(state.get("schema_version"), "current_state.schema_version") != STATE_SCHEMA_VERSION:
        raise DeliveryGuardError("Current state is not v10")
    revision = integer(state.get("revision"), "current_state.revision")
    if state.get("status") != "active" or state.get("chat_id") != chat_id:
        raise DeliveryGuardError("Current state is inactive or cross-group")
    binding = obj(state.get("binding"), "current_state.binding")
    profile = obj(state.get("profile"), "current_state.profile")
    if binding.get("chat_id") != chat_id or profile.get("source_chat_id") != chat_id:
        raise DeliveryGuardError("Current binding/profile crosses the invocation group")
    doc_token = text(binding.get("knowledge_doc_token"), "current_state.binding.knowledge_doc_token")
    base_token = text(binding.get("base_app_token"), "current_state.binding.base_app_token")
    permissions = obj(state.get("resource_permissions"), "current_state.resource_permissions")
    if permissions.get("policy_version") != PERMISSION_POLICY_VERSION or permissions.get("permission_chat_id") != chat_id:
        raise DeliveryGuardError("Current resource permission policy is missing or cross-group")
    permission_proof(permissions.get("formal_document"), "formal_document permission", chat_id, "docx", doc_token)
    permission_proof(permissions.get("base"), "Base permission", chat_id, "bitable", base_token)
    target = obj(payload.get("delivery_target"), "delivery_target")
    if set(target) != {"chat_id", "base_app_token", "base_table_id"}:
        raise DeliveryGuardError("delivery_target contains unsupported fields")
    if target.get("chat_id") != chat_id:
        raise DeliveryGuardError("Message target crosses the invocation group")
    if target.get("base_app_token") != binding.get("base_app_token") or target.get("base_table_id") != binding.get("base_table_id"):
        raise DeliveryGuardError("Base delivery target differs from the current binding")

    result = obj(payload.get("pipeline_result"), "pipeline_result")
    result_chat = text(result.get("chat_id"), "pipeline_result.chat_id")
    result_revision = integer(result.get("state_revision"), "pipeline_result.state_revision")
    company = text(result.get("company_name"), "pipeline_result.company_name")
    profile_hash = text(result.get("profile_hash"), "pipeline_result.profile_hash")
    run_context_id = text(result.get("run_context_id"), "pipeline_result.run_context_id")
    if result_chat != chat_id or result_revision != revision:
        raise DeliveryGuardError("Pipeline result is cross-group or stale")
    if company != binding.get("company_name"):
        raise DeliveryGuardError("Pipeline enterprise name differs from the current binding")
    if profile_hash != profile.get("normalized_hash"):
        raise DeliveryGuardError("Pipeline profile hash differs from the current profile")
    live_permissions = obj(payload.get("live_permission_proofs"), "live_permission_proofs")
    if set(live_permissions) != {"formal_document", "base"}:
        raise DeliveryGuardError("live_permission_proofs must contain only formal_document and base")
    delivery_at = instant(payload.get("delivery_at"), "delivery_at")
    formal_observation_id = permission_proof(
        live_permissions.get("formal_document"),
        "live formal_document permission",
        chat_id,
        "docx",
        doc_token,
        run_context_id=run_context_id,
        delivery_at=delivery_at,
    )
    base_observation_id = permission_proof(
        live_permissions.get("base"),
        "live Base permission",
        chat_id,
        "bitable",
        base_token,
        run_context_id=run_context_id,
        delivery_at=delivery_at,
    )
    if formal_observation_id == base_observation_id:
        raise DeliveryGuardError("Live Docx and Base proofs must come from distinct permission readbacks")
    records = result.get("records")
    if not isinstance(records, list):
        raise DeliveryGuardError("pipeline_result.records must be an array")
    counts = {"push": 0, "pool_only": 0, "exclude": 0}
    lead_ids = []
    for index, record in enumerate(records):
        record = obj(record, f"records[{index}]")
        if record.get("飞书群ID") != chat_id or record.get("企业画像群ID") != chat_id:
            raise DeliveryGuardError("Record crosses the current group")
        if record.get("画像企业名称") != company:
            raise DeliveryGuardError("Record profile enterprise name was changed")
        if record.get("企业画像版本") != profile_hash or record.get("运行上下文ID") != run_context_id:
            raise DeliveryGuardError("Record profile/run provenance was changed")
        action = record.get("匹配动作")
        if action not in counts:
            raise DeliveryGuardError("Record has an unsupported match action")
        counts[action] += 1
        lead_ids.append(text(record.get("线索ID"), f"records[{index}].线索ID"))
    material = "\n".join([chat_id, str(revision), company, profile_hash, run_context_id, *sorted(set(lead_ids))])
    return {
        "chat_id": chat_id,
        "state_revision": revision,
        "company_name": company,
        "profile_hash": profile_hash,
        "run_context_id": run_context_id,
        "delivery_at": delivery_at.isoformat(),
        "record_counts": counts,
        "delivery_id": "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest(),
    }


def fixture() -> dict[str, Any]:
    record = {
        "飞书群ID": "oc_a",
        "企业画像群ID": "oc_a",
        "画像企业名称": "真实企业",
        "企业画像版本": "sha256:profile-a",
        "运行上下文ID": "sha256:run-a",
        "匹配动作": "push",
        "线索ID": "lead-1",
    }
    payload = {
        "invocation_chat_id": "oc_a",
        "current_state": {
            "schema_version": 10,
            "revision": 8,
            "status": "active",
            "chat_id": "oc_a",
            "binding": {
                "chat_id": "oc_a",
                "company_name": "真实企业",
                "knowledge_doc_token": "docx-a",
                "base_app_token": "base-a",
                "base_table_id": "table-a",
            },
            "resource_permissions": {
                "policy_version": "chat-isolation-v3",
                "permission_chat_id": "oc_a",
                "formal_document": {
                    "status": "verified",
                    "policy_version": "chat-isolation-v3",
                    "permission_chat_id": "oc_a",
                    "resource_type": "docx",
                    "token_fingerprint": fingerprint("docx-a"),
                    "external_access_entity": "closed",
                    "link_share_entity": "closed",
                    "group_permission": "edit",
                    "observed_at": "2026-08-12T09:29:40+08:00",
                    "verified_at": "2026-08-12T09:30:00+08:00",
                    "expires_at": "2026-08-12T09:30:40+08:00",
                    "verification_context_id": "binding:oc_a:8",
                    "observation_id": "stored-docx-8",
                    "owner_fingerprint": fingerprint("ou_creator"),
                    "permission_actor_fingerprint": fingerprint("ou_creator"),
                    "permission_actor_role": "owner",
                    "permission_credential_type": "user_access_token",
                    "automation_principal_fingerprint": fingerprint("ou_dealclaw_app"),
                    "automation_role": "full_access",
                },
                "base": {
                    "status": "verified",
                    "policy_version": "chat-isolation-v3",
                    "permission_chat_id": "oc_a",
                    "resource_type": "bitable",
                    "token_fingerprint": fingerprint("base-a"),
                    "external_access_entity": "closed",
                    "link_share_entity": "closed",
                    "group_permission": "edit",
                    "observed_at": "2026-08-12T09:29:41+08:00",
                    "verified_at": "2026-08-12T09:30:00+08:00",
                    "expires_at": "2026-08-12T09:30:41+08:00",
                    "verification_context_id": "binding:oc_a:8",
                    "observation_id": "stored-base-8",
                    "owner_fingerprint": fingerprint("ou_creator"),
                    "permission_actor_fingerprint": fingerprint("ou_creator"),
                    "permission_actor_role": "owner",
                    "permission_credential_type": "user_access_token",
                    "automation_principal_fingerprint": fingerprint("ou_dealclaw_app"),
                    "automation_role": "full_access",
                },
            },
            "profile": {"source_chat_id": "oc_a", "normalized_hash": "sha256:profile-a"},
        },
        "delivery_target": {"chat_id": "oc_a", "base_app_token": "base-a", "base_table_id": "table-a"},
        "delivery_at": "2026-08-12T10:00:30+08:00",
        "live_permission_proofs": {},
        "pipeline_result": {
            "chat_id": "oc_a",
            "state_revision": 8,
            "company_name": "真实企业",
            "profile_hash": "sha256:profile-a",
            "run_context_id": "sha256:run-a",
            "records": [record],
        },
    }
    payload["live_permission_proofs"] = {}
    for key, resource_type, token, observation_id in (
        ("formal_document", "docx", "docx-a", "live-docx-1"),
        ("base", "bitable", "base-a", "live-base-1"),
    ):
        payload["live_permission_proofs"][key] = {
            "status": "verified",
            "policy_version": "chat-isolation-v3",
            "permission_chat_id": "oc_a",
            "resource_type": resource_type,
            "token_fingerprint": fingerprint(token),
            "external_access_entity": "closed",
            "link_share_entity": "closed",
            "group_permission": "edit",
            "observed_at": "2026-08-12T10:00:00+08:00",
            "verified_at": "2026-08-12T10:00:05+08:00",
            "expires_at": "2026-08-12T10:01:00+08:00",
            "verification_context_id": "sha256:run-a",
            "observation_id": observation_id,
            "owner_fingerprint": fingerprint("ou_creator"),
            "permission_actor_fingerprint": fingerprint("ou_dealclaw_app"),
            "permission_actor_role": "full_access",
            "permission_credential_type": "tenant_access_token",
            "automation_principal_fingerprint": fingerprint("ou_dealclaw_app"),
            "automation_role": "full_access",
        }
    return payload


def self_test() -> None:
    payload = fixture()
    assert validate(payload)["record_counts"]["push"] == 1
    invalid = []
    stale = json.loads(json.dumps(payload, ensure_ascii=False))
    stale["current_state"]["revision"] = 9
    invalid.append(stale)
    fake = json.loads(json.dumps(payload, ensure_ascii=False))
    fake["pipeline_result"]["records"][0]["画像企业名称"] = "错误固定企业"
    invalid.append(fake)
    crossed = json.loads(json.dumps(payload, ensure_ascii=False))
    crossed["delivery_target"]["chat_id"] = "oc_b"
    invalid.append(crossed)
    public_resource = json.loads(json.dumps(payload, ensure_ascii=False))
    public_resource["current_state"]["resource_permissions"]["base"]["link_share_entity"] = "anyone_editable"
    invalid.append(public_resource)
    live_public_resource = json.loads(json.dumps(payload, ensure_ascii=False))
    live_public_resource["live_permission_proofs"]["formal_document"]["link_share_entity"] = "anyone_readable"
    invalid.append(live_public_resource)
    stale_live_resource = json.loads(json.dumps(payload, ensure_ascii=False))
    stale_live_resource["live_permission_proofs"]["base"]["expires_at"] = "2026-08-12T10:00:10+08:00"
    invalid.append(stale_live_resource)
    wrong_context = json.loads(json.dumps(payload, ensure_ascii=False))
    wrong_context["live_permission_proofs"]["base"]["verification_context_id"] = "sha256:other-run"
    invalid.append(wrong_context)
    for item in invalid:
        try:
            validate(item)
        except DeliveryGuardError:
            pass
        else:
            raise AssertionError("Unsafe delivery was not rejected")
    print("delivery_guard self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = validate(json.load(sys.stdin))
    except (DeliveryGuardError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
