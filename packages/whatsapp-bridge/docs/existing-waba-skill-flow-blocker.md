# Existing WABA Skill flow: temporary allowlisted exception

Status: **temporary feature-first path approved for explicitly allowlisted suppliers**.

The Bridge-side operator import added in `0f56193` remains protected by
`WHATSAPP_BRIDGE_ADMIN_TOKEN`; that token stays server-side and is never reused by the
Skill. The temporary Skill path is a separate endpoint that delegates to the same
YCloud verification and atomic ownership importer without reading the admin token.

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

Consequently, a global/open, shared-token, or header-trusting proxy remains forbidden.
The temporary exception below is intentionally limited to exact supplier IDs configured
by the server operator.

## Temporary approved boundary

`POST /api/whatsapp/bind-existing-waba` is enabled only when the request's exact
supplier ID appears in server configuration
`WHATSAPP_BRIDGE_SKILL_BIND_ALLOWED_SUPPLIERS`. Missing or empty configuration disables
the endpoint. Documentation uses test supplier `123456`; the application has no
hardcoded tenant or supplier allowlist.

The endpoint accepts only `partnerCustomerId` / `supplierId` and `wabaId`. It is used
only for explicit user intent “绑定已有 WABA”, with the supplier read from the current
agent's `MIO_CDP_SUPPLIER_ID`. It returns no WABA ID. It does not change the routine
phones, templates, conversations, or messages contracts.

This exception is not proof of tenant-admin identity and is not a general multi-tenant
authorization solution. It is a narrow server-operated feature gate for named test or
pilot suppliers. Do not turn it into a global/open self-service endpoint.

## Required long-term secure design

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

## Acceptance tests

- Missing/empty allowlist disables the temporary endpoint before YCloud is called.
- A supplier not present in the exact server allowlist is rejected before YCloud.
- The Skill uses only its current `MIO_CDP_SUPPLIER_ID`; conflicting aliases and extra
  authority fields are rejected.
- The Bridge admin token is absent from Skill payloads, agent/gateway deployments,
  browser assets, responses, URLs, and logs.
- Routine phones/templates/conversations/messages remain WABA-ID-free; an extra WABA
  field cannot steer routing. The regression test in `tenant-isolation.test.ts`
  exercises this invariant.
- Same-tenant re-import is idempotent; cross-tenant WABA ownership and phone conflicts
  are rejected atomically by the Bridge.
- No test performs a real YCloud, Meta, or production Bridge call.

## Current change boundary

Until the long-term authorization capability exists:

- keep the Skill endpoint disabled by default and limited to the explicit server allowlist;
- never expose, proxy, or reuse the Bridge admin credential in the Skill path;
- accept WABA ID only in the explicit bind-existing-WABA action;
- keep routine WhatsApp APIs WABA-free;
- do not add shared-WABA behavior or schema changes.
