#!/usr/bin/env python3
"""Diagnose and repair Feishu Docx/Base chat-isolated permissions.

Implements the sequence required by references/resource-access-policy.md:
close external/link access -> grant the exact openchat group `edit` ->
grant the DealClaw application `full_access` -> prune unexpected
collaborators -> live readback.

Subcommands:
  diagnose  Read live state and report why group members cannot access.
  repair    Execute the full grant sequence (supports --dry-run).
  snapshot  Emit a resource_permission_guard.py-compatible JSON snapshot.
  authorize-created  Authorize a just-created resource with its creator's
                     user_access_token and return a validated v3 proof.
  self-test Validate the current Feishu endpoint and authorization contract.

Credentials (choose one):
  --app-id + --app-secret   tenant_access_token (bot must be in the chat)
  --user-token              user_access_token of an owner/full-access user
Environment fallbacks: FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_USER_TOKEN,
FEISHU_BASE_URL (default https://open.feishu.cn).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

import resource_permission_guard

DEFAULT_BASE_URL = "https://open.feishu.cn"


class FeishuError(RuntimeError):
    """Feishu OpenAPI returned a non-zero code or HTTP error."""


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


class FeishuClient:
    def __init__(self, base_url: str, app_id: str = "", app_secret: str = "",
                 user_token: str = "") -> None:
        self.base_url = base_url.rstrip("/")
        self.app_id = app_id
        self.app_secret = app_secret
        self.user_token = user_token
        self._tenant_token = ""

    @property
    def credential_type(self) -> str:
        return "user_access_token" if self.user_token else "tenant_access_token"

    def _token(self) -> str:
        if self.user_token:
            return self.user_token
        if not self._tenant_token:
            if not self.app_id or not self.app_secret:
                raise FeishuError("missing app credentials: set --app-id/--app-secret or --user-token")
            data = self._raw("POST", "/open-apis/auth/v3/tenant_access_token/internal",
                             {"app_id": self.app_id, "app_secret": self.app_secret}, auth=False)
            if data.get("code") != 0:
                raise FeishuError(f"tenant_access_token failed: {data.get('code')} {data.get('msg')}")
            self._tenant_token = data["tenant_access_token"]
        return self._tenant_token

    def _raw(self, method: str, path: str, body: Any = None, auth: bool = True,
             query: dict[str, str] | None = None) -> dict[str, Any]:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=payload, method=method)
        req.add_header("Content-Type", "application/json; charset=utf-8")
        if auth:
            req.add_header("Authorization", f"Bearer {self._token()}")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise FeishuError(f"HTTP {exc.code} on {method} {path}: {detail}") from exc

    def call(self, method: str, path: str, body: Any = None,
             query: dict[str, str] | None = None, check: bool = True) -> dict[str, Any]:
        data = self._raw(method, path, body, query=query)
        if check and data.get("code") != 0:
            raise FeishuError(f"{method} {path} -> code={data.get('code')} msg={data.get('msg')}")
        return data

    # ---- permission APIs -------------------------------------------------
    def get_public(self, token: str, rtype: str) -> dict[str, Any]:
        data = self.call("GET", f"/open-apis/drive/v2/permissions/{token}/public",
                         query={"type": rtype})
        public = data.get("data", {}).get("permission_public")
        if not isinstance(public, dict):
            raise FeishuError("v2 public-permission response is missing data.permission_public")
        return public

    def update_public(self, token: str, rtype: str, settings: dict[str, Any]) -> None:
        self.call("PATCH", f"/open-apis/drive/v2/permissions/{token}/public",
                  settings, query={"type": rtype})

    def list_members(self, token: str, rtype: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page_token = ""
        while True:
            query = {"type": rtype, "fields": "*", "perm_type": "container"}
            if page_token:
                query["page_token"] = page_token
            data = self.call("GET", f"/open-apis/drive/v1/permissions/{token}/members",
                             query=query)
            d = data["data"]
            items.extend(d.get("items", []))
            if not d.get("has_more"):
                break
            page_token = d.get("page_token", "")
        return items

    def add_member(self, token: str, rtype: str, member_type: str, member_id: str,
                   perm: str, member_kind: str) -> dict[str, Any]:
        body = {"member_type": member_type, "member_id": member_id,
                "perm": perm, "perm_type": "container", "type": member_kind}
        return self.call("POST", f"/open-apis/drive/v1/permissions/{token}/members",
                         body, query={"type": rtype, "need_notification": "false"})

    def update_member(self, token: str, rtype: str, member_id: str, member_type: str,
                      perm: str, member_kind: str) -> None:
        body = {"member_type": member_type, "perm": perm,
                "perm_type": "container", "type": member_kind}
        self.call("PUT", f"/open-apis/drive/v1/permissions/{token}/members/{member_id}",
                  body, query={"type": rtype, "need_notification": "false"})

    def delete_member(self, token: str, rtype: str, member_id: str, member_type: str,
                      member_kind: str) -> None:
        body = {"member_type": member_type, "type": member_kind}
        self.call("DELETE", f"/open-apis/drive/v1/permissions/{token}/members/{member_id}",
                  body, query={"type": rtype})

    # ---- chat APIs --------------------------------------------------------
    def actor_openid(self) -> str:
        """Resolve the real caller from the access token, never from CLI assertions."""
        if self.credential_type == "user_access_token":
            data = self.call("GET", "/open-apis/authen/v1/user_info")
            actor = data.get("data", {}).get("open_id", "")
        else:
            data = self.call("GET", "/open-apis/bot/v3/info")
            actor = data.get("bot", {}).get("open_id", "")
        if not isinstance(actor, str) or not actor.strip():
            raise FeishuError("cannot resolve the authenticated permission actor OpenID")
        return actor.strip()

    def actor_in_chat(self, chat_id: str) -> tuple[bool, str]:
        """Use Feishu's explicit is_in_chat result for the current access token."""
        try:
            data = self.call(
                "GET", f"/open-apis/im/v1/chats/{chat_id}/members/is_in_chat",
                check=False,
            )
        except FeishuError as exc:
            return False, str(exc)
        if data.get("code") == 0 and data.get("data", {}).get("is_in_chat") is True:
            return True, "authenticated actor is in the target chat"
        if data.get("code") == 0:
            return False, "authenticated actor is not in the target chat"
        return False, f"code={data.get('code')} msg={data.get('msg')}"


