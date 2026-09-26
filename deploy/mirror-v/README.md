# Mirror V Portal deployment

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

For local acceptance on a trusted Mac, run `scripts/mirror-v-local-tunnel.sh`
and open `http://127.0.0.1:18080/onboard`. The tunnel points to this same
deployed server and also exposes `/admin/login` locally without public HTTP.
