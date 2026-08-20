#!/usr/bin/env python3
"""Guard the confirm -> formalize -> fresh retrieval -> push -> result workflow."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import re
import sys
from typing import Any
from urllib.parse import unquote, urlparse


class PostConfirmationError(RuntimeError):
    """Raised when the immediate post-confirmation workflow is stale or inconsistent."""


ACTIVE_SCHEMA_VERSION = 10
FLOW_VERSION = "post-confirmation-v1"
FAILURE_STAGES = {"progress_notice", "retrieval", "permission", "base_write", "card_render", "card_send"}


def text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise PostConfirmationError(f"{field} must be a non-empty string")
    return result


def integer(value: Any, field: str, minimum: int = 0) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise PostConfirmationError(f"{field} must be an integer >= {minimum}")
    return value


def obj(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PostConfirmationError(f"{field} must be an object")
    return value


def instant(value: Any, field: str) -> datetime:
    raw = text(value, field)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PostConfirmationError(f"{field} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise PostConfirmationError(f"{field} must include a timezone offset")
    return parsed


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def resource_url(value: Any, field: str, resource_kind: str, token: str) -> str:
    url = text(value, field)
    parsed = urlparse(url)
    host = (parsed.hostname or "").casefold()
    if parsed.scheme != "https" or not (
        host == "feishu.cn" or host.endswith(".feishu.cn")
        or host == "larksuite.com" or host.endswith(".larksuite.com")
    ):
        raise PostConfirmationError(f"{field} must be an HTTPS Feishu/Lark URL")
    if parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
        raise PostConfirmationError(f"{field} contains unsupported authority, port, or fragment data")
    raw_segments = [segment for segment in parsed.path.split("/") if segment]
    segments = [unquote(segment) for segment in raw_segments]
    if len(segments) != 2 or segments != [resource_kind, token] or raw_segments[1] != token:
        raise PostConfirmationError(f"{field} path does not exactly match the bound {resource_kind} token")
    return url


def active_context(state_value: Any, chat_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    state = obj(state_value, "current_state")
    if state.get("schema_version") != ACTIVE_SCHEMA_VERSION:
        raise PostConfirmationError("Current state is not schema v10")
    integer(state.get("revision"), "current_state.revision", 1)
    if state.get("status") != "active" or state.get("chat_id") != chat_id:
        raise PostConfirmationError("Current state is inactive or crosses chat_id")
    binding = obj(state.get("binding"), "current_state.binding")
    profile = obj(state.get("profile"), "current_state.profile")
    onboarding = obj(state.get("onboarding"), "current_state.onboarding")
    if binding.get("chat_id") != chat_id or profile.get("source_chat_id") != chat_id:
        raise PostConfirmationError("Binding/profile crosses chat_id")
    if onboarding.get("status") != "completed" or onboarding.get("formalization_status") != "completed":
        raise PostConfirmationError("Formalization is not completed")
    if profile.get("status") != "active" or profile.get("source_doc_token") != binding.get("knowledge_doc_token"):
        raise PostConfirmationError("Active profile is not bound to the formal document")
    return state, binding, onboarding


def start(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {
        "chat_id", "current_state", "confirmation_result", "started_at", "formal_document_url", "base_url"
    }:
        raise PostConfirmationError("start input has unsupported fields")
    chat_id = text(payload.get("chat_id"), "chat_id")
    state, binding, onboarding = active_context(payload.get("current_state"), chat_id)
    confirmation = obj(payload.get("confirmation_result"), "confirmation_result")
    required = {
        "chat_id", "state_revision", "decision", "actor_open_id", "message_or_action_id",
        "draft_version", "draft_hash", "formalization_id",
    }
    if set(confirmation) != required or confirmation.get("decision") != "formalize":
        raise PostConfirmationError("confirmation_result is not an exact formalize decision")
    if confirmation.get("chat_id") != chat_id:
        raise PostConfirmationError("Confirmation crosses chat_id")
    if confirmation.get("formalization_id") != onboarding.get("formalization_id"):
        raise PostConfirmationError("Confirmation formalization_id differs from active state")
    stored_confirmation = obj(onboarding.get("confirmation"), "onboarding.confirmation")
    for key in ("message_or_action_id", "draft_version", "draft_hash"):
        if confirmation.get(key) != stored_confirmation.get(key):
            raise PostConfirmationError(f"Confirmation {key} differs from active state")
    started_at = instant(payload.get("started_at"), "started_at")
    material = "\n".join(
        [chat_id, confirmation["formalization_id"], confirmation["message_or_action_id"]]
    )
    operation_id = "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest()
    existing = state.get("post_confirmation")
    if existing is not None:
        existing = obj(existing, "current_state.post_confirmation")
        if existing.get("operation_id") != operation_id:
            raise PostConfirmationError("A different post-confirmation operation already exists")
        if existing.get("status") == "completed":
            return {
                "status": "already_completed",
                "operation_id": operation_id,
                "send_progress_notice": False,
                "rerun_interface": False,
            }
        return {
            "status": "resume_required",
            "operation_id": operation_id,
            "current_stage": existing.get("status"),
            "send_progress_notice": existing.get("progress_message_id") in (None, ""),
            "rerun_interface": False,
        }
    company = text(binding.get("company_name"), "binding.company_name")
    doc_token = text(binding.get("knowledge_doc_token"), "binding.knowledge_doc_token")
    base_token = text(binding.get("base_app_token"), "binding.base_app_token")
    formal_document_url = resource_url(
        payload.get("formal_document_url"), "formal_document_url", "docx", doc_token
    )
    base_url = resource_url(payload.get("base_url"), "base_url", "base", base_token)
    return {
        "status": "start_required",
        "flow_version": FLOW_VERSION,
        "chat_id": chat_id,
        "expected_state_revision": state["revision"],
        "operation_id": operation_id,
        "progress_notice_idempotency_key": operation_id + ":progress",
        "progress_message": (
            f"企业画像已确认，{company}的正式企业知识库已生成并绑定。\n"
            f"正式企业知识库：{formal_document_url}\n"
            f"企业线索池：{base_url}\n"
            "正在根据正式企业画像重新匹配合适的买家采购需求，完成后将在本群推送结果。"
        ),
        "state_patch": {
            "flow_version": FLOW_VERSION,
            "operation_id": operation_id,
            "formalization_id": confirmation["formalization_id"],
            "confirmation_event_id": confirmation["message_or_action_id"],
            "status": "awaiting_progress_notice",
            "started_at": started_at.isoformat(),
            "formal_doc_fingerprint": fingerprint(doc_token),
            "progress_message_id": "",
        },
    }


def authorize(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {"chat_id", "current_state", "operation_id", "run_at"}:
        raise PostConfirmationError("authorize input has unsupported fields")
    chat_id = text(payload.get("chat_id"), "chat_id")
    state, _, onboarding = active_context(payload.get("current_state"), chat_id)
    operation_id = text(payload.get("operation_id"), "operation_id")
    flow = obj(state.get("post_confirmation"), "current_state.post_confirmation")
    if flow.get("flow_version") != FLOW_VERSION or flow.get("operation_id") != operation_id:
        raise PostConfirmationError("Post-confirmation operation differs from persisted state")
    if flow.get("formalization_id") != onboarding.get("formalization_id"):
        raise PostConfirmationError("Post-confirmation operation targets another formalization")
    if flow.get("status") != "progress_notified":
        raise PostConfirmationError("Progress notice must be confirmed before buyer retrieval")
    progress_message_id = text(flow.get("progress_message_id"), "post_confirmation.progress_message_id")
    run_at = instant(payload.get("run_at"), "run_at")
    if run_at < instant(flow.get("started_at"), "post_confirmation.started_at"):
        raise PostConfirmationError("run_at predates the confirmation workflow")
    profile = obj(state.get("profile"), "current_state.profile")
    profile_hash = text(profile.get("normalized_hash"), "profile.normalized_hash")
    material = "\n".join([operation_id, str(state["revision"]), profile_hash, run_at.isoformat()])
    interface_call_id = "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest()
    return {
        "status": "authorized",
        "flow_version": FLOW_VERSION,
        "kind": "post_confirmation",
        "chat_id": chat_id,
        "state_revision": state["revision"],
        "operation_id": operation_id,
        "formalization_id": flow["formalization_id"],
        "profile_hash": profile_hash,
        "run_at": run_at.isoformat(),
        "progress_message_id": progress_message_id,
        "interface_call_id": interface_call_id,
        "fresh_interface_call_required": True,
        "pre_confirmation_candidates_forbidden": True,
    }


def validate_authorization(value: Any, context_payload: Any, guarded_context: dict[str, Any]) -> dict[str, Any]:
    auth = obj(value, "post_confirmation_authorization")
    required = {
        "status", "flow_version", "kind", "chat_id", "state_revision", "operation_id",
        "formalization_id", "profile_hash", "run_at", "progress_message_id", "interface_call_id",
        "fresh_interface_call_required", "pre_confirmation_candidates_forbidden",
    }
    if set(auth) != required or auth.get("status") != "authorized" or auth.get("flow_version") != FLOW_VERSION:
        raise PostConfirmationError("Post-confirmation authorization has an invalid schema")
    if auth.get("kind") != "post_confirmation" or auth.get("fresh_interface_call_required") is not True:
        raise PostConfirmationError("Fresh post-confirmation interface retrieval is not authorized")
    if auth.get("pre_confirmation_candidates_forbidden") is not True:
        raise PostConfirmationError("Authorization permits stale pre-confirmation candidates")
    state = obj(obj(context_payload, "context").get("state"), "context.state")
    onboarding = obj(state.get("onboarding"), "context.state.onboarding")
    flow = obj(state.get("post_confirmation"), "context.state.post_confirmation")
    checks = {
        "chat_id": guarded_context.get("chat_id"),
        "state_revision": guarded_context.get("state_revision"),
        "profile_hash": guarded_context.get("profile_hash"),
        "run_at": guarded_context.get("run_at"),
        "formalization_id": onboarding.get("formalization_id"),
        "operation_id": flow.get("operation_id"),
        "progress_message_id": flow.get("progress_message_id"),
    }
    for field, expected in checks.items():
        if auth.get(field) != expected:
            raise PostConfirmationError(f"Authorization {field} differs from the guarded active state")
    if flow.get("status") != "progress_notified":
        raise PostConfirmationError("Persisted post-confirmation flow is not ready for retrieval")
    text(auth.get("interface_call_id"), "post_confirmation_authorization.interface_call_id")
    return auth


def complete(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {
        "authorization", "current_state", "pipeline_result", "delivery_result", "card_result",
        "sent_message_ids", "completed_at",
    }:
        raise PostConfirmationError("complete input has unsupported fields")
    auth = obj(payload.get("authorization"), "authorization")
    if auth.get("status") != "authorized" or auth.get("kind") != "post_confirmation":
        raise PostConfirmationError("Completion lacks a post-confirmation authorization")
    chat_id = text(auth.get("chat_id"), "authorization.chat_id")
    state, binding, _ = active_context(payload.get("current_state"), chat_id)
    flow = obj(state.get("post_confirmation"), "current_state.post_confirmation")
    if flow.get("operation_id") != auth.get("operation_id"):
        raise PostConfirmationError("Completion operation differs from persisted state")
    if flow.get("status") not in {"progress_notified", "matching", "writing", "pushing"}:
        raise PostConfirmationError("Persisted post-confirmation stage cannot be completed")
    pipeline = obj(payload.get("pipeline_result"), "pipeline_result")
    execution = obj(pipeline.get("post_confirmation_execution"), "pipeline_result.post_confirmation_execution")
    for field in ("operation_id", "interface_call_id", "formalization_id"):
        if execution.get(field) != auth.get(field):
            raise PostConfirmationError(f"Pipeline execution {field} differs from authorization")
    if execution.get("fresh_interface_call") is not True or execution.get("pre_confirmation_candidates_reused") is not False:
        raise PostConfirmationError("Pipeline did not prove a fresh post-confirmation interface call")
    if pipeline.get("chat_id") != chat_id or pipeline.get("profile_hash") != auth.get("profile_hash"):
        raise PostConfirmationError("Pipeline result is cross-chat or uses another profile")
    records = pipeline.get("records")
    if not isinstance(records, list):
        raise PostConfirmationError("pipeline_result.records must be an array")
    delivery = obj(payload.get("delivery_result"), "delivery_result")
    if delivery.get("chat_id") != chat_id or delivery.get("run_context_id") != pipeline.get("run_context_id"):
        raise PostConfirmationError("Delivery result differs from the fresh pipeline result")
    counts = obj(delivery.get("record_counts"), "delivery_result.record_counts")
    for action in ("push", "pool_only", "exclude"):
        integer(counts.get(action), f"record_counts.{action}")
    if sum(counts[action] for action in ("push", "pool_only", "exclude")) != len(records):
        raise PostConfirmationError("Delivery counts do not equal fresh pipeline record count")
    sent_ids = payload.get("sent_message_ids")
    if not isinstance(sent_ids, list) or len(set(sent_ids)) != len(sent_ids):
        raise PostConfirmationError("sent_message_ids must be a unique array")
    sent_ids = [text(value, "sent_message_ids[]") for value in sent_ids]
    card = payload.get("card_result")
    pushed_leads = 0
    batch_id = ""
    if card is not None:
        card = obj(card, "card_result")
        if card.get("chat_id") != chat_id or card.get("delivery_id") != delivery.get("delivery_id"):
            raise PostConfirmationError("Card result differs from guarded delivery")
        if integer(card.get("message_count"), "card_result.message_count") != len(sent_ids):
            raise PostConfirmationError("Sent message count differs from rendered card count")
        pushed_leads = integer(card.get("lead_count"), "card_result.lead_count")
        if pushed_leads > counts["push"]:
            raise PostConfirmationError("Rendered pushed lead count exceeds guarded push candidates")
        batch_id = text(card.get("batch_id"), "card_result.batch_id")
    elif sent_ids:
        raise PostConfirmationError("Message IDs are present without a card result")
    completed_at = instant(payload.get("completed_at"), "completed_at")
    pool_written = counts["push"] + counts["pool_only"]
    company = text(binding.get("company_name"), "binding.company_name")
    if pushed_leads:
        result_message = (
            f"{company}的企业画像确认后匹配已完成：本次重新获取并评估{len(records)}条买家线索，"
            f"{pool_written}条进入企业线索池，已推送{pushed_leads}条高匹配买家线索。"
        )
    else:
        result_message = (
            f"{company}的企业画像确认后匹配已完成：本次重新获取并评估{len(records)}条买家线索，"
            f"{pool_written}条进入企业线索池，暂未发现符合本次推送门槛的新买家线索。"
        )
    return {
        "status": "completed",
        "chat_id": chat_id,
        "operation_id": auth["operation_id"],
        "result_notice_idempotency_key": auth["operation_id"] + ":result",
        "result_message": result_message,
        "state_patch": {
            "status": "completed",
            "completed_at": completed_at.isoformat(),
            "interface_call_id": auth["interface_call_id"],
            "fresh_record_count": len(records),
            "pool_written_count": pool_written,
            "pushed_lead_count": pushed_leads,
            "batch_id": batch_id,
            "push_message_ids": sent_ids,
        },
    }


def fail(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {"chat_id", "current_state", "operation_id", "stage", "error_code", "failed_at"}:
        raise PostConfirmationError("fail input has unsupported fields")
    chat_id = text(payload.get("chat_id"), "chat_id")
    state, binding, _ = active_context(payload.get("current_state"), chat_id)
    flow = obj(state.get("post_confirmation"), "current_state.post_confirmation")
    operation_id = text(payload.get("operation_id"), "operation_id")
    if flow.get("operation_id") != operation_id or flow.get("status") == "completed":
        raise PostConfirmationError("Failure targets another or already completed operation")
    stage = text(payload.get("stage"), "stage")
    if stage not in FAILURE_STAGES:
        raise PostConfirmationError("Failure stage is unsupported")
    code = text(payload.get("error_code"), "error_code")
    if not re.fullmatch(r"[A-Z0-9_]{3,64}", code):
        raise PostConfirmationError("error_code must be a sanitized uppercase code")
    failed_at = instant(payload.get("failed_at"), "failed_at")
    status = "unknown" if stage == "card_send" else "failed"
    company = text(binding.get("company_name"), "binding.company_name")
    return {
        "status": status,
        "chat_id": chat_id,
        "operation_id": operation_id,
        "result_notice_idempotency_key": operation_id + ":result",
        "result_message": (
            f"{company}的正式企业画像已生成，但本次买家线索匹配推送未完成"
            f"（阶段：{stage}，错误码：{code}）。系统未使用旧线索替代，请管理员处理后从当前阶段恢复。"
        ),
        "state_patch": {"status": status, "failed_stage": stage, "error_code": code, "failed_at": failed_at.isoformat()},
    }


def fixture_state() -> dict[str, Any]:
    formalization_id = "sha256:formalize-a"
    return {
        "schema_version": 10,
        "revision": 9,
        "status": "active",
        "chat_id": "oc_a",
        "binding": {
            "chat_id": "oc_a", "company_name": "真实企业", "knowledge_doc_token": "docx-formal",
            "base_app_token": "base-a",
        },
        "profile": {"source_chat_id": "oc_a", "source_doc_token": "docx-formal", "status": "active", "normalized_hash": "sha256:profile-a"},
        "onboarding": {
            "status": "completed", "formalization_status": "completed", "formalization_id": formalization_id,
            "confirmation": {"message_or_action_id": "om-confirm", "draft_version": 2, "draft_hash": "sha256:draft-a"},
        },
    }


def self_test() -> None:
    state = fixture_state()
    confirmation = {
        "chat_id": "oc_a", "state_revision": 8, "decision": "formalize", "actor_open_id": "ou_admin",
        "message_or_action_id": "om-confirm", "draft_version": 2, "draft_hash": "sha256:draft-a",
        "formalization_id": "sha256:formalize-a",
    }
    started = start(
        {
            "chat_id": "oc_a", "current_state": state, "confirmation_result": confirmation,
            "started_at": "2026-08-12T10:00:00+08:00",
            "formal_document_url": "https://tenant.feishu.cn/docx/docx-formal",
            "base_url": "https://tenant.feishu.cn/base/base-a",
        }
    )
    state["post_confirmation"] = started["state_patch"]
    state["post_confirmation"]["status"] = "progress_notified"
    state["post_confirmation"]["progress_message_id"] = "om-progress"
    state["revision"] = 10
    auth = authorize({"chat_id": "oc_a", "current_state": state, "operation_id": started["operation_id"], "run_at": "2026-08-12T10:00:10+08:00"})
    assert auth["fresh_interface_call_required"] is True
    resumed = start(
        {
            "chat_id": "oc_a", "current_state": state, "confirmation_result": confirmation,
            "started_at": "2026-08-12T10:00:15+08:00",
            "formal_document_url": "https://tenant.feishu.cn/docx/docx-formal",
            "base_url": "https://tenant.feishu.cn/base/base-a",
        }
    )
    assert resumed["status"] == "resume_required" and resumed["rerun_interface"] is False
    completed = complete(
        {
            "authorization": auth,
            "current_state": state,
            "pipeline_result": {
                "chat_id": "oc_a", "profile_hash": "sha256:profile-a", "run_context_id": "sha256:run-a",
                "records": [],
                "post_confirmation_execution": {
                    "operation_id": auth["operation_id"], "formalization_id": auth["formalization_id"],
                    "interface_call_id": auth["interface_call_id"], "fresh_interface_call": True,
                    "pre_confirmation_candidates_reused": False,
                },
            },
            "delivery_result": {
                "chat_id": "oc_a", "run_context_id": "sha256:run-a", "delivery_id": "sha256:delivery-a",
                "record_counts": {"push": 0, "pool_only": 0, "exclude": 0},
            },
            "card_result": None,
            "sent_message_ids": [],
            "completed_at": "2026-08-12T10:01:00+08:00",
        }
    )
    assert completed["state_patch"]["fresh_record_count"] == 0
    assert "暂未发现" in completed["result_message"]
    failed = fail(
        {
            "chat_id": "oc_a", "current_state": state, "operation_id": auth["operation_id"],
            "stage": "retrieval", "error_code": "BUYER_API_TIMEOUT",
            "failed_at": "2026-08-12T10:01:00+08:00",
        }
    )
    assert failed["status"] == "failed" and "未使用旧线索" in failed["result_message"]
    crossed = json.loads(json.dumps(state, ensure_ascii=False))
    crossed["post_confirmation"]["progress_message_id"] = ""
    try:
        authorize({"chat_id": "oc_a", "current_state": crossed, "operation_id": started["operation_id"], "run_at": "2026-08-12T10:00:10+08:00"})
    except PostConfirmationError:
        pass
    else:
        raise AssertionError("Retrieval was authorized without a confirmed progress notice")
    wrong_url_state = fixture_state()
    try:
        start(
            {
                "chat_id": "oc_a", "current_state": wrong_url_state, "confirmation_result": confirmation,
                "started_at": "2026-08-12T10:00:00+08:00",
                "formal_document_url": "https://tenant.feishu.cn/docx/wrong?token=docx-formal",
                "base_url": "https://tenant.feishu.cn/base/base-a",
            }
        )
    except PostConfirmationError:
        pass
    else:
        raise AssertionError("A formal document URL with a wrong path was accepted")
    print("post_confirmation_flow self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("start", "authorize", "complete", "fail", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        payload = json.load(sys.stdin)
        result = {"start": start, "authorize": authorize, "complete": complete, "fail": fail}[args.command](payload)
    except (PostConfirmationError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
