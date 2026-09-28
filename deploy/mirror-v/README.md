# Mirror V Portal deployment

V 的版本矩阵、Payload 更新和未来 OpenClaw 升级流程见 [V-OPERATIONS.md](V-OPERATIONS.md)。

Mirror V Portal is Mirror V's public multi-Agent portal. The product source is GitHub `dev`, based on
the DealClaw Elastic runtime. The original GitLab services are reusable code,
but their Kubernetes tenant provisioning must not be started on this 2 GB
Lighthouse instance.

## Host boundary

- Lighthouse `lhins-dpf9aill`, 43.134.135.143, Ubuntu 24.04.
- Existing OpenClaw gateway and `/feishu/events` Nginx route remain in place.
- The runtime-manager listens on 127.0.0.1:8097; central-gateway listens on
  127.0.0.1:8098; credits-ledger listens on 127.0.0.1:8081. Nginx exposes
  `/`, `/onboard`, `/admin`, `/healthz`, `/v1/agent/` and ledger `/v1/`.
- PostgreSQL 16 is local. Private config and database are outside releases at
  `/opt/nexus/data`; this legacy path stays in place during the brand rename.
  No credential or private payload is committed to GitHub.
- Nginx serves the origin through a Let's Encrypt IP certificate on 443.
  Certbot checks renewal four times daily and reloads Nginx after renewal.
- `/opt/nexus/current` points at a committed release. The deploy script keeps
  `/opt/nexus/previous` for a one-step rollback.

## Initial cutover

1. From a clean `dev` checkout, run `scripts/deploy-mirror-v.sh stage`.
2. Verify the release is installed, the private config exists, and PostgreSQL
   is ready. Back up the source database.
3. Stop the VLab `nexus-central-gateway` and `nexus-runtime-manager` before the
   final database dump. Only one runtime-manager may hold the Feishu long
   connections for a tenant.
4. Restore the source `nexus_elastic` database on Mirror V. Install the three
   systemd units and the Nginx location include from this directory without
   replacing the OpenClaw `/feishu/events` location.
5. Run `scripts/deploy-mirror-v.sh activate`. Check `/healthz`, both template
   IDs from `/onboard/templates`, a new scan-created tenant and a real Agent
   reply. Then update the Vercel edge rewrite to Mirror V.
6. Keep the VLab database dump and release until the new entry is accepted.

For later releases, `scripts/deploy-mirror-v.sh deploy` stages the exact
committed `dev` revision, installs production dependencies, switches the
symlink, restarts all three services and restores the previous release if the
health, template or admin checks fail. The GitHub `dev` workflow builds and
tests the control plane and admin SPA before promotion.

The original GitLab admin SPA and credits-ledger are reused here. A ledger
trigger provisions a zero-balance account for each Elastic instance. Original
DealClaw plans are frozen and skill prices are shadow/unapproved on first
startup, so no charges are enabled by migration. The original Kubernetes
provisioning service, image rollout and cluster ops are not run on this 2 GB
host; Elastic's runtime manager remains the instance authority.

The portal supports Feishu registration and WeChat iLink scans. WeChat QR
sessions remain in manager memory; the tenant is created only after the phone
confirms. A manager restart expires an unfinished scan, which can be retried.

## Mirror V V001 payload

The public `mirror-v` starter in Git does not contain V001 memory. To make a
versioned V001-derived template, prepare a private text archive on the Mirror V
host from its existing `mirror-v-001` workspace:

```sh
python3 packages/runtime-manager/scripts/prepare-mirror-v001-payload.py \
  --source /root/makaron-openclaw/.openclaw-local/workspace \
  --output /opt/nexus/data/mirror-v-v001-payload.tar
```

The script copies Markdown, JSON and text memory/skills, rewrites the top-level
identity for independent Mirror V instances, redacts credential assignments,
and excludes media, logs, backups and runtime state. Review its file counts and
private archive before building. The archive must remain outside Git and have
mode `0600`. Build the Vercel snapshot from the private archive:

```sh
pnpm --filter @dealclaw/runtime-manager exec tsx scripts/build-snapshot.ts \
  --template mirror-v \
  --payload-archive /opt/nexus/data/mirror-v-v001-payload.tar
```

The builder stores the snapshot ID and `mirror-v.v001-full.v2` version in the
private config. New tenants get separate sandboxes seeded from that snapshot.
Existing tenants remain pinned to their original snapshot until migrated.
The V001 knowledge seed does not install old host credentials or tools; verify
memory indexing and real replies before exposing the new template.

## 星擎 template (`xingqing`)

The third template is a public starter in `packages/agent-templates/xingqing/`.
Its manifest lists every packaged file, including the 星擎 knowledge base as
read-only base memory at `memory/base/`, and the vendored `xingqing-cli` wheel.
The builder installs that wheel into `/vercel/sandbox/nexus/tools/venv`, and
`boot.mjs` puts `tools/bin` on `PATH` and turns on FTS memory search for it.
It uses the same tool profile as DealClaw.

```sh
pnpm --filter @dealclaw/runtime-manager exec tsx scripts/build-snapshot.ts --template xingqing
```

Every build backs up `config.json` first and records `builtAt`, `expiresAt`
(30 days) and the runtime versions on the template entry. A template built for
the first time is written with `"listed": false`: it can be created by explicit
`templateId` for acceptance tests but is not shown on the signup page. After
acceptance, set `"listed": true`. The runtime-manager reads templates at start,
so both steps need a `nexus-runtime-manager` restart.

A 星擎 tenant works without an account (product questions only) and needs the
customer's own 星擎 account for data. The customer can send it in chat — the
agent logs in with `xingqing-cli login`, which caches only a session token under
`agent-data/xingqing` — or an operator binds it on the agent's page in `/admin`,
which takes precedence. The runtime-manager seals operator bindings in
`elastic_tenant_secrets` and injects `XINGQING_USERNAME` / `XINGQING_PASSWORD`
when the sandbox boots. A new binding takes effect after the next idle sleep.
Never bind an admin or another company's account. The admin page relays through
the credits-ledger, which needs `RUNTIME_MANAGER_TOKEN` (the runtime-manager
`adminToken`) in `/opt/nexus/data/ledger.env`.

Payload updates, including a new knowledge base, reach new tenants only.
Existing tenants keep their seeded workspace until migrated; for a knowledge
update, replace only `memory/base/` in their workspace.

For local acceptance on a trusted Mac, run `scripts/mirror-v-local-tunnel.sh`
and open `http://127.0.0.1:18080/onboard`. The tunnel points to this same
deployed server and also exposes `/admin/login` locally without public HTTP.
