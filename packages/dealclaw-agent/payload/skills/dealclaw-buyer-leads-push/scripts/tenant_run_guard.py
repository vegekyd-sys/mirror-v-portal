#!/usr/bin/env python3
"""Enforce one chat's formal profile, tokens, and supplier binding before lead retrieval."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from typing import Any


class RunGuardError(RuntimeError):
    """Raised when a run can cross tenants or use an unverified profile."""


PLACEHOLDER_SUPPLIER_IDS = {
    "supplier-id",
    "your-supplier-id",
    "<supplier-id>",
    "<configured supplier id>",
    "test",
    "demo",
    "example",
}
PROFILE_SCORE_KEYS = {
    "source_chat_id",
    "products",
    "buyer_types",
    "target_countries",
    "moq",
    "desired_buyer_tags",
    "buyer_profile_keywords",
    "intent_keywords",
}
STATE_SCHEMA_VERSION = 10
PERMISSION_POLICY_VERSION = "chat-isolation-v3"
MAX_PRODUCTS = 20
MAX_TARGET_COUNTRIES = 20
MAX_QUERY_JOBS = 100
PERMISSION_PROOF_KEYS = {
    "status",
    "policy_version",
    "permission_chat_id",
    "resource_type",
    "token_fingerprint",
    "external_access_entity",
    "link_share_entity",
    "group_permission",
    "observed_at",
    "verified_at",
    "expires_at",
    "verification_context_id",
    "observation_id",
    "owner_fingerprint",
    "permission_actor_fingerprint",
    "permission_actor_role",
    "permission_credential_type",
    "automation_principal_fingerprint",
    "automation_role",
}


def normalized(value: Any) -> str:
    return " ".join(value.split()).casefold() if isinstance(value, str) else ""


def require_text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise RunGuardError(f"{field} must be a non-empty string")
    return result


def require_object(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RunGuardError(f"{field} must be an object")
    return value


def reject_extra(value: dict[str, Any], allowed: set[str], field: str) -> None:
    extra = sorted(set(value) - allowed)
    if extra:
        raise RunGuardError(f"{field} contains disallowed fields: {', '.join(extra)}")


def require_integer(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise RunGuardError(f"{field} must be an integer")
    return value


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def validate_permission_proof(
    value: Any, field: str, chat_id: str, resource_type: str, token: str
) -> dict[str, Any]:
    proof = require_object(value, field)
    reject_extra(proof, PERMISSION_PROOF_KEYS, field)
    if set(proof) != PERMISSION_PROOF_KEYS:
        missing = sorted(PERMISSION_PROOF_KEYS - set(proof))
        raise RunGuardError(f"{field} is missing fields: {', '.join(missing)}")
    if proof.get("status") != "verified" or proof.get("policy_version") != PERMISSION_POLICY_VERSION:
        raise RunGuardError(f"{field} is not a verified {PERMISSION_POLICY_VERSION} proof")
    if proof.get("permission_chat_id") != chat_id:
        raise RunGuardError(f"{field} crosses the invocation chat_id boundary")
    if proof.get("resource_type") != resource_type:
        raise RunGuardError(f"{field} has the wrong resource type")
    if proof.get("token_fingerprint") != fingerprint(token):
        raise RunGuardError(f"{field} does not match the bound resource token")
    if proof.get("external_access_entity") != "closed" or proof.get("link_share_entity") != "closed":
        raise RunGuardError(f"{field} permits external or link access")
    if proof.get("group_permission") != "edit":
        raise RunGuardError(f"{field} does not grant the bound group edit permission")
    for key in ("owner_fingerprint", "permission_actor_fingerprint", "automation_principal_fingerprint"):
        require_text(proof.get(key), f"{field}.{key}")
    if proof.get("permission_actor_role") not in {"owner", "full_access"}:
        raise RunGuardError(f"{field} lacks a verified permission actor role")
    if proof.get("permission_credential_type") not in {"user_access_token", "tenant_access_token"}:
        raise RunGuardError(f"{field} lacks a verified permission credential type")
    if proof.get("automation_role") not in {"owner", "full_access"}:
        raise RunGuardError(f"{field} does not prove DealClaw management access")
    require_text(proof.get("verified_at"), f"{field}.verified_at")
    return proof


def list_of_text(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise RunGuardError(f"{field} must be an array")
    output: dict[str, str] = {}
    for index, item in enumerate(value):
        text = require_text(item, f"{field}[{index}]")
        output.setdefault(normalized(text), text)
    return [output[key] for key in sorted(output)]


def profile_items(
    value: Any, field: str, require_categories: bool, maximum: int | None = None
) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise RunGuardError(f"profile.{field} must be a non-empty array")
    if maximum is not None and len(value) > maximum:
        raise RunGuardError(f"profile.{field} exceeds the maximum of {maximum}")
    output = []
    seen_names = set()
    for index, item in enumerate(value):
        item = require_object(item, f"profile.{field}[{index}]")
        allowed = {"name", "aliases", "categories"} if require_categories else {"name", "aliases"}
        reject_extra(item, allowed, f"profile.{field}[{index}]")
        name = require_text(item.get("name"), f"profile.{field}[{index}].name")
        name_key = normalized(name)
        if name_key in seen_names:
            raise RunGuardError(f"profile.{field} contains duplicate names")
        seen_names.add(name_key)
        result = {
            "name": name,
            "aliases": list_of_text(item.get("aliases", []), f"profile.{field}[{index}].aliases"),
        }
        if require_categories:
            result["categories"] = list_of_text(
                item.get("categories"), f"profile.{field}[{index}].categories"
            )
            if not result["categories"]:
                raise RunGuardError(f"profile.{field}[{index}] has no confirmed category")
        output.append(result)
    return sorted(output, key=lambda item: normalized(item["name"]))


def scoring_profile(profile: dict[str, Any], chat_id: str) -> dict[str, Any]:
    if require_text(profile.get("source_chat_id"), "profile.source_chat_id") != chat_id:
        raise RunGuardError("Profile crosses the invocation chat_id boundary")
    products = profile_items(profile.get("products"), "products", True, MAX_PRODUCTS)
    buyer_types_raw = profile.get("buyer_types", [])
    buyer_types = [] if buyer_types_raw == [] else profile_items(buyer_types_raw, "buyer_types", False)
    countries = profile_items(
        profile.get("target_countries"), "target_countries", False, MAX_TARGET_COUNTRIES
    )
    moq = profile.get("moq")
    if moq is not None:
        moq = require_object(moq, "profile.moq")
        reject_extra(moq, {"value", "unit"}, "profile.moq")
        quantity = moq.get("value")
        if not isinstance(quantity, (int, float)) or isinstance(quantity, bool) or quantity <= 0:
            raise RunGuardError("profile.moq.value must be positive")
        moq = {"value": quantity, "unit": require_text(moq.get("unit"), "profile.moq.unit")}
    return {
        "source_chat_id": chat_id,
        "products": products,
        "buyer_types": buyer_types,
        "target_countries": countries,
        "moq": moq,
        "desired_buyer_tags": list_of_text(profile.get("desired_buyer_tags", []), "profile.desired_buyer_tags"),
        "buyer_profile_keywords": list_of_text(profile.get("buyer_profile_keywords", []), "profile.buyer_profile_keywords"),
        "intent_keywords": list_of_text(profile.get("intent_keywords", []), "profile.intent_keywords"),
    }


def validate_context(payload: Any) -> dict[str, Any]:
    payload = require_object(payload, "input")
    reject_extra(payload, {"invocation_chat_id", "run_at", "source_timezone", "state", "formal_document"}, "input")
    chat_id = require_text(payload.get("invocation_chat_id"), "invocation_chat_id")
    run_at = require_text(payload.get("run_at"), "run_at")
    source_timezone = require_text(payload.get("source_timezone"), "source_timezone")

    state = require_object(payload.get("state"), "state")
    reject_extra(
        state,
        {"schema_version", "revision", "status", "chat_id", "binding", "binding_recovery", "resource_permissions", "profile", "onboarding", "generation", "feedback", "run", "push", "migration", "post_confirmation"},
        "state",
    )
    if require_integer(state.get("schema_version"), "state.schema_version") != STATE_SCHEMA_VERSION:
        raise RunGuardError("State schema_version must be 10; run the bundled state migration before running")
    revision = require_integer(state.get("revision"), "state.revision")
    if revision < 1:
        raise RunGuardError("state.revision must be positive")
    if require_text(state.get("status"), "state.status") != "active":
        raise RunGuardError("State is not active")
    if require_text(state.get("chat_id"), "state.chat_id") != chat_id:
        raise RunGuardError("State crosses the invocation chat_id boundary")

    binding = require_object(state.get("binding"), "state.binding")
    reject_extra(
        binding,
        {
            "chat_id",
            "company_name",
            "company_id",
            "knowledge_doc_token",
            "base_app_token",
            "base_table_id",
            "tradechina_supplier_id",
            "document_origin",
            "bound_at",
            "bound_by",
        },
        "state.binding",
    )
    if require_text(binding.get("chat_id"), "binding.chat_id") != chat_id:
        raise RunGuardError("Binding crosses the invocation chat_id boundary")
    company = require_text(binding.get("company_name"), "binding.company_name")
    company_id = binding.get("company_id")
    if company_id is not None:
        company_id = require_text(company_id, "binding.company_id")
    origin = require_text(binding.get("document_origin"), "binding.document_origin")
    if origin not in {"group_supplied_formal", "formalized_from_group_history", "user_intent_profile"}:
        raise RunGuardError("binding.document_origin is unsupported")
    intent_mode = origin == "user_intent_profile"
    raw_doc_token = binding.get("knowledge_doc_token")
    if not isinstance(raw_doc_token, str):
        raise RunGuardError("binding.knowledge_doc_token must be a string")
    doc_token = raw_doc_token.strip()
    if intent_mode:
        if doc_token:
            raise RunGuardError("user_intent_profile binding must not carry a knowledge document token")
    else:
        doc_token = require_text(raw_doc_token, "binding.knowledge_doc_token")
    base_token = require_text(binding.get("base_app_token"), "binding.base_app_token")
    table_id = require_text(binding.get("base_table_id"), "binding.base_table_id")
    supplier_id = require_text(binding.get("tradechina_supplier_id"), "binding.tradechina_supplier_id")
    if normalized(supplier_id) in PLACEHOLDER_SUPPLIER_IDS:
        raise RunGuardError("binding.tradechina_supplier_id is a placeholder")

    permissions = require_object(state.get("resource_permissions"), "state.resource_permissions")
    reject_extra(
        permissions,
        {"policy_version", "permission_chat_id", "formal_document", "base"},
        "state.resource_permissions",
    )
    if permissions.get("policy_version") != PERMISSION_POLICY_VERSION:
        raise RunGuardError("Resource permission policy is missing or unsupported")
    if permissions.get("permission_chat_id") != chat_id:
        raise RunGuardError("Resource permissions cross the invocation chat_id boundary")
    formal_proof_raw = permissions.get("formal_document")
    if intent_mode:
        if formal_proof_raw is not None:
            raise RunGuardError("user_intent_profile state must not carry a formal-document permission proof")
        formal_permission = None
    else:
        formal_permission = validate_permission_proof(
            formal_proof_raw,
            "state.resource_permissions.formal_document",
            chat_id,
            "docx",
            doc_token,
        )
    base_permission = validate_permission_proof(
        permissions.get("base"),
        "state.resource_permissions.base",
        chat_id,
        "bitable",
        base_token,
    )

    doc_profile_hash = None
    if intent_mode:
        formal_payload = payload.get("formal_document")
        if formal_payload is not None:
            raise RunGuardError("user_intent_profile runs must not read a formal document")
    else:
        formal = require_object(payload.get("formal_document"), "formal_document")
        reject_extra(formal, {"token", "title", "profile_hash"}, "formal_document")
        if require_text(formal.get("token"), "formal_document.token") != doc_token:
            raise RunGuardError("The document read by the host is not the bound formal document token")
        expected_title = f"{company}｜企业知识库"
        if require_text(formal.get("title"), "formal_document.title") != expected_title:
            raise RunGuardError("Formal document title does not exactly match the bound company")
        doc_profile_hash = require_text(formal.get("profile_hash"), "formal_document.profile_hash")

    profile = require_object(state.get("profile"), "state.profile")
    reject_extra(
        profile,
        PROFILE_SCORE_KEYS
        | {
            "source_doc_token",
            "source_kind",
            "status",
            "normalized_hash",
            "confirmed_draft_version",
            "confirmed_draft_hash",
            "intent_confirmation",
            "updated_at",
        },
        "state.profile",
    )
    if require_text(profile.get("status"), "profile.status") != "active":
        raise RunGuardError("Formal profile is not active")
    profile_hash = require_text(profile.get("normalized_hash"), "profile.normalized_hash")
    if intent_mode:
        if profile.get("source_kind") != "user_intent":
            raise RunGuardError("user_intent_profile state must carry a user_intent profile")
        source_doc = profile.get("source_doc_token", "")
        if not isinstance(source_doc, str) or source_doc.strip():
            raise RunGuardError("user_intent profile must not reference a knowledge document")
        intent_confirmation = require_object(
            profile.get("intent_confirmation"), "profile.intent_confirmation"
        )
        reject_extra(
            intent_confirmation,
            {"actor_open_id", "signal", "confirmed_at"},
            "profile.intent_confirmation",
        )
        if set(intent_confirmation) != {"actor_open_id", "signal", "confirmed_at"}:
            raise RunGuardError("profile.intent_confirmation is missing fields")
        require_text(
            intent_confirmation.get("actor_open_id"), "profile.intent_confirmation.actor_open_id"
        )
        if intent_confirmation.get("signal") not in {"user_stated", "approved"}:
            raise RunGuardError("profile.intent_confirmation.signal is unsupported")
        require_text(
            intent_confirmation.get("confirmed_at"), "profile.intent_confirmation.confirmed_at"
        )
    else:
        if "intent_confirmation" in profile:
            raise RunGuardError("document-bound profiles must not carry intent_confirmation")
        if require_text(profile.get("source_doc_token"), "profile.source_doc_token") != doc_token:
            raise RunGuardError("Profile source token differs from the bound formal document")
        if profile_hash != doc_profile_hash:
            raise RunGuardError("Stored profile hash differs from the direct formal-document projection")

    if origin == "formalized_from_group_history":
        onboarding = require_object(state.get("onboarding"), "state.onboarding")
        if onboarding.get("status") != "completed" or onboarding.get("formalization_status") != "completed":
            raise RunGuardError("History-generated profile has not completed formalization")
        confirmation = require_object(onboarding.get("confirmation"), "onboarding.confirmation")
        confirmed_version = require_integer(profile.get("confirmed_draft_version"), "profile.confirmed_draft_version")
        if confirmation.get("draft_version") != confirmed_version:
            raise RunGuardError("Confirmed draft version does not match the active profile")
        confirmed_hash = require_text(profile.get("confirmed_draft_hash"), "profile.confirmed_draft_hash")
        if confirmation.get("draft_hash") != confirmed_hash:
            raise RunGuardError("Confirmed draft hash does not match the active profile")

    feedback = state.get("feedback", {})
    if not isinstance(feedback, dict):
        raise RunGuardError("state.feedback must be an object")
    learned_rules = feedback.get("learned_rules", [])
    if not isinstance(learned_rules, list):
        raise RunGuardError("state.feedback.learned_rules must be an array")

    score_profile = scoring_profile(profile, chat_id)
    jobs = [
        {"country_name": country["name"], "product_keyword": product["name"]}
        for country in score_profile["target_countries"]
        for product in score_profile["products"]
    ]
    if not jobs:
        raise RunGuardError("The formal profile produced no country/product query jobs")
    if len(jobs) > MAX_QUERY_JOBS:
        raise RunGuardError(f"Formal profile produces more than {MAX_QUERY_JOBS} country/product query jobs")
    context_material = "\n".join(
        [chat_id, str(revision), company, doc_token, base_token, table_id, supplier_id, profile_hash, run_at]
    )
    verified_marks = [base_permission["verified_at"]]
    if formal_permission is not None:
        verified_marks.append(formal_permission["verified_at"])
    return {
        "chat_id": chat_id,
        "run_at": run_at,
        "source_timezone": source_timezone,
        "state_revision": revision,
        "company_name": company,
        "company_id": company_id,
        "knowledge_doc_token": doc_token,
        "base_app_token": base_token,
        "base_table_id": table_id,
        "supplier_id": supplier_id,
        "document_origin": origin,
        "permission_policy_version": PERMISSION_POLICY_VERSION,
        "permission_verified_at": min(verified_marks),
        "profile_hash": profile_hash,
        "profile": score_profile,
        "penalty_rules": learned_rules,
        "query_jobs": jobs,
        "run_context_id": "sha256:" + hashlib.sha256(context_material.encode("utf-8")).hexdigest(),
    }


def public_plan(context: dict[str, Any]) -> dict[str, Any]:
    return {
        "chat_id": context["chat_id"],
        "state_revision": context["state_revision"],
        "company_name": context["company_name"],
        "knowledge_doc_fingerprint": fingerprint(context["knowledge_doc_token"]),
        "base_fingerprint": fingerprint(context["base_app_token"] + ":" + context["base_table_id"]),
        "supplier_binding_fingerprint": fingerprint(context["supplier_id"]),
        "profile_hash": context["profile_hash"],
        "run_context_id": context["run_context_id"],
        "query_jobs": context["query_jobs"],
    }


def fixture() -> dict[str, Any]:
    score = {
        "source_chat_id": "oc_a",
        "products": [{"name": "绗缝被", "aliases": ["Quilt"], "categories": ["床上用品"]}],
        "buyer_types": [],
        "target_countries": [{"name": "巴西", "aliases": ["Brazil"]}],
        "moq": None,
        "desired_buyer_tags": [],
        "buyer_profile_keywords": [],
        "intent_keywords": [],
    }
    return {
        "invocation_chat_id": "oc_a",
        "run_at": "2026-08-12T10:00:00+08:00",
        "source_timezone": "Asia/Shanghai",
        "formal_document": {"token": "docx_formal_a", "title": "真实企业｜企业知识库", "profile_hash": "sha256:profile-a"},
        "state": {
            "schema_version": 10,
            "revision": 8,
            "status": "active",
            "chat_id": "oc_a",
            "binding": {
                "chat_id": "oc_a",
                "company_name": "真实企业",
                "knowledge_doc_token": "docx_formal_a",
                "base_app_token": "base_a",
                "base_table_id": "table_a",
                "tradechina_supplier_id": "supplier-for-oc-a",
                "document_origin": "formalized_from_group_history",
                "bound_at": "2026-08-12T09:00:00+08:00",
                "bound_by": "ou_admin",
            },
            "resource_permissions": {
                "policy_version": "chat-isolation-v3",
                "permission_chat_id": "oc_a",
                "formal_document": {
                    "status": "verified",
                    "policy_version": "chat-isolation-v3",
                    "permission_chat_id": "oc_a",
                    "resource_type": "docx",
                    "token_fingerprint": fingerprint("docx_formal_a"),
                    "external_access_entity": "closed",
                    "link_share_entity": "closed",
                    "group_permission": "edit",
                    "observed_at": "2026-08-12T09:29:45+08:00",
                    "verified_at": "2026-08-12T09:30:00+08:00",
                    "expires_at": "2026-08-12T09:30:45+08:00",
                    "verification_context_id": "binding:oc_a:8",
                    "observation_id": "perm-docx-8",
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
                    "token_fingerprint": fingerprint("base_a"),
                    "external_access_entity": "closed",
                    "link_share_entity": "closed",
                    "group_permission": "edit",
                    "observed_at": "2026-08-12T09:29:46+08:00",
                    "verified_at": "2026-08-12T09:30:00+08:00",
                    "expires_at": "2026-08-12T09:30:46+08:00",
                    "verification_context_id": "binding:oc_a:8",
                    "observation_id": "perm-base-8",
                    "owner_fingerprint": fingerprint("ou_creator"),
                    "permission_actor_fingerprint": fingerprint("ou_creator"),
                    "permission_actor_role": "owner",
                    "permission_credential_type": "user_access_token",
                    "automation_principal_fingerprint": fingerprint("ou_dealclaw_app"),
                    "automation_role": "full_access",
                },
            },
            "profile": {
                **score,
                "source_doc_token": "docx_formal_a",
                "source_kind": "group_history",
                "status": "active",
                "normalized_hash": "sha256:profile-a",
                "confirmed_draft_version": 2,
                "confirmed_draft_hash": "sha256:draft-a",
                "updated_at": "2026-08-12T09:00:00+08:00",
            },
            "onboarding": {
                "status": "completed",
                "formalization_status": "completed",
                "confirmation": {"draft_version": 2, "draft_hash": "sha256:draft-a"},
            },
            "feedback": {"learned_rules": []},
        },
    }


def intent_fixture() -> dict[str, Any]:
    """A user_intent_profile binding: no knowledge document, intent-confirmed profile."""
    payload = fixture()
    payload["formal_document"] = None
    state = payload["state"]
    state["binding"]["document_origin"] = "user_intent_profile"
    state["binding"]["knowledge_doc_token"] = ""
    state["binding"]["company_id"] = "cmp_intent_a"
    del state["resource_permissions"]["formal_document"]
    profile = state["profile"]
    profile["source_doc_token"] = ""
    profile["source_kind"] = "user_intent"
    del profile["confirmed_draft_version"]
    del profile["confirmed_draft_hash"]
    profile["intent_confirmation"] = {
        "actor_open_id": "ou_user1",
        "signal": "user_stated",
        "confirmed_at": "2026-08-12T09:05:00+08:00",
    }
    return payload


def self_test() -> None:
    context = validate_context(fixture())
    assert context["company_name"] == "真实企业"
    assert context["supplier_id"] == "supplier-for-oc-a"
    assert context["query_jobs"] == [{"country_name": "巴西", "product_keyword": "绗缝被"}]
    assert "supplier_id" not in public_plan(context)

    intent_context = validate_context(intent_fixture())
    assert intent_context["document_origin"] == "user_intent_profile"
    assert intent_context["knowledge_doc_token"] == ""
    assert intent_context["company_id"] == "cmp_intent_a"
    assert intent_context["query_jobs"] == [{"country_name": "巴西", "product_keyword": "绗缝被"}]

    invalid = []
    missing_confirmation = intent_fixture()
    del missing_confirmation["state"]["profile"]["intent_confirmation"]
    invalid.append(missing_confirmation)
    bad_signal = intent_fixture()
    bad_signal["state"]["profile"]["intent_confirmation"]["signal"] = "pending"
    invalid.append(bad_signal)
    stray_doc = intent_fixture()
    stray_doc["formal_document"] = {"token": "docx_formal_a", "title": "真实企业｜企业知识库", "profile_hash": "sha256:profile-a"}
    invalid.append(stray_doc)
    stray_token = intent_fixture()
    stray_token["state"]["binding"]["knowledge_doc_token"] = "docx_formal_a"
    invalid.append(stray_token)
    empty_doc_origin = fixture()
    empty_doc_origin["state"]["binding"]["knowledge_doc_token"] = ""
    invalid.append(empty_doc_origin)
    doc_with_intent_confirmation = fixture()
    doc_with_intent_confirmation["state"]["profile"]["intent_confirmation"] = {
        "actor_open_id": "ou_user1",
        "signal": "user_stated",
        "confirmed_at": "2026-08-12T09:05:00+08:00",
    }
    invalid.append(doc_with_intent_confirmation)
    intent_wrong_kind = intent_fixture()
    intent_wrong_kind["state"]["profile"]["source_kind"] = "group_history"
    invalid.append(intent_wrong_kind)
    intent_stale_permission = intent_fixture()
    intent_stale_permission["state"]["resource_permissions"]["formal_document"] = fixture()["state"]["resource_permissions"]["formal_document"]
    invalid.append(intent_stale_permission)
    for payload in invalid:
        try:
            validate_context(payload)
        except RunGuardError:
            pass
        else:
            raise AssertionError("Unsafe intent-mode run context was not rejected")
    crossed = fixture()
    crossed["invocation_chat_id"] = "oc_b"
    invalid.append(crossed)
    wrong_doc = fixture()
    wrong_doc["formal_document"]["token"] = "docx_other"
    invalid.append(wrong_doc)
    fake_company = fixture()
    fake_company["formal_document"]["title"] = "错误固定企业｜企业知识库"
    invalid.append(fake_company)
    global_placeholder = fixture()
    global_placeholder["state"]["binding"]["tradechina_supplier_id"] = "test"
    invalid.append(global_placeholder)
    stale_profile = fixture()
    stale_profile["formal_document"]["profile_hash"] = "sha256:other"
    invalid.append(stale_profile)
    public_resource = fixture()
    public_resource["state"]["resource_permissions"]["formal_document"]["link_share_entity"] = "anyone_editable"
    invalid.append(public_resource)
    wrong_permission_chat = fixture()
    wrong_permission_chat["state"]["resource_permissions"]["base"]["permission_chat_id"] = "oc_b"
    invalid.append(wrong_permission_chat)
    query_explosion = fixture()
    query_explosion["state"]["profile"]["products"] = [
        {"name": f"产品{index}", "aliases": [], "categories": ["分类"]}
        for index in range(MAX_PRODUCTS + 1)
    ]
    invalid.append(query_explosion)
    rebind_required = fixture()
    rebind_required["state"]["status"] = "rebind_required"
    rebind_required["state"]["binding_recovery"] = {
        "reason": "knowledge_document_deleted",
        "failed_token_fingerprint": fingerprint("docx_formal_a"),
        "detected_at": "2026-08-13T10:00:00+08:00",
        "reminder_status": "sent",
        "reminder_message_id": "om_rebind_1",
        "reminded_at": "2026-08-13T10:00:05+08:00",
    }
    invalid.append(rebind_required)
    for payload in invalid:
        try:
            validate_context(payload)
        except RunGuardError:
            pass
        else:
            raise AssertionError("Unsafe tenant run context was not rejected")
    print("tenant_run_guard self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        result = public_plan(validate_context(json.load(sys.stdin)))
    except (RunGuardError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
