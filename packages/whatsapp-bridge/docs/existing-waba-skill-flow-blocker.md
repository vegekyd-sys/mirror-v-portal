# Existing WABA Skill flow: authorization blocker

Status: **blocked; do not implement the Skill flow yet**.

The Bridge-side operator import added in `0f56193` remains the only existing-WABA
write path. It must stay protected by `WHATSAPP_BRIDGE_ADMIN_TOKEN`, and that token
must remain server-side. Do not inject it into a tenant workload, Skill environment,
agent process, browser bundle/session, URL, request body, or log.

## Missing capability

DealClaw currently has no authenticated, tamper-resistant assertion that proves the
human requesting a Skill action is an administrator for the current tenant's Mio
supplier. The missing capability must bind all of these claims in one server-verified
identity:

```text
authenticated human caller
  -> current tenant
  -> tenant's configured Mio supplier
  -> administrator permission for that tenant/supplier
  -> explicit bind-existing-WABA action
```

The backend must derive the tenant and supplier from that verified identity. It must
not accept either value as an authoritative Skill/model-supplied field.

## Why existing mechanisms are insufficient

- `nexus-gateway` verifies the Feishu webhook identity, but its role resolver currently
  returns `member` for every user. It has no tenant-admin directory or authorization
  lookup.
- Mio adapter calls use caller-supplied `X-Feishu-Open-Id` and `X-Supplier-Id` headers.
  Those headers select context but do not prove an administrator role.
- `PROVISIONING_API_TOKEN` is a shared service credential injected into tenant agents.
  It is not scoped to one tenant or supplier, so possession cannot authorize this
  privileged action.
- The stored tenant notification contact is captured using first-direct-message-wins.
  It is a delivery contact heuristic, not an administrator authorization proof.
- Provisioning external API keys may be supplier-scoped, but they are third-party
  accounting credentials. They are not provisioned as tenant-admin credentials and
  do not attest which human approved an action.
- The admin dashboard JWT authenticates DealClaw control-plane operators. It is not a
  tenant/supplier-admin assertion available to an agent-triggered Skill request.

Consequently, adding a public, tenant-selected, supplier-selected, shared-token, or
header-trusting proxy to the Bridge would weaken isolation and is forbidden.

## Required secure design before implementation

1. Add or integrate a server-side identity/authorization service that validates the
   inbound human identity and returns a signed or internally trusted assertion with
   tenant ID, supplier ID, role, actor ID, expiry, and single-purpose action/audience.
2. Make the authenticated application/backend derive the supplier from the authorized
   tenant record and require role `admin` (or a narrower WhatsApp-binding permission).
3. Accept a WABA ID only on an explicit `bind existing WABA` action. Do not add WABA ID
   fields to phones, templates, conversations, or messages.
4. Keep `WHATSAPP_BRIDGE_ADMIN_TOKEN` only in the authenticated backend's server-side
   secret store. The backend calls the existing Bridge admin import over the private
   server-to-server path and returns a WABA-ID-free result.
5. Keep the Bridge as the final verifier: it validates YCloud manageability and
   atomically rejects existing ownership by another tenant or phone mappings to
   another WABA.
6. Audit the actor, derived tenant/supplier, action, outcome, and a one-way WABA
   fingerprint. Never log the raw WABA ID or either server credential.

## Acceptance tests for the eventual flow

- Missing, forged, expired, wrong-audience, non-admin, cross-tenant, and
  cross-supplier assertions fail before the Bridge is called.
- The backend ignores/rejects model-supplied tenant and supplier overrides and uses
  only server-derived values.
- The Bridge admin token is absent from Skill payloads, agent/gateway deployments,
  browser assets, responses, URLs, and logs.
- Routine phones/templates/conversations/messages remain WABA-ID-free; an extra WABA
  field cannot steer routing. The regression test in `tenant-isolation.test.ts`
  exercises this invariant.
- Same-tenant re-import is idempotent; cross-tenant WABA ownership and phone conflicts
  are rejected atomically by the Bridge.
- No test performs a real YCloud, Meta, or production Bridge call.

## Current change boundary

Until the missing authorization capability exists:

- do not add an app/backend bind endpoint;
- do not expose or proxy the Bridge admin credential;
- do not update either `ycloud-whatsapp` Skill copy to accept WABA IDs;
- keep `0f56193` local and undeployed.
