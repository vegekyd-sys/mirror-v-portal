# Existing WABA Skill flow: tenant-machine assertion

Status: **universal for provisioned tenant machines; no supplier allowlist or user-role token**.

## Authoritative identity and secret path

Provisioning owns both inputs used to establish tenant-machine identity:

1. `tenants.mio_cdp_supplier_id` is unique among live tenants and is injected as
   `MIO_CDP_SUPPLIER_ID`.
2. `provisionTenant()` creates a cryptographically random `OPENCLAW_GATEWAY_TOKEN` in
   `dealclaw-agent-config-<tenant>`. The tenant Deployment receives that Secret via
   `envFrom`; it is not accepted from tenant users or runtime-config UI input.

The binding helper reuses this existing machine secret with a domain-separated HMAC. It
does not reuse `PROVISIONING_API_TOKEN`, a tenant-admin/user-role credential, or
`WHATSAPP_BRIDGE_ADMIN_TOKEN` as tenant authority.

## Assertion contract

The explicit bind endpoint accepts only:

```json
{
  "supplierId": "current MIO_CDP_SUPPLIER_ID",
  "wabaId": "explicitly supplied for this action",
  "assertion": {
    "version": "v1",
    "issuedAt": 1788739200,
    "nonce": "base64url random nonce",
    "signature": "base64url HMAC-SHA256"
  }
}
```

The canonical signing input is newline-delimited:

```text
dealclaw-tenant-machine-assertion
v1
bind-existing-waba
whatsapp-bridge
<supplierId>
<wabaId>
<issuedAt>
<nonce>
```

Bridge accepts an assertion for at most 120 seconds, with at most 30 seconds of future
clock skew. It forwards the claims over an authenticated internal connection to
provisioning. Provisioning resolves the exact live tenant by supplier, reads the current
K8s machine Secret, verifies HMAC with constant-time comparison, and returns only
`{ "valid": boolean }`. It never returns or logs the machine secret.

After verification, Bridge writes only a SHA-256 nonce fingerprint to
`TenantMachineAssertionReplay`. The `(supplierId, nonceHash)` unique constraint makes
replay rejection atomic across Bridge replicas. Only then does Bridge call YCloud and
reuse the existing SERIALIZABLE importer and WABA/phone advisory locks.

## Boundaries

- The Skill path runs only for explicit user intent “绑定已有 WABA”. Ordinary onboarding
  and `WHATSAPP_BINDING_REQUIRED` continue to use Partner Direct Link.
- `WHATSAPP_BRIDGE_ADMIN_TOKEN` remains exclusive to
  `POST /api/admin/whatsapp/import-existing-waba` and is never sent to tenant runtimes.
- The Bridge→provisioning `PROVISIONING_API_TOKEN` authenticates only the internal
  verifier call; possession alone cannot produce a valid tenant assertion.
- The endpoint rejects supplier aliases, role/admin fields, extra claims, expired
  assertions, invalid supplier/WABA binding, and nonce replay before YCloud.
- Responses, errors, logs, and replay rows contain no WABA ID. Routine phones,
  templates, conversations, and messages APIs neither accept nor return WABA routing.
- Missing provisioning/K8s identity material fails closed; there is no unsigned or
  allowlisted fallback.

## Verification

- Provisioning tests pin the exact supplier→tenant→K8s Secret mapping and prove that
  changing supplier or WABA invalidates the signature.
- Bridge tests cover expiry/future skew, invalid verifier result, verifier outage,
  persistent replay rejection, strict payload fields, safe YCloud errors, and the
  existing atomic ownership/phone-conflict importer.
- Tests mock all network and database operations; no YCloud, Meta, production Bridge,
  provisioning service, or cluster is contacted.
