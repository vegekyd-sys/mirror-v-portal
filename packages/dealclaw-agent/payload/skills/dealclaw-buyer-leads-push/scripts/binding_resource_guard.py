#!/usr/bin/env python3
"""Fail closed and start a chat-scoped rebind when a bound knowledge Docx is deleted."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import sys
from typing import Any


class BindingResourceError(RuntimeError):
    """Raised when a binding-health event is ambiguous or crosses chat scope."""


SCHEMA_VERSION = 10
DELETED_RESULTS = {"deleted", "not_found"}
DELETED_ERROR_CODES = {
    "RESOURCE_DELETED",
    "RESOURCE_NOT_FOUND",
    "TOKEN_NOT_FOUND",
    "DOCX_NOT_FOUND",
}
STOP_RESULTS = {"permission_denied", "type_mismatch", "transient_error"}
ALL_RESULTS = {"accessible"} | DELETED_RESULTS | STOP_RESULTS
REMINDER_TEXT = (
    "当前群绑定的企业知识库已被删除或无法通过原 token 找到，AI猎客已暂停。\n"
    "请由本群管理员发送新的企业知识库飞书文档链接并回复“重新绑定企业知识库”；"
    "如果群内没有现成文档，系统将只根据本群历史消息重新生成企业画像草稿，待确认后完成绑定。\n"
    "原AI猎客商机池和本群历史反馈将保留；重新绑定完成前不会查询或推送买家线索。"
)


def text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise BindingResourceError(f"{field} must be a non-empty string")
    return result


def obj(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BindingResourceError(f"{field} must be an object")
    return value


def integer(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise BindingResourceError(f"{field} must be an integer")
    return value


def instant(value: Any, field: str) -> str:
    raw = text(value, field)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BindingResourceError(f"{field} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise BindingResourceError(f"{field} must include a timezone offset")
    return parsed.isoformat()


def fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]


def core_state(payload: dict[str, Any]) -> tuple[str, int, dict[str, Any], dict[str, Any]]:
    chat_id = text(payload.get("invocation_chat_id"), "invocation_chat_id")
    state = obj(payload.get("state"), "state")
    if integer(state.get("schema_version"), "state.schema_version") != SCHEMA_VERSION:
        raise BindingResourceError("state.schema_version must be 10")
    revision = integer(state.get("revision"), "state.revision")
    if revision < 1:
        raise BindingResourceError("state.revision must be positive")
    if text(state.get("chat_id"), "state.chat_id") != chat_id:
        raise BindingResourceError("State crosses the invocation chat_id boundary")
    binding = obj(state.get("binding"), "state.binding")
    if text(binding.get("chat_id"), "binding.chat_id") != chat_id:
        raise BindingResourceError("Binding crosses the invocation chat_id boundary")
    text(binding.get("company_name"), "binding.company_name")
    text(binding.get("knowledge_doc_token"), "binding.knowledge_doc_token")
    return chat_id, revision, state, binding


def evaluate(payload: Any) -> dict[str, Any]:
    payload = obj(payload, "input")
    if set(payload) != {"invocation_chat_id", "checked_at", "state", "knowledge_document_read"}:
        raise BindingResourceError(
            "input must contain only invocation_chat_id, checked_at, state, and knowledge_document_read"
        )
    chat_id, revision, state, binding = core_state(payload)
    checked_at = instant(payload.get("checked_at"), "checked_at")
    read = obj(payload.get("knowledge_document_read"), "knowledge_document_read")
    if set(read) - {"token", "result", "http_status", "error_code"}:
        raise BindingResourceError("knowledge_document_read contains unsupported fields")
    token = text(read.get("token"), "knowledge_document_read.token")
    if token != binding["knowledge_doc_token"]:
        raise BindingResourceError("The checked token is not the bound knowledge_doc_token")
    result = text(read.get("result"), "knowledge_document_read.result")
    if result not in ALL_RESULTS:
        raise BindingResourceError("knowledge_document_read.result is unsupported")

    http_status = read.get("http_status")
    if http_status is not None and (not isinstance(http_status, int) or isinstance(http_status, bool)):
        raise BindingResourceError("knowledge_document_read.http_status must be an integer")
    error_code = read.get("error_code", "")
    if not isinstance(error_code, str):
        raise BindingResourceError("knowledge_document_read.error_code must be a string")
    error_code = error_code.strip().upper()

    if result == "accessible":
        if state.get("status") == "rebind_required":
            raise BindingResourceError("An accessible read cannot silently clear rebind_required")
        return {"chat_id": chat_id, "action": "continue", "expected_revision": revision}

    if result in STOP_RESULTS:
        return {
            "chat_id": chat_id,
            "action": "stop_without_rebind",
            "reason": result,
            "expected_revision": revision,
        }

    if http_status != 404 and error_code not in DELETED_ERROR_CODES:
        raise BindingResourceError(
            "A deleted/not_found result requires HTTP 404 or a recognized deletion error code"
        )

    token_fingerprint = fingerprint(token)
    recovery = state.get("binding_recovery")
    if state.get("status") == "rebind_required":
        recovery = obj(recovery, "state.binding_recovery")
        if recovery.get("reason") != "knowledge_document_deleted":
            raise BindingResourceError("Existing rebind_required state has a different reason")
        if recovery.get("failed_token_fingerprint") != token_fingerprint:
            raise BindingResourceError("Existing rebind state refers to another document token")
        reminder_status = recovery.get("reminder_status")
        if reminder_status == "sent":
            return {
                "chat_id": chat_id,
                "action": "wait_for_explicit_rebind",
                "expected_revision": revision,
                "reminder": None,
            }
        if reminder_status != "pending":
            raise BindingResourceError("binding_recovery.reminder_status is unsupported")
        return {
            "chat_id": chat_id,
            "action": "send_rebind_reminder",
            "expected_revision": revision,
            "reminder": REMINDER_TEXT,
        }

    if state.get("status") != "active":
        raise BindingResourceError("Only an active binding can transition to rebind_required")
    return {
        "chat_id": chat_id,
        "action": "persist_rebind_required_then_send_reminder",
        "expected_revision": revision,
        "state_patch": {
            "status": "rebind_required",
            "binding_recovery": {
                "reason": "knowledge_document_deleted",
                "failed_token_fingerprint": token_fingerprint,
                "detected_at": checked_at,
                "reminder_status": "pending",
                "reminder_message_id": None,
                "reminded_at": None,
            },
        },
        "reminder": REMINDER_TEXT,
    }


def complete_reminder(payload: Any) -> dict[str, Any]:
    payload = obj(payload, "input")
    if set(payload) != {"invocation_chat_id", "completed_at", "message_id", "state"}:
        raise BindingResourceError(
            "input must contain only invocation_chat_id, completed_at, message_id, and state"
        )
    chat_id, revision, state, _ = core_state(payload)
    if state.get("status") != "rebind_required":
        raise BindingResourceError("State is not rebind_required")
    recovery = obj(state.get("binding_recovery"), "state.binding_recovery")
    if recovery.get("reason") != "knowledge_document_deleted":
        raise BindingResourceError("binding_recovery reason is unsupported")
    if recovery.get("reminder_status") != "pending":
        raise BindingResourceError("The rebind reminder is not pending")
    return {
        "chat_id": chat_id,
        "action": "persist_reminder_completion",
        "expected_revision": revision,
        "state_patch": {
            "binding_recovery": {
                **recovery,
                "reminder_status": "sent",
                "reminder_message_id": text(payload.get("message_id"), "message_id"),
                "reminded_at": instant(payload.get("completed_at"), "completed_at"),
            }
        },
    }


def fixture(result: str = "deleted") -> dict[str, Any]:
    return {
        "invocation_chat_id": "oc_a",
        "checked_at": "2026-08-13T10:00:00+08:00",
        "knowledge_document_read": {
            "token": "docx_formal_a",
            "result": result,
            "http_status": 404 if result in DELETED_RESULTS else 200,
            "error_code": "RESOURCE_DELETED" if result in DELETED_RESULTS else "",
        },
        "state": {
            "schema_version": 10,
            "revision": 8,
            "status": "active",
            "chat_id": "oc_a",
            "binding": {
                "chat_id": "oc_a",
                "company_name": "真实企业",
                "knowledge_doc_token": "docx_formal_a",
            },
        },
    }


def self_test() -> None:
    first = evaluate(fixture())
    assert first["action"] == "persist_rebind_required_then_send_reminder"
    assert first["state_patch"]["status"] == "rebind_required"
    assert "docx_formal_a" not in json.dumps(first, ensure_ascii=False)

    pending = fixture()
    pending["state"].update(first["state_patch"])
    pending["state"]["revision"] = 9
    again = evaluate(pending)
    assert again["action"] == "send_rebind_reminder"

    completion = complete_reminder(
        {
            "invocation_chat_id": "oc_a",
            "completed_at": "2026-08-13T10:00:05+08:00",
            "message_id": "om_rebind_1",
            "state": pending["state"],
        }
    )
    pending["state"]["binding_recovery"] = completion["state_patch"]["binding_recovery"]
    pending["state"]["revision"] = 10
    suppressed = evaluate(pending)
    assert suppressed["action"] == "wait_for_explicit_rebind"
    assert suppressed["reminder"] is None

    denied = evaluate(fixture("permission_denied"))
    assert denied["action"] == "stop_without_rebind"

    unproven = fixture()
    unproven["knowledge_document_read"]["http_status"] = 200
    unproven["knowledge_document_read"]["error_code"] = ""
    try:
        evaluate(unproven)
    except BindingResourceError:
        pass
    else:
        raise AssertionError("An unproven deletion result entered the rebind path")

    crossed = fixture()
    crossed["invocation_chat_id"] = "oc_b"
    try:
        evaluate(crossed)
    except BindingResourceError:
        pass
    else:
        raise AssertionError("Cross-group deletion event was accepted")
    print("binding_resource_guard self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("evaluate", "complete-reminder", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        payload = json.load(sys.stdin)
        result = evaluate(payload) if args.command == "evaluate" else complete_reminder(payload)
    except (BindingResourceError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
