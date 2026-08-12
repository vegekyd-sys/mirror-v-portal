# Chat-isolated resource access

Apply this policy to every generated draft Docx, formal Docx, and buyer-lead Base. `chat_id` is the only group identity. Never enumerate members and never grant access from a company-name or title search.

## Required sequence

1. Require one invocation `chat_id` and one state record for that exact ID.
2. Create the resource privately and capture its returned token. For an existing group-supplied resource, use only its explicit token.
3. Update public permissions through the verified Feishu API/client wrapper:

```json
{
  "external_access_entity": "closed",
  "link_share_entity": "closed",
  "manage_collaborator_entity": "collaborator_full_access",
  "security_entity": "only_full_access"
}
```

4. List current collaborators. Remove every explicit collaborator except the resource owner, the automation identity required to operate the resource, and the exact bound group. Management exceptions must be explicit IDs from trusted configuration; never derive them from document content.
5. Add or update exactly one group collaborator:

```json
{
  "member_type": "openchat",
  "member_id": "<binding.chat_id>",
  "perm": "edit",
  "perm_type": "container",
  "type": "chat"
}
```

Use resource type `docx` for draft/formal documents and `bitable` for the Base. With tenant identity, require the app to be present and visible in the target group before granting the group collaborator.

6. Re-read public permissions and list collaborators. Normalize the live response to the input accepted by `scripts/resource_permission_guard.py validate`. Pass only the owner/automation IDs as `allowed_manager_member_ids`.
7. Persist the returned redacted proof only after validation succeeds. Never persist a caller-asserted proof or full resource token inside the proof.
8. On any update, cleanup, readback, or validation failure, keep the resource private, mark onboarding/formalization as blocked, and do not post its URL, bind it, activate it, query buyers, write Base records, or push leads.

Do not hard-code an unverified `lark-cli` subcommand. Use the host's verified Feishu OpenAPI client or discover and test the installed wrapper's exact permission commands before enabling this Skill.

## Proof placement

- Store a draft proof as `onboarding.draft_permission_proof` before posting the review link.
- Store active formal proofs under `resource_permissions.formal_document` and `resource_permissions.base`.
- Require `resource_permissions.permission_chat_id == state.chat_id == binding.chat_id`.
- Require proof token fingerprints to equal the fingerprints of the stored formal Docx and Base tokens.

## Existing and inherited access

Closing link sharing does not remove existing explicit collaborators or inherited access. Clean existing collaborators before validation. Create resources in a private, non-shared location; if a resource is inside a shared folder or Wiki space, also prove that parent/space membership cannot grant access to a person outside the bound group. Otherwise fail closed.

The owner, required automation identity, and enterprise administrators may retain platform-level management rights. Do not describe those identities as ordinary group-only access.

## External group members

This policy version is for internal-only groups and requires `external_access_entity = closed`. If the bound group contains external-tenant members who must edit, stop with `EXTERNAL_GROUP_MEMBER_POLICY_REQUIRED`; do not silently open external access. A separately approved policy version must keep link sharing closed and still grant only the exact `openchat` group.
