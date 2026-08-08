# DealClaw OpenClaw Runtime

`packages/dealclaw-agent` is an OpenClaw runtime image, not an intent/Skill mock.

## Runtime boundary

- One customer runtime owns one `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, workspace, session store, memory tree, and credential set.
- The immutable image contains `dealclaw-base.v1`: DealClaw identity, safety rules, tool routing, Skills, and non-secret CLI code.
- Startup refreshes the immutable base exactly and preserves only the manifest-declared customer data paths, preventing retired Skills/scripts from surviving an image upgrade.
- Customer knowledge/config is mounted as `/overlay` and synchronized only into `memory/customer/`; it cannot overwrite base identity, safety rules, Skills, or scripts.
- Mutable customer state lives on `/data` and must be backed by a customer-dedicated PVC or VM disk.
- Model/tool credentials are injected only through the customer runtime Secret. They are not part of the image or payload.
- The runtime config pins the DeepSeek API adapter/catalog explicitly, while the image pins the Node/Python dependencies used by the bundled DealClaw scripts; no host-global provider or plugin installation is assumed.

## HTTP compatibility

The container exposes the existing platform contract on port `18789`:

- `GET /healthz` verifies that the private OpenClaw Gateway is ready.
- `POST /execute` translates a normalized/Feishu message to OpenClaw `POST /v1/responses`.
- Tenant, channel, and user identity form a stable, hashed OpenClaw session key.
- There is no static Skill fallback. Runtime/model failures return `502 AGENT_RUNTIME_UNAVAILABLE`.

The OpenClaw Gateway itself listens only on container loopback port `18790` with the Responses API enabled. It is never exposed through the Kubernetes Service.

## Required secret inputs

At minimum, inject the API key for `DEALCLAW_MODEL` (default `deepseek/deepseek-chat`). Real DealClaw retrieval additionally needs the customer-authorized subset of:

- `MIO_CDP_APP_KEY`, `MIO_CDP_APP_SECRET`
- `APOLLO_API_KEY`
- `APIFY_TOKEN`, `APIFY_API_KEY`
- web-search provider keys
- mail credentials only after explicit customer binding

Startup fails closed when the selected DeepSeek model has no `DEEPSEEK_API_KEY`, rather than reporting a healthy bridge that cannot execute agent turns.

## Isolation and persistence

`k8s/tenants/tenant-template/all.yaml` creates a tenant namespace, runtime Secret, and dedicated 10 Gi PVC. NetworkPolicy permits DNS, the shared credits service, and public HTTPS while blocking private address ranges.

The runtime runs as non-root UID/GID 1000, drops Linux capabilities, disables privilege escalation and Kubernetes service-account token mounting, and exposes only the bridge port. The private OpenClaw Gateway remains loopback-only inside the container.

The Kubernetes template is the current test/compatibility implementation. The final product decision remains one customer per VM; that provisioning adapter must mount the same payload/overlay/secret contract on a dedicated VM disk.
