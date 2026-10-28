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
- The Vercel Portal edge reaches `https://mirror-v-origin.tianyi.live`
  through a dedicated named Cloudflare Tunnel on this host. Both public and
  tunnel transport use TLS; only the final loopback hop uses local HTTP.
  A Nginx listener at `127.0.0.1:18083` exposes the existing Portal locations,
  excluding the old OpenClaw `/feishu/events` route and runtime-manager API.
  The connector is managed by `nexus-origin-tunnel.service` and holds only
  this tunnel's credential, not the Cloudflare account management certificate.
- Nginx also retains its Let's Encrypt IP certificate on 443. Tencent Cloud's
  public 443 ingress is not required by the tunnel route. Certbot checks
  renewal four times daily and reloads Nginx after renewal.
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

For later releases, `scripts/deploy-mirror-v.sh deploy [sha]` stages a
revision that is already on GitHub `dev` with green CI, installs production
dependencies, switches the symlink, restarts all three services and restores
the previous release if the health, template or admin checks fail. The GitHub
`dev` workflow builds and tests the control plane and admin SPA before
promotion.

- `stage` runs on the host: it downloads the commit from GitHub and builds it
  there (heap capped, `nice`, swap-backed). When the commit leaves the build
  inputs (root package files and the gateway, manager, ledger and admin
  packages) unchanged from the running release, it reuses that release's build,
  so a payload-only release stages in about a minute. `stage-local` is the old
  path that builds locally and uploads; it needs a fast uplink.
- `activate` first waits until no Agent run is queued or running (up to 20
  minutes; `NEXUS_FORCE_ACTIVATE=1` skips the wait), since a restart drops an
  in-flight turn's reply. After a healthy switch it keeps `current`,
  `previous` and the four newest other releases and deletes older ones.
- A new `mirror-v-full` payload still needs its snapshot built on the host
  before activation (see the template section).

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

## New-template avatar publication gate

New snapshots start with `listed:false`. Use a content-addressed PNG named
`agent-<id>-portrait-<sha256-first-12>.png` in the onboarding static directory.
The shared avatar policy supplies anonymous CORS and a cache revision for any
new Agent name; template rebuilds preserve `avatarUrl`.

After the candidate static asset and hidden template are available, run:

```bash
pnpm --filter @dealclaw/central-gateway build
node packages/central-gateway/dist/check-template-avatars.js \
  --catalog 'https://mirror-v-portal.vercel.app/onboard/templates?template=<id>'
```

This read-only gate checks every returned template for a public HTTPS image,
Feishu CORS permission, PNG decoding, dimensions, and its content-address hash.
A missing/broken avatar exits non-zero. Then inspect the actual Feishu creation
page in the Codex in-app browser and confirm its 240×240 Canvas avatar; no new
application needs to be created for that image check. Only then enable `listed`.
Normal `activate` also runs this gate for all public templates and rolls back
if it fails. HTTP 200 and health alone are not avatar acceptance.

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

## HTTPS origin enablement and rollback

Production SSH uses the existing dedicated deploy key named in
`scripts/deploy-mirror-v.sh`; Vercel uses the linked project in
`deploy/vercel-edge/.vercel/project.json`. A Tencent Cloud console session
is not needed for normal release or the current HTTPS transport.

The named tunnel is `mirror-v-portal-origin-20261014`. Its CNAME was created
using the existing infrastructure account; it does not replace any prior DNS
record or tunnel. Only its credential is installed at
`/opt/nexus/data/portal-origin/credentials.json` (0600). The account management
certificate remains on its original host and is not distributed.

Install `nginx-origin.conf` as
`/etc/nginx/sites-enabled/nexus-portal-origin.conf`, validate and reload Nginx.
Install the pinned official `cloudflared` 2026.10.0 binary (release SHA-256
`d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db`).
Install and enable `nexus-origin-tunnel.service` from this release. Verify:

```sh
systemctl is-active nexus-origin-tunnel
curl -fsS https://mirror-v-origin.tianyi.live/healthz
```

Before production edge promotion, verify an HTTPS preview's templates,
assets, and onboarding responses. Existing tenant payload/snapshot pins
remain intact. The tunnel metrics listener is loopback-only on 18084.

Before disabling the origin tunnel, restore a working edge deployment and
hide Makaron signup if the old edge uses HTTP. Stop only
`nexus-origin-tunnel.service`, remove its dedicated Nginx listener, validate
and reload Nginx. Do not stop or change other infrastructure tunnels.
The previous production edge is
`mirror-v-portal-j2q6h3ypr-vegekyd-sys-projects.vercel.app`.

## Homepage-only updates

The gateway build emits `public/onboard/index.html`, and staging copies it
into the committed release. Nginx serves the homepage directly while all
account, QR, polling and channel APIs stay on the gateway. Feishu's native
JSON entry (except the Makaron account page), DingTalk and WeCom still use
their existing gateway handlers. Static HTML retains the gateway security
headers and is revalidated on reload.

For a homepage-only release, compare unchanged runtime/ledger code, template
pins and origin configuration, switch the release pointer and gracefully
reload the Nginx locations. Do not restart the gateway merely to update the
homepage: doing so drops its in-memory pending scan sessions. Preserve the
old release pointer and Nginx include for rollback. Normal backend releases
continue through the standard activation script.
