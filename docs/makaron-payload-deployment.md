# Makaron private candidate

Makaron is a separate, versioned Mirror V template. It runs its own OpenClaw
creative loop and calls Makaron's project facade; other templates and existing
tenant snapshot pins are retained.

The initial candidate uses `makaron.v2.0.0`, archive SHA-256
`2b5149c2a08983a924f5e3ad5946e7546684ab36312a3255af79f4d3da09fe47`,
from Makaron source commit `8c0ab71040ac1b0a464de408402c3d835809c7b6`.
The backend Preview is commit `b89f838be40edb76baa74a38367e399502ba12c8`,
deployment `dpl_Fzyi233SA3czVQE6B9xSt3YgFcMV`. Its facade is
`https://ai-image-editor-169dbdy3v-vegekyd-sys-projects.vercel.app/api/harness`.
The immutable archive is unchanged; the credential-free runtime profile selects
this endpoint. The production Makaron facade has not been promoted by this task.

## Build and stage

Use an isolated, clean `codex/makaron-portal-deploy` checkout. After its control
plane tests pass, commit and run `bash scripts/stage-makaron-candidate.sh`.
This follows the standard release package recipe and stages the exact commit;
it does not activate services or change public aliases.

Build only the new template from the staged runtime-manager directory:

```sh
NEXUS_CONFIG_PATH=/opt/nexus/data/config.json pnpm exec tsx scripts/build-snapshot.ts \
  --template makaron \
  --payload-archive /opt/nexus/data/makaron-candidate-20261003/makaron.v2.0.0.tar \
  --agent-kit-runtime /opt/nexus/data/makaron-candidate-20261003/makaron-runtime-candidate.json
```

The builder checks the archive before allocating a sandbox. It pins a
credential-free profile in the snapshot, verifies Node >=24.19 and native
OpenClaw 2026.7.1, checks all 23 Makaron tools and 72 Skills, and records native
evidence. Template construction preserves other configuration and saves a
private configuration backup. Keep Makaron `listed: false` for this private
trial; public signup requires each customer's own Makaron authentication flow.

## Account and runtime isolation

Set only `templates.makaron.model` in private server configuration to the
candidate planner and pin `modelVersion` to `makaron.v2.0.0`. Do not change the
global model for other tenants. Model credentials remain in private controller
configuration and ephemeral process environment.

Create fresh random tenant IDs and verify their exact template, version and
snapshot after creation. Bind `MAKARON_API_KEY` to each private trial through
the runtime-manager secret API or `Store.setTenantSecrets`; it is sealed in the
tenant store. Never bind an owner's key globally to a public template or include
its value in the archive, snapshot, QR, browser page or deployment evidence.
Use separate tenants for creative acceptance and the user's own trial.

## Activate and hand off

After the snapshot and model configuration are ready, use
`scripts/deploy-mirror-v.sh activate <staged-commit>` and check the existing
Portal, services and template catalog. The standard activator preserves the
previous release and restores it if its checks fail. For a later manual
rollback, activate the saved prior release; restore only the candidate's
configuration changes after checking for concurrent operator changes.

Run a real creative request through the private acceptance tenant, check native
tool receipts and a viewable artifact, and verify sleep/wake state separately.
For the user's trial, call the loopback/admin-authorized
`POST /v1/channels/weixin/login` with that exact tenant ID. Generate a PNG from
the returned `qrImage` URL immediately before handing it to the user. iLink
codes expire after five minutes; refresh a code for the same tenant if needed.
The user confirms the scan on their own phone.

The current WeChat edge receives text and returns text. Finished media must be
delivered as usable links. A generated QR and a browser/native creative smoke
do not prove phone-side ingress, reply delivery or attachment support; record
those stages according to their actual evidence.