CLOSED_PUBLIC = {
    "external_access_entity": "closed",
    "link_share_entity": "closed",
    "manage_collaborator_entity": "collaborator_full_access",
    "security_entity": "only_full_access",
}


def normalize_public(data: dict[str, Any]) -> dict[str, Any]:
    return {k: data.get(k, "") for k in CLOSED_PUBLIC}


def normalize_members(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for it in items:
        out.append({
            "member_type": it.get("member_type", ""),
            "member_id": it.get("member_id", ""),
            "perm": it.get("perm", ""),
            "type": it.get("type", ""),
            "owner": bool(it.get("is_owner") or it.get("owner")),
            "name": it.get("name", ""),
        })
    return out


def diagnose(client: FeishuClient, token: str, rtype: str, chat_id: str,
             dealclaw_openid: str) -> dict[str, Any]:
    findings: list[dict[str, str]] = []
    report: dict[str, Any] = {"resource_token": token, "resource_type": rtype,
                              "chat_id": chat_id, "findings": findings}

    in_chat, detail = client.actor_in_chat(chat_id)
    report["permission_actor_in_chat"] = in_chat
    if not in_chat:
        findings.append({
            "cause": "PERMISSION_ACTOR_NOT_IN_CHAT",
            "severity": "blocker",
            "detail": f"the authenticated user/app is not in the target chat ({detail}); "
                      f"Feishu requires the permission actor to be a group member before an "
                      f"openchat grant. Add the actor to the group, then rerun repair.",
        })

    try:
        public = normalize_public(client.get_public(token, rtype))
    except FeishuError as exc:
        findings.append({"cause": "CANNOT_READ_RESOURCE", "severity": "blocker",
                         "detail": f"cannot read public permissions: {exc}. The credential is "
                                   f"not an owner/full-access collaborator (ownership handoff broken)."})
        report["verdict"] = "blocked"
        return report
    report["public_permission"] = public
    for key, want in CLOSED_PUBLIC.items():
        if public.get(key) != want:
            findings.append({"cause": "PUBLIC_SETTING_DRIFT", "severity": "warning",
                             "detail": f"{key} is '{public.get(key)}', expected '{want}'."})

    try:
        members = normalize_members(client.list_members(token, rtype))
    except FeishuError as exc:
        findings.append({"cause": "CANNOT_LIST_COLLABORATORS", "severity": "blocker",
                         "detail": f"cannot list collaborators: {exc}"})
        report["verdict"] = "blocked"
        return report
    report["collaborators"] = members

    group_grants = [m for m in members
                    if m["member_type"] == "openchat" and m["member_id"] == chat_id]
    if not group_grants:
        other = [m for m in members if m["member_type"] == "openchat"]
        detail = "no openchat collaborator for the bound chat."
        if other:
            detail += f" Found openchat grant(s) for other chat(s): {[m['member_id'] for m in other]}."
        findings.append({
            "cause": "MISSING_GROUP_GRANT", "severity": "blocker",
            "detail": detail + " This is why group members cannot open the document. "
                               "Fix: run repair to add member_type=openchat, perm=edit, type=chat.",
        })
    else:
        for g in group_grants:
            if g["perm"] != "edit":
                findings.append({"cause": "GROUP_GRANT_NOT_EDIT", "severity": "blocker",
                                 "detail": f"openchat grant exists but perm='{g['perm']}', expected 'edit'."})
    if len(group_grants) > 1:
        findings.append({"cause": "DUPLICATE_GROUP_GRANT", "severity": "warning",
                         "detail": "multiple openchat grants for the same chat."})

    if dealclaw_openid:
        dc = [m for m in members if m["member_id"] == dealclaw_openid]
        if not dc:
            findings.append({"cause": "DEALCLAW_NOT_COLLABORATOR", "severity": "blocker",
                             "detail": "DealClaw principal is not a collaborator; it cannot manage "
                                       "or repair this resource. Owner action is required."})
        elif dc[0]["perm"] != "full_access" and not dc[0]["owner"]:
            findings.append({"cause": "DEALCLAW_NOT_FULL_ACCESS", "severity": "blocker",
                             "detail": f"DealClaw principal perm='{dc[0]['perm']}', expected full_access."})

    owners = [m for m in members if m["owner"]]
    report["owners"] = owners
    if not owners:
        findings.append({"cause": "OWNER_NOT_VISIBLE", "severity": "warning",
                         "detail": "owner not visible in collaborator list; verify the actor identity."})

    blocker = any(f["severity"] == "blocker" for f in findings)
    report["verdict"] = "blocked" if blocker else (
        "ok" if not findings else "needs_repair")
    return report


def repair(client: FeishuClient, token: str, rtype: str, chat_id: str,
           dealclaw_openid: str, prune: bool, dry_run: bool,
           keep_openids: list[str]) -> dict[str, Any]:
    if not dealclaw_openid:
        raise FeishuError(
            "dealclaw_openid is required before any permission write; "
            "refusing a partial group-only grant")
    steps: list[dict[str, Any]] = []

    def step(name: str, fn=None, detail: str = "") -> None:
        entry = {"step": name, "dry_run": dry_run, "detail": detail}
        if dry_run or fn is None:
            entry["status"] = "planned" if dry_run else "skipped"
        else:
            try:
                fn()
                entry["status"] = "done"
            except FeishuError as exc:
                entry["status"] = "failed"
                entry["error"] = str(exc)
                steps.append(entry)
                raise
        steps.append(entry)

    in_chat, detail = client.actor_in_chat(chat_id)
    if not in_chat:
        raise FeishuError(
            "permission actor is not in the target chat; openchat grants will fail. "
            f"Add the authenticated user/app to the group first. Detail: {detail}")

    step("close_public_and_link_access",
         lambda: client.update_public(token, rtype, CLOSED_PUBLIC),
         json.dumps(CLOSED_PUBLIC, ensure_ascii=False))

    members = normalize_members(client.list_members(token, rtype))
    existing_group = [m for m in members
                      if m["member_type"] == "openchat" and m["member_id"] == chat_id]
    if existing_group:
        step("upsert_chat_edit",
             lambda: client.update_member(token, rtype, chat_id, "openchat", "edit", "chat"),
             "existing openchat grant -> update to edit")
    else:
        step("upsert_chat_edit",
             lambda: client.add_member(token, rtype, "openchat", chat_id, "edit", "chat"),
             "add openchat edit collaborator")

    if dealclaw_openid:
        existing_dc = [m for m in members if m["member_id"] == dealclaw_openid]
        owner_ids = {m["member_id"] for m in members if m["owner"]}
        if dealclaw_openid in owner_ids:
            step("upsert_dealclaw_full_access", None, "DealClaw is the owner; no grant needed")
        elif existing_dc:
            step("upsert_dealclaw_full_access",
                 lambda: client.update_member(token, rtype, dealclaw_openid, "openid",
                                              "full_access", "user"),
                 "existing DealClaw grant -> update to full_access")
        else:
            step("upsert_dealclaw_full_access",
                 lambda: client.add_member(token, rtype, "openid", dealclaw_openid,
                                           "full_access", "user"),
                 "add DealClaw full_access collaborator")

    if prune:
        keep = set(keep_openids)
        keep.add(dealclaw_openid)
        owner_ids = {m["member_id"] for m in members if m["owner"]}
        keep |= owner_ids

        def do_prune() -> None:
            for m in members:
                if m["member_type"] == "openchat" and m["member_id"] == chat_id:
                    continue
                if m["member_id"] in keep:
                    continue
                client.delete_member(token, rtype, m["member_id"], m["member_type"],
                                     m["type"] or "user")
        step("remove_unexpected_collaborators", do_prune,
             "remove collaborators outside owner/DealClaw/keep-list/bound chat")

    public = normalize_public(client.get_public(token, rtype))
    final_members = normalize_members(client.list_members(token, rtype))
    group_grants = [m for m in final_members if m["member_type"] == "openchat"]
    exact_group = [m for m in group_grants if m["member_id"] == chat_id
                   and m["perm"] == "edit" and m["type"] == "chat"]
    owners = {m["member_id"] for m in final_members if m["owner"]}
    dealclaw_ok = bool(dealclaw_openid) and (
        dealclaw_openid in owners
        or any(m["member_id"] == dealclaw_openid and m["perm"] == "full_access"
               for m in final_members)
    )
    allowed_ids = owners | set(keep_openids) | {dealclaw_openid, chat_id}
    unexpected = [m for m in final_members if m["member_id"] not in allowed_ids]
    ok = (not dry_run and public == CLOSED_PUBLIC and len(group_grants) == 1
          and len(exact_group) == 1 and dealclaw_ok and not unexpected)
    return {"status": "ok" if ok else "incomplete",
            "dry_run": dry_run,
            "steps": steps,
            "final_public_permission": public,
            "final_collaborators": final_members}


def snapshot(client: FeishuClient, token: str, rtype: str, chat_id: str,
             dealclaw_openid: str, context_id: str, observation_id: str,
             allowed_manager_openids: list[str] | None = None) -> dict[str, Any]:
    if not dealclaw_openid:
        raise FeishuError("dealclaw_openid is required for a v3 permission proof")
    public = normalize_public(client.get_public(token, rtype))
    members = client.list_members(token, rtype)
    projected = [{"member_type": m.get("member_type", ""), "member_id": m.get("member_id", ""),
                  "perm": m.get("perm", ""), "type": m.get("type", "")} for m in members]
    owner_id = next((m.get("member_id") for m in members
                     if m.get("is_owner") or m.get("owner")), "")
    if not owner_id:
        raise FeishuError("live collaborator readback does not identify the resource owner")
    actor_id = client.actor_openid()
    actor_member = next((m for m in members if m.get("member_id") == actor_id), None)
    if actor_id == owner_id:
        actor_role = "owner"
    elif actor_member and actor_member.get("perm") == "full_access":
        actor_role = "full_access"
    else:
        raise FeishuError("authenticated permission actor is not owner/full_access in live readback")
    observed = now_iso()
    return {
        "expected_chat_id": chat_id,
        "resource_token": token,
        "resource_type": rtype,
        "observed_at": observed,
        "validation_time": now_iso(),
        "verification_context_id": context_id,
        "observation_id": observation_id,
        "resource_owner": {"member_type": "openid", "member_id": owner_id},
        "permission_actor": {
            "member_type": "openid",
            "member_id": actor_id,
            "credential_type": client.credential_type,
            "resource_role": actor_role,
            "can_manage_collaborators": True,
        },
        "automation_principal": {"member_type": "openid", "member_id": dealclaw_openid},
        "public_permission": public,
        "collaborators": projected,
        "allowed_manager_member_ids": sorted(
            ({owner_id, actor_id, dealclaw_openid} | set(allowed_manager_openids or [])) - {""}),
    }


def authorize_created(client: FeishuClient, token: str, rtype: str, chat_id: str,
                      dealclaw_openid: str, context_id: str,
                      observation_id: str) -> dict[str, Any]:
    """Authorize a user-created resource and fail closed until v3 validates."""
    if client.credential_type != "user_access_token":
        raise FeishuError("authorize-created requires the creator's user_access_token")
    if not dealclaw_openid:
        raise FeishuError("authorize-created requires the configured DealClaw application OpenID")
    actor_id = client.actor_openid()
    in_chat, detail = client.actor_in_chat(chat_id)
    if not in_chat:
        raise FeishuError(f"document creator is not in the target chat: {detail}")
    initial_members = client.list_members(token, rtype)
    owner_id = next((m.get("member_id") for m in initial_members
                     if m.get("is_owner") or m.get("owner")), "")
    if not owner_id:
        raise FeishuError("created resource readback does not identify an owner")
    if owner_id != actor_id:
        raise FeishuError(
            "authorize-created requires the resource owner's user_access_token; "
            "the authenticated user is not the live owner")
    result = repair(
        client, token, rtype, chat_id, dealclaw_openid,
        prune=True, dry_run=False, keep_openids=[actor_id],
    )
    if result.get("status") != "ok":
        raise FeishuError("post-create permission grant did not converge to the closed group policy")
    raw_snapshot = snapshot(
        client, token, rtype, chat_id, dealclaw_openid,
        context_id, observation_id, [actor_id],
    )
    try:
        proof = resource_permission_guard.validate(raw_snapshot)
    except resource_permission_guard.PermissionGuardError as exc:
        raise FeishuError(f"chat-isolation-v3 validation failed: {exc}") from exc
    return {
        "status": "verified",
        "publish_allowed": True,
        "permission_policy_version": proof["policy_version"],
        "permission_proof": proof,
    }


class _ContractClient(FeishuClient):
    """In-memory Feishu contract double for endpoint/payload self-tests."""

    def __init__(self, actor_in_chat: bool = True) -> None:
        super().__init__("https://open.feishu.cn", user_token="u-test")
        self.in_chat = actor_in_chat
        self.public = {
            "external_access_entity": "open",
            "link_share_entity": "tenant_readable",
            "manage_collaborator_entity": "collaborator_can_view",
            "security_entity": "anyone_can_view",
        }
        self.members = [{
            "member_type": "openid", "member_id": "ou_creator",
            "perm": "full_access", "type": "user", "is_owner": True,
        }]
        self.calls: list[tuple[str, str, Any, dict[str, str] | None]] = []

    def _raw(self, method: str, path: str, body: Any = None, auth: bool = True,
             query: dict[str, str] | None = None) -> dict[str, Any]:
        self.calls.append((method, path, body, query))
        if method == "GET" and path == "/open-apis/authen/v1/user_info":
            return {"code": 0, "msg": "success", "data": {"open_id": "ou_creator"}}
        if method == "GET" and path.endswith("/members/is_in_chat"):
            return {"code": 0, "msg": "success", "data": {"is_in_chat": self.in_chat}}
        if path.startswith("/open-apis/drive/v2/permissions/") and path.endswith("/public"):
            if method == "PATCH":
                self.public.update(body or {})
            return {"code": 0, "msg": "success",
                    "data": {"permission_public": dict(self.public)}}
        if path.startswith("/open-apis/drive/v1/permissions/") and path.endswith("/members"):
            if method == "GET":
                return {"code": 0, "msg": "success",
                        "data": {"items": json.loads(json.dumps(self.members)),
                                 "has_more": False}}
            if method == "POST":
                created = dict(body or {})
                created["is_owner"] = False
                self.members.append(created)
                return {"code": 0, "msg": "success", "data": {}}
        if path.startswith("/open-apis/drive/v1/permissions/") and "/members/" in path:
            member_id = path.rsplit("/", 1)[-1]
            if method == "PUT":
                for item in self.members:
                    if item.get("member_id") == member_id:
                        item.update(body or {})
                        return {"code": 0, "msg": "success", "data": {}}
            if method == "DELETE":
                self.members = [m for m in self.members if m.get("member_id") != member_id]
                return {"code": 0, "msg": "success", "data": {}}
        raise AssertionError(f"unexpected contract call: {method} {path}")


def self_test() -> None:
    client = _ContractClient()
    result = authorize_created(
        client, "docx_test", "docx", "oc_test", "ou_dealclaw",
        "creation:oc_test:1", "permission-read-created-1",
    )
    assert result["publish_allowed"] is True
    assert result["permission_proof"]["policy_version"] == "chat-isolation-v3"
    assert result["permission_proof"]["permission_chat_id"] == "oc_test"
    assert result["permission_proof"]["permission_actor_role"] == "owner"
    assert any(
        method == "PATCH" and path == "/open-apis/drive/v2/permissions/docx_test/public"
        and body == CLOSED_PUBLIC
        for method, path, body, _ in client.calls
    )
    assert not any("/drive/v1/permissions/docx_test/public" in path for _, path, _, _ in client.calls)
    assert any(path.endswith("/members/is_in_chat") for _, path, _, _ in client.calls)
    group = next(m for m in client.members if m.get("member_id") == "oc_test")
    assert group == {
        "member_type": "openchat", "member_id": "oc_test", "perm": "edit",
        "perm_type": "container", "type": "chat", "is_owner": False,
    }
    dealclaw = next(m for m in client.members if m.get("member_id") == "ou_dealclaw")
    assert dealclaw["perm"] == "full_access"

    outside = _ContractClient(actor_in_chat=False)
    try:
        authorize_created(
            outside, "docx_test", "docx", "oc_test", "ou_dealclaw",
            "creation:oc_test:2", "permission-read-created-2",
        )
    except FeishuError:
        pass
    else:
        raise AssertionError("A creator outside the target group was allowed to authorize it")
    print("feishu_permission_fix self-test: ok")


def build_client(args: argparse.Namespace) -> FeishuClient:
    base = args.base_url or os.environ.get("FEISHU_BASE_URL", DEFAULT_BASE_URL)
    user_token = args.user_token or os.environ.get("FEISHU_USER_TOKEN", "")
    app_id = args.app_id or os.environ.get("FEISHU_APP_ID", "")
    app_secret = args.app_secret or os.environ.get("FEISHU_APP_SECRET", "")
    return FeishuClient(base, app_id, app_secret, user_token)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("diagnose", "repair", "snapshot", "authorize-created"):
        p = sub.add_parser(name)
        p.add_argument("--token", required=True, help="Docx or Base app token")
        p.add_argument("--type", dest="rtype", choices=("docx", "bitable"), required=True)
        p.add_argument("--chat-id", required=True, help="bound openchat chat_id (oc_...)")
        p.add_argument("--dealclaw-openid", default="", help="DealClaw app OpenID (ou_...)")
        p.add_argument("--app-id", default="")
        p.add_argument("--app-secret", default="")
        p.add_argument("--user-token", default="")
        p.add_argument("--base-url", default="")
        if name == "repair":
            p.add_argument("--prune", action="store_true",
                           help="remove unexpected collaborators")
            p.add_argument("--dry-run", action="store_true")
            p.add_argument("--keep-openid", action="append", default=[],
                           help="extra collaborator openid to retain during prune")
        if name in {"snapshot", "authorize-created"}:
            p.add_argument("--context-id", required=True)
            p.add_argument("--observation-id", required=True)
        if name == "snapshot":
            p.add_argument("--allowed-manager-openid", action="append", default=[])
    sub.add_parser("self-test")
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    client = build_client(args)
    try:
        if args.command == "diagnose":
            result = diagnose(client, args.token, args.rtype, args.chat_id,
                              args.dealclaw_openid)
        elif args.command == "repair":
            result = repair(client, args.token, args.rtype, args.chat_id,
                            args.dealclaw_openid, args.prune, args.dry_run,
                            args.keep_openid)
        elif args.command == "snapshot":
            result = snapshot(client, args.token, args.rtype, args.chat_id,
                              args.dealclaw_openid, args.context_id,
                              args.observation_id, args.allowed_manager_openid)
        else:
            result = authorize_created(
                client, args.token, args.rtype, args.chat_id,
                args.dealclaw_openid, args.context_id, args.observation_id,
            )
    except (FeishuError, resource_permission_guard.PermissionGuardError) as exc:
        print(json.dumps({"error": str(exc), "publish_allowed": False},
                         ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
