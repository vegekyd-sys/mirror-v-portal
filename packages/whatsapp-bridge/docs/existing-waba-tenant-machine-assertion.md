# Existing WABA Skill flow: Bridge admin token

Status: **universal for provisioned tenant machines using the centrally managed Bridge admin token**.

## Authorization path

1. Provisioning stores the global `WHATSAPP_BRIDGE_ADMIN_TOKEN` in encrypted runtime config.
2. The existing `skill-env` rollout path writes it to each provisioned tenant's mounted `.env`; the agent entrypoint exports it to the Skill process.
3. On explicit user intent “绑定已有 WABA”, the helper reads only `MIO_CDP_SUPPLIER_ID` and `WHATSAPP_BRIDGE_ADMIN_TOKEN` from its own process environment.
4. The helper calls `POST /api/admin/whatsapp/import-existing-waba` with:

```json
{
  "partnerCustomerId": "current MIO_CDP_SUPPLIER_ID",
  "wabaId": "explicitly supplied for this action"
}
```

The request carries `Authorization: Bearer <WHATSAPP_BRIDGE_ADMIN_TOKEN>`. The helper never prints or persists this token; responses contain no WABA ID.

## Boundaries

- This route is only for explicit “绑定已有 WABA” intent. Ordinary onboarding and `WHATSAPP_BINDING_REQUIRED` continue to use Partner Direct Link.
- Bridge's `whatsapp-bridge-secret` and provisioning's global runtime-config must contain the same admin token. Rotation must update both before tenant Skills use the new value.
- YCloud validation plus SERIALIZABLE WABA/phone ownership locks remain unchanged.
- Fail closed on a missing token or Bridge authorization error. Do not fall back to unsigned requests.

## Verification

- The helper must submit `partnerCustomerId` and `wabaId` only, target the admin importer, and attach Bearer authentication.
- Bridge tests cover admin-token authentication and atomic WABA/phone ownership checks.
