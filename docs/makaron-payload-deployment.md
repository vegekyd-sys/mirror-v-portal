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
the returned `qrImage` URL immediately before handing it to the user. The manager
session lasts at most five minutes; the WeChat provider can expire its QR earlier.
Check its actual status and refresh a code for the same tenant if needed.
The user confirms the scan on their own phone.

The WeChat edge receives text and original image items. Image bytes are downloaded
and AES-decrypted according to Tencent's iLink protocol, validated and saved in
private tenant directories. Durable run metadata contains only a relative path,
MIME, byte count and checksum, never the CDN reference or AES key. A message accepts
at most four images, 10 MiB per image and 12 MiB total. An image-only message asks
for acknowledgement without generating media. A following text message in the
same tenant, channel and conversation receives the latest image. A failed new
image blocks inheritance of an older image; replay uses the wire message ID and
does not queue another creative turn.

The sandbox receives the same checked bytes in `workspace/inbound`. A vision
profile sends actual `input_image.source.base64` to OpenClaw 2026.7.1; legacy text
profiles receive the real file path. Makaron imports that path and reads canonical
project status to find its actual media index before editing it. The immutable
`makaron.v2.0.0` archive and existing tenant snapshot pins remain unchanged.

WeChat replies still contain text and usable media links. A generated QR and a
browser/native creative smoke do not prove phone-side ingress, reply delivery or
attachment support; record each stage according to its actual evidence. Photos
discarded by the previous text-only ingress cannot be recovered from run storage;
the user must resend them in the existing bound conversation after the fix.

## Inbound image repair acceptance (2026-10-03)

Controller release `f11b302016c5` is active, with `d82277692266` retained for
rollback. Private configuration and all 14 tenant template/version/snapshot pins
match the pre-deploy record; the user's WeChat binding remains active. The two
additive run columns are `attachments` and `inherit_attachments`.

Runtime tests passed 148/148, including an isolated PostgreSQL cluster for
durable image metadata, replay deduplication, conversation isolation, timestamp
ordering and failed-new-image inheritance barriers. All release packages built.

Fresh-session cloud run `e215953f-c6d4-4417-b9d6-82a33d80ab46` succeeded using the
existing acceptance image (167,398-byte JPEG, SHA-256
`a25109cce6ca9184707f013e512a2262f86a501c5f7c1cdd4aa6336cf5426a63`). The native user
message contains typed image bytes matching the controller file and workspace
backup. Before any tool call, the model correctly describes the pink macaron,
navy background and gold rings. It then calls only project status, new_run,
import and status, and confirms the imported Snapshot has actual media index 2.
This demonstrates vision and preservation of the source through project import,
without generating another image. Natural idle released the sandbox, and its
backup retained the same inbound file hash.

SDK restore and runtime ensure preserved the source image, project record, import
receipt and four session files byte-for-byte. The payload profile/archive pins
also matched. The normal collector subsequently returned the acceptance sandbox
to sleeping/stopped with no pending tasks; its idle setting and precise activity
timestamp were unchanged. No additional model call or media generation was used
for this lifecycle check. Media credits were zero for the import test; its five
planner requests reported a separate provider charge of USD 0.702123.

This controlled request uses the `web` channel and does not send a WeChat message.
Phone-side image ingestion of the user's original photo still requires a resend;
the previous text-only ingress discarded it. Do not report this technical test
as that phone-side acceptance or as a completed poster.

## Real phone failure follow-up

The user's resends at 02:10 and 02:18 China time failed before native vision:
the original image runs contained no attachments and the Edge emitted ingress
rejection events. Those events initially discarded the downloader's safe error
code, so they cannot establish whether CDN, AES or file validation failed.

The follow-up removes an unsupported assumption that inbound `mid_size` must
equal downloaded ciphertext size, and accepts decodable JPEG trailing data
without changing the original bytes. Actual stream limits, AES padding, trusted
expected hash/size checks and CDN host constraints remain enforced. Before
download, the original image message is now sealed with the controller's
AES-256-GCM key in a private 0600 receipt, so a failed download can be retried
without another user upload. This receipt never enters the sandbox or logs.
Events retain fixed stage/error codes, numeric size/HTTP fields and format/key
source enums; they omit URLs, query strings, AES keys and raw packets.

Image-only messages may continue a previously authorized unfinished creative
request; otherwise they only acknowledge receipt. Reception failure replies
identify the system problem and do not tell the user to change their photo
without evidence. These changes are not phone acceptance until a real iLink
image has downloaded, decrypted and reached the native runtime successfully.
