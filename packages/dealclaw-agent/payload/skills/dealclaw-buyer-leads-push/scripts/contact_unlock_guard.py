#!/usr/bin/env python3
"""Authorize buyer-contact unlocks only from explicit same-group unlock actions.

This guard is the single release point for buyer contact data. A contact
release requires one of two explicit actions inside the originating group:

1. ``base_field`` — the bound ``买家线索`` record's ``是否解锁`` field was set
   to ``已解锁`` by a member of the same group.
2. ``group_command`` — a same-group member sent ``解锁线索 <线索ID>``.

The guard enforces tenant isolation (the Base record must carry the same
``飞书群ID``), actor presence, exact lead-ID equality, and per-lead
idempotency through the durable ``unlocks`` state map. It never sees, emits,
or stores contact values themselves.

When TradeChina ships a server-side unlock API (quota deduction and a real
``unlockStatus`` transition), insert that call between this guard's
``authorize`` output and the ``buyer-detail`` retrieval. The client-side
authorization contract stays unchanged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from typing import Any


VALID_TRIGGERS = {"base_field", "group_command"}
UNLOCK_FIELD_VALUE = "已解锁"
ACTIVE_UNLOCK_STATUSES = {"pending_push", "contact_pushed"}
UNLOCK_ID_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


class UnlockGuardError(RuntimeError):
    """Raised when an unlock request cannot be authorized safely."""


def require_text(value: Any, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise UnlockGuardError(f"{field} must be a non-empty string")
    return result


def require_timestamp(value: Any, field: str) -> str:
    text = require_text(value, field)
    candidate = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise UnlockGuardError(f"{field} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise UnlockGuardError(f"{field} must include a timezone offset")
    return text


def build_unlock_id(chat_id: str, lead_id: str, actor_open_id: str,
                    requested_at: str, trigger: str) -> str:
    material = "\n".join([chat_id, lead_id, actor_open_id, requested_at, trigger])
    return "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def authorize(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise UnlockGuardError("input must be an object")
    allowed = {"chat_id", "lead_id", "actor_open_id", "trigger",
               "requested_at", "base_record", "existing_unlocks"}
    unknown = set(payload) - allowed
    if unknown:
        raise UnlockGuardError(f"unexpected input keys: {sorted(unknown)}")

    chat_id = require_text(payload.get("chat_id"), "chat_id")
    lead_id = require_text(payload.get("lead_id"), "lead_id")
    actor = require_text(payload.get("actor_open_id"), "actor_open_id")
    trigger = require_text(payload.get("trigger"), "trigger")
    if trigger not in VALID_TRIGGERS:
        raise UnlockGuardError("trigger must be base_field or group_command")
    requested_at = require_timestamp(payload.get("requested_at"), "requested_at")

    if trigger == "base_field":
        record = payload.get("base_record")
        if not isinstance(record, dict):
            raise UnlockGuardError("base_field trigger requires the live base_record")
        record_chat = require_text(record.get("飞书群ID"), "base_record.飞书群ID")
        if record_chat != chat_id:
            raise UnlockGuardError("base_record belongs to a different group")
        record_lead = require_text(record.get("线索ID"), "base_record.线索ID")
        if record_lead != lead_id:
            raise UnlockGuardError("base_record 线索ID does not match the requested lead")
        flag = record.get("是否解锁")
        if flag != UNLOCK_FIELD_VALUE:
            raise UnlockGuardError(
                "base_record 是否解锁 must be exactly 已解锁 to authorize a contact release")
    else:
        if payload.get("base_record") is not None:
            raise UnlockGuardError("group_command trigger must not carry a base_record")

    existing = payload.get("existing_unlocks")
    if existing is None:
        existing = {}
    if not isinstance(existing, dict):
        raise UnlockGuardError("existing_unlocks must be an object keyed by 线索ID")
    prior = existing.get(lead_id)
    if isinstance(prior, dict) and prior.get("status") in ACTIVE_UNLOCK_STATUSES:
        raise UnlockGuardError(
            f"lead {lead_id} was already unlocked (status={prior.get('status')}, "
            f"message_id={prior.get('push_message_id', '')}); refusing a duplicate release")

    unlock_id = build_unlock_id(chat_id, lead_id, actor, requested_at, trigger)
    return {
        "unlock_authorized": True,
        "unlock_id": unlock_id,
        "idempotency_key": unlock_id,
        "chat_id": chat_id,
        "lead_id": lead_id,
        "actor_open_id": actor,
        "trigger": trigger,
        "requested_at": requested_at,
    }


def sweep(payload: Any) -> dict[str, Any]:
    """Select unlock-eligible Base records for the scheduled polling sweep.

    The host reads the bound ``买家线索`` table and passes a raw record
    projection; this function deterministically keeps only records that are
    same-group, marked ``已解锁``, not yet released (empty ``解锁推送消息ID``),
    absent from active ``state.unlocks`` entries, and carrying an actor. Each
    survivor is returned as an authorize-ready ``base_field`` request. It
    never authorizes anything by itself and never sees contact values.
    """
    if not isinstance(payload, dict):
        raise UnlockGuardError("input must be an object")
    allowed = {"chat_id", "requested_at", "records", "existing_unlocks", "actor_fallback"}
    unknown = set(payload) - allowed
    if unknown:
        raise UnlockGuardError(f"unexpected input keys: {sorted(unknown)}")

    chat_id = require_text(payload.get("chat_id"), "chat_id")
    requested_at = require_timestamp(payload.get("requested_at"), "requested_at")
    records = payload.get("records")
    if not isinstance(records, list):
        raise UnlockGuardError("records must be an array")
    existing = payload.get("existing_unlocks")
    if existing is None:
        existing = {}
    if not isinstance(existing, dict):
        raise UnlockGuardError("existing_unlocks must be an object keyed by 线索ID")
    actor_fallback = payload.get("actor_fallback")
    if actor_fallback is not None:
        actor_fallback = require_text(actor_fallback, "actor_fallback")

    candidates: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    seen: set[str] = set()

    def skip(lead_id: str, reason: str) -> None:
        skipped.append({"线索ID": lead_id, "reason": reason})

    for record in records:
        if not isinstance(record, dict):
            skip("", "record_not_object")
            continue
        lead_id = record.get("线索ID")
        lead_id = lead_id.strip() if isinstance(lead_id, str) else ""
        if not lead_id:
            skip("", "missing_lead_id")
            continue
        if lead_id in seen:
            skip(lead_id, "duplicate_in_input")
            continue
        seen.add(lead_id)
        record_chat = record.get("飞书群ID")
        if record_chat != chat_id:
            skip(lead_id, "cross_group")
            continue
        if record.get("是否解锁") != UNLOCK_FIELD_VALUE:
            skip(lead_id, "not_marked_unlocked")
            continue
        pushed_id = record.get("解锁推送消息ID")
        if isinstance(pushed_id, str) and pushed_id.strip():
            skip(lead_id, "already_released_in_base")
            continue
        prior = existing.get(lead_id)
        if isinstance(prior, dict) and prior.get("status") in ACTIVE_UNLOCK_STATUSES:
            skip(lead_id, "already_unlocked_in_state")
            continue
        actor = record.get("修改人")
        actor = actor.strip() if isinstance(actor, str) else ""
        actor = actor or (actor_fallback or "")
        if not actor:
            skip(lead_id, "missing_actor")
            continue
        candidates.append({
            "chat_id": chat_id,
            "lead_id": lead_id,
            "actor_open_id": actor,
            "trigger": "base_field",
            "requested_at": requested_at,
            "base_record": {
                "线索ID": lead_id,
                "飞书群ID": chat_id,
                "是否解锁": UNLOCK_FIELD_VALUE,
            },
        })
    return {
        "chat_id": chat_id,
        "requested_at": requested_at,
        "candidate_count": len(candidates),
        "candidates": candidates,
        "skipped": skipped,
    }


def complete(payload: Any) -> dict[str, Any]:
    """Build the durable state patch after a determinate contact-card send."""
    if not isinstance(payload, dict):
        raise UnlockGuardError("input must be an object")
    unlock = payload.get("unlock")
    if not isinstance(unlock, dict) or unlock.get("unlock_authorized") is not True:
        raise UnlockGuardError("complete requires the authorize output")
    unlock_id = require_text(unlock.get("unlock_id"), "unlock.unlock_id")
    if not UNLOCK_ID_PATTERN.fullmatch(unlock_id):
        raise UnlockGuardError("unlock.unlock_id has an invalid format")
    lead_id = require_text(unlock.get("lead_id"), "unlock.lead_id")
    chat_id = require_text(unlock.get("chat_id"), "unlock.chat_id")
    actor = require_text(unlock.get("actor_open_id"), "unlock.actor_open_id")
    trigger = require_text(unlock.get("trigger"), "unlock.trigger")
    if trigger not in VALID_TRIGGERS:
        raise UnlockGuardError("unlock.trigger is invalid")
    requested_at = require_timestamp(unlock.get("requested_at"), "unlock.requested_at")

    status = require_text(payload.get("status"), "status")
    if status not in {"contact_pushed", "unknown"}:
        raise UnlockGuardError("status must be contact_pushed or unknown")
    message_id = payload.get("push_message_id")
    if status == "contact_pushed":
        message_id = require_text(message_id, "push_message_id")
    elif message_id is not None and not isinstance(message_id, str):
        raise UnlockGuardError("push_message_id must be a string when present")
    completed_at = require_timestamp(payload.get("completed_at"), "completed_at")

    return {
        "unlocks_patch": {
            lead_id: {
                "unlock_id": unlock_id,
                "chat_id": chat_id,
                "actor_open_id": actor,
                "trigger": trigger,
                "requested_at": requested_at,
                "status": status,
                "push_message_id": message_id or "",
                "completed_at": completed_at,
            }
        }
    }


def fixture() -> dict[str, Any]:
    return {
        "chat_id": "oc_a",
        "lead_id": "2077311290711822337",
        "actor_open_id": "ou_member",
        "trigger": "base_field",
        "requested_at": "2026-08-12T22:00:00+08:00",
        "base_record": {
            "线索ID": "2077311290711822337",
            "飞书群ID": "oc_a",
            "是否解锁": "已解锁",
        },
        "existing_unlocks": {},
    }


def self_test() -> None:
    ok = authorize(fixture())
    assert ok["unlock_authorized"] is True
    assert UNLOCK_ID_PATTERN.fullmatch(ok["unlock_id"])
    assert ok["idempotency_key"] == ok["unlock_id"]

    command = fixture()
    command["trigger"] = "group_command"
    command.pop("base_record")
    assert authorize(command)["unlock_id"] != ok["unlock_id"]

    repeat = authorize(fixture())
    assert repeat["unlock_id"] == ok["unlock_id"], "same action must be deterministic"

    patch = complete({
        "unlock": ok,
        "status": "contact_pushed",
        "push_message_id": "om_contact_1",
        "completed_at": "2026-08-12T22:01:00+08:00",
    })
    entry = patch["unlocks_patch"]["2077311290711822337"]
    assert entry["status"] == "contact_pushed"
    assert entry["push_message_id"] == "om_contact_1"

    bad = []
    cross_group = fixture()
    cross_group["base_record"]["飞书群ID"] = "oc_b"
    bad.append(cross_group)
    not_unlocked = fixture()
    not_unlocked["base_record"]["是否解锁"] = "未解锁"
    bad.append(not_unlocked)
    wrong_lead = fixture()
    wrong_lead["base_record"]["线索ID"] = "other-lead"
    bad.append(wrong_lead)
    duplicate = fixture()
    duplicate["existing_unlocks"] = {
        "2077311290711822337": {"status": "contact_pushed", "push_message_id": "om_old"}
    }
    bad.append(duplicate)
    bad_trigger = fixture()
    bad_trigger["trigger"] = "model_decision"
    bad.append(bad_trigger)
    command_with_record = fixture()
    command_with_record["trigger"] = "group_command"
    bad.append(command_with_record)
    for item in bad:
        try:
            authorize(item)
        except UnlockGuardError:
            pass
        else:
            raise AssertionError("unsafe unlock request was not rejected")

    bad_complete = {"unlock": ok, "status": "contact_pushed",
                    "completed_at": "2026-08-12T22:01:00+08:00"}
    try:
        complete(bad_complete)
    except UnlockGuardError:
        pass
    else:
        raise AssertionError("contact_pushed without message id was not rejected")

    sweep_input = {
        "chat_id": "oc_a",
        "requested_at": "2026-08-13T10:00:00+08:00",
        "actor_fallback": "ou_admin",
        "existing_unlocks": {"L5": {"status": "contact_pushed"}},
        "records": [
            {"线索ID": "L1", "飞书群ID": "oc_a", "是否解锁": "已解锁", "修改人": "ou_user1"},
            {"线索ID": "L2", "飞书群ID": "oc_a", "是否解锁": "已解锁"},  # fallback actor
            {"线索ID": "L3", "飞书群ID": "oc_b", "是否解锁": "已解锁", "修改人": "ou_x"},
            {"线索ID": "L4", "飞书群ID": "oc_a", "是否解锁": "未解锁", "修改人": "ou_x"},
            {"线索ID": "L5", "飞书群ID": "oc_a", "是否解锁": "已解锁", "修改人": "ou_x"},
            {"线索ID": "L6", "飞书群ID": "oc_a", "是否解锁": "已解锁", "解锁推送消息ID": "om_old", "修改人": "ou_x"},
            {"线索ID": "L1", "飞书群ID": "oc_a", "是否解锁": "已解锁", "修改人": "ou_x"},
            {"线索ID": "", "飞书群ID": "oc_a", "是否解锁": "已解锁"},
        ],
    }
    result = sweep(sweep_input)
    assert result["candidate_count"] == 2
    first, second = result["candidates"]
    assert first["lead_id"] == "L1" and first["actor_open_id"] == "ou_user1"
    assert first["trigger"] == "base_field"
    assert first["base_record"] == {"线索ID": "L1", "飞书群ID": "oc_a", "是否解锁": "已解锁"}
    assert second["lead_id"] == "L2" and second["actor_open_id"] == "ou_admin"
    reasons = {item["线索ID"]: item["reason"] for item in result["skipped"]}
    assert reasons["L3"] == "cross_group"
    assert reasons["L4"] == "not_marked_unlocked"
    assert reasons["L5"] == "already_unlocked_in_state"
    assert reasons["L6"] == "already_released_in_base"
    assert reasons["L1"] == "duplicate_in_input"
    assert reasons[""] == "missing_lead_id"
    # every sweep candidate must pass authorize unchanged
    for candidate in result["candidates"]:
        assert authorize(candidate)["unlock_authorized"] is True
    # missing actor without fallback is skipped
    no_actor = sweep({**sweep_input, "actor_fallback": None,
                      "records": [{"线索ID": "L7", "飞书群ID": "oc_a", "是否解锁": "已解锁"}]})
    assert no_actor["candidate_count"] == 0
    assert no_actor["skipped"][0]["reason"] == "missing_actor"
    print("contact_unlock_guard self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("authorize", "complete", "sweep", "self-test"))
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    try:
        payload = json.load(sys.stdin)
        if args.command == "authorize":
            result = authorize(payload)
        elif args.command == "sweep":
            result = sweep(payload)
        else:
            result = complete(payload)
    except (UnlockGuardError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
