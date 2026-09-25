# Nexus deployment (Mirror V portal)

Nexus is the public portal for Mirror V. The source of record is the private
GitHub repository's `dev` branch, based on the DealClaw Elastic runtime.
`deploy/mirror-v/README.md` documents the release and rollback process.

## Live topology

Browser / Feishu → Vercel HTTPS `https://nexus-iota-topaz.vercel.app` →
Tencent Lighthouse `Mirror V` (`lhins-dpf9aill`, 43.134.135.143) Nginx →
central-gateway on 127.0.0.1:8098, credits-ledger on 127.0.0.1:8081, and
runtime-manager on 127.0.0.1:8097. PostgreSQL 16 is local. Agent sandboxes
are created by the existing Elastic provider. The host's original OpenClaw
Feishu event route remains in place.

`/onboard` selects DealClaw or Mirror V and offers Feishu and WeChat QR
authorization. The Feishu app or WeChat iLink confirmation creates a separate
Elastic tenant. `/admin/` shows the migrated customer,
credit, plan and pricing data alongside Elastic instances and runs. The
GitLab Kubernetes provisioning service is not used on this Lighthouse host.

## Releases and checks

From a clean committed `dev` checkout run
`scripts/deploy-mirror-v.sh deploy`. It stages the exact commit, builds the
control plane and admin SPA, installs production dependencies, switches
`/opt/nexus/current`, restarts services and checks gateway, ledger and admin.
The previous release remains at `/opt/nexus/previous`. GitHub Actions builds
and tests on every push to `dev`.

Private runtime config and the database stay under `/opt/nexus/data` and are
not committed. The admin bootstrap token is written once to a mode-0600 file
on the host; it must never be logged or added to a release artifact.
The origin certificate is a short-lived Let's Encrypt IP certificate. The
`nexus-cert-renew.timer` runs four times daily and reloads Nginx when renewed.

## Boundaries

The legacy DealClaw plans are frozen and legacy Skill prices remain in
shadow/unapproved state until their Mirror V terms are reviewed. Existing
Elastic tenants are backfilled with zero-balance accounts and future tenants
receive accounts at creation. Model usage and billable rates require separate
product approval; the presence of a credits account alone does not authorize
charging. For channel acceptance, verify a real scan, instance creation and a
human-visible agent response, not only `/healthz`.
