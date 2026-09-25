# Mirror V portal deployment

Nexus is Mirror V's public portal. The product source is GitHub `dev`, based on
the DealClaw Elastic runtime. The original GitLab services are reusable code,
but their Kubernetes tenant provisioning must not be started on this 2 GB
Lighthouse instance.

## Host boundary

- Lighthouse `lhins-dpf9aill`, 43.134.135.143, Ubuntu 24.04.
- Existing OpenClaw gateway and `/feishu/events` Nginx route remain in place.
- Nexus runtime-manager listens on 127.0.0.1:8097; central-gateway listens on
  127.0.0.1:8098. Nginx exposes `/`, `/onboard`, `/healthz` and `/v1/agent/`.
- PostgreSQL 16 is local. Private config and database are outside releases at
  `/opt/nexus/data`; no credential or private payload is committed to GitHub.
- `/opt/nexus/current` points at a committed release. The deploy script keeps
  `/opt/nexus/previous` for a one-step rollback.

## Initial cutover

1. From a clean `dev` checkout, run `scripts/deploy-mirror-v.sh stage`.
2. Verify the release is installed, the private config exists, and PostgreSQL
   is ready. Back up the source database.
3. Stop the VLab `nexus-central-gateway` and `nexus-runtime-manager` before the
   final database dump. Only one runtime-manager may hold the Feishu long
   connections for a tenant.
4. Restore the source `nexus_elastic` database on Mirror V. Install the two
   systemd units and the Nginx location include from this directory without
   replacing the OpenClaw `/feishu/events` location.
5. Run `scripts/deploy-mirror-v.sh activate`. Check `/healthz`, both template
   IDs from `/onboard/templates`, a new scan-created tenant and a real Agent
   reply. Then update the Vercel edge rewrite to Mirror V.
6. Keep the VLab database dump and release until the new entry is accepted.

For later releases, `scripts/deploy-mirror-v.sh deploy` stages the exact
committed `dev` revision, installs production dependencies, switches the
symlink, restarts both services and restores the previous release if the
health or template checks fail. The GitHub `dev` workflow builds and tests the
control plane before promotion.

The legacy GitLab admin console, billing ledger and K8s provisioning are not
part of these two units. Their APIs and data model require adaptation to the
elastic instance identity before they are exposed as working Nexus features.
