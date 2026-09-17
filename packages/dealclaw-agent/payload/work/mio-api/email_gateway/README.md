# DealClaw Email Gateway (SMTP + IMAP baseline)

Deterministic multi-user, multi-account email transport for OpenClaw command cron.

## Supported providers

- `netease_163`: `imap.163.com:993`, `smtp.163.com:465`
- `tencent_exmail`: `imap.exmail.qq.com:993`, `smtp.exmail.qq.com:465`
- `gmail`: `imap.gmail.com:993`, `smtp.gmail.com:465`

163 and Tencent should use a client authorization code where available. Gmail
MVP can use an App Password; production OAuth2 is a later adapter. Never put a
credential in the account database, CLI arguments, source code, or chat.
The 163 adapter sends the IMAP ID extension required by NetEase before opening
the inbox; without it NetEase may return `Unsafe Login` after successful auth.

## Data isolation

Accounts are scoped by `enterprise_id + owner_open_id`. A user can own multiple
email accounts, and a group can bind multiple users' accounts. The same account
may be bound to multiple groups. Sending requires the mailbox owner's
`owner_open_id` on every call.

`provider` and mailbox ownership are separate dimensions:

- `personal`: personally owned mailbox; owner-only access
- `enterprise_user`: company-issued mailbox assigned to one employee
- `enterprise_shared`: shared company mailbox; explicit owner/sender/viewer ACL
- `dealclaw_proxy`: DealClaw-managed proxy/inbound mailbox

For example, Tencent Exmail is a provider. `wang@company.com` can be an
`enterprise_user`, while `sales@company.com` can be an `enterprise_shared`
mailbox on the same provider.

## Quick start

```bash
cd work/mio-api
python3 -m email_gateway.cli init

python3 -m email_gateway.cli account-add \
  --enterprise example.com \
  --owner-open-id ou_xxx \
  --email person@example.com \
  --provider tencent_exmail \
  --secret-ref env:DC_EMAIL_PERSON_SECRET \
  --default

python3 -m email_gateway.cli bind-group \
  --account-id ema_xxx \
  --chat-id oc_xxx \
  --filter dealclaw_replies

# Verify IMAP and SMTP authentication without sending a message.
python3 -m email_gateway.cli account-check --account-id ema_xxx

# First run records the current high-water mark without importing old mail.
python3 -m email_gateway.cli sync --all --notify-text

# Explicitly import recent history when required.
python3 -m email_gateway.cli sync --all --bootstrap-days 7
```

## OpenClaw cron

Create one command cron after operator approval. Do not create one job per
mailbox. The command should run every five minutes from `work/mio-api`:

```text
python3 -m email_gateway.cli sync --all
```

The cron is intentionally not installed by this module. Scheduler changes are
an operational action and must be reviewed separately. When there are no new
events the command emits `NO_REPLY`.

For mailboxes bound to Feishu groups, use the deterministic card notifier so
each event is routed only to its own bound group without starting a model turn:

```text
python3 -m email_gateway.cron_notify --all
```

Notification cards include sender, subject, recipient mailbox, and a body
excerpt capped at 200 Unicode characters. Longer bodies end with an ellipsis.

## Safety

- `secret_ref` supports `env:NAME` and mode-0600 `file:/absolute/path` only.
- TLS certificate validation is always enabled.
- First sync does not ingest historic personal mail unless `--bootstrap-days`
  is explicitly supplied.
- Group bindings default to `dealclaw_replies`; even when `all` is temporarily
  enabled for a notification test, unrelated personal messages remain
  header-only metadata and never store a body preview.
- External send requires `--confirmed-by` matching the mailbox owner.

## 发信附件

两条链路都支持：个人邮箱走 SMTP MIME，代理邮箱走 Resend API 的 base64。
统一入口 `--attach`，可重复传，每次一个文件：

```bash
python3 -m email_gateway.cli send \
  --account-id ema_xxx --confirmed-by ou_xxx \
  --to buyer@example.com --subject 'Quotation' --text '...' \
  --attach /path/quote.pdf --attach /path/spec.png
```

口径（`email_gateway/attachments.py` 是唯一实现，两条链路共用）：

- **fail closed**：文件找不到、是目录、空文件、超总量上限 → 抛 `AttachmentError`，
  **一封都不发**。发信侧不允许静默少发附件——用户以为发了、买家没收到，比报错更糟。
  收信侧相反（超限记一行 `skipped: too_large` 放过），两边口径不同是故意的。
- **总量上限**默认 15MB 原始字节（编码后约 20.5MB，低于 Gmail 25MB 与 Resend 40MB
  的整封上限）。`DC_ATTACHMENT_SEND_MAX_BYTES` 可覆盖，调高前先确认收件方服务商吃得下。
- **幂等键**把附件指纹算进去：同一买家、同一段正文、换个附件重发是正常业务
  （先发规格书再补报价单），不能被判成 duplicate。不带附件时键与历史逐字节一致。
- **留痕**：发出去的附件落进统一附件库（与入站同一套目录/索引），出站事实的
  `attachments` 字段记索引行，案卷里能看到「我方发了什么」。落盘 best-effort，
  失败只丢原件不影响发送结果。
- `--dry-run` 同样校验附件，问题在真发之前暴露。

不支持通配符展开（`--attach '*.pdf'` 不会展开成多个）：由 shell 或调用方展开后逐个传，
避免「以为发了 5 个其实发了 1 个」。

FD 渠道（`scripts/founder-direct/send-direct.mjs`）**有意不支持附件**，见该脚本的
README 与 `dealclaw-email-founder-direct` skill：附件是批量发信者的识别特征，
与它「纯文本真人手写信」的定位冲突。要发附件走本网关或 GS。

## Lazy default mailbox + send gate (T2)

`email_gateway/provision.py` adds lazy default-mailbox creation and a pre-send
readiness gate. It starts no service and adds no dependency: address math is
`naming.py` (T1), persistence is `store.py`.

The account record it writes uses `provider=resend`, `mailbox_kind=dealclaw_proxy`
and `secret_ref=env:RESEND_API_KEY` (a reference name only, never a secret).
`is_default` is set only when the tenant has no account yet, so an existing
self-owned default sender is never displaced.

```bash
# 触发 A 的可调用入口（线索落池后 / 企业资料就绪后）
python3 -m email_gateway.cli mailbox-ensure \
  --enterprise 100000834234 --company-name 'Shenzhen Suntech Tools' \
  --owner-open-id ou_xxx --notify-target ou_xxx --activate

# 当前就绪度（只读）
python3 -m email_gateway.cli mailbox-status --enterprise 100000834234

# 触发 B 的可调用入口（发信之前）；未就绪退出码 3
python3 -m email_gateway.cli send-gate --enterprise 100000834234 \
  --from-address sales@mail.dealclaw.io
```

Python API:

```python
from email_gateway.provision import (
    ensure_mailbox,         # 幂等；失败抛 ProvisionError 子类
    try_ensure_mailbox,     # 同上，但永不抛异常（接线层用）
    check_send_ready,       # 闸门，永不抛异常
    assert_send_ready,      # 闸门，未就绪抛 SendNotReadyError
)
```

`ensure_mailbox(enterprise_id, *, company_name="", brand_name_en="",
short_name_en="", pinyin_abbr="", slug="", owner_open_id="",
notify_target="", activate=False, data_dir=None, at=None, max_attempts=8)`
returns:

| key | meaning |
| --- | --- |
| `ok` | always `True` on return (errors raise) |
| `address` / `email` / `domain` | `suntech-7k3` / `suntech-7k3@mail.dealclaw.io` |
| `status` | `reserved` until activated, then `active` |
| `created` / `idempotent` | whether this call reserved the address / hit an existing one |
| `account_id` / `account_created` | empty + `False` when no owner could be resolved |
| `notify_target` | binding target actually recorded (`oc_`/`ou_`) |
| `send_ready` / `routing_ready` / `notify_ready` / `naming_ready` | readiness flags |
| `blockers` / `reasons` | machine codes + human sentences, same order |
| `needs_replace` | `True` when the tenant's only address is retired |

Error codes (`ProvisionError.code`): `invalid_input`, `invalid_slug`,
`address_unavailable`, `account_conflict`, `owner_missing`,
`send_gate_not_ready`, `internal_error`. CLI exit codes: `0` ok, `1` error,
`3` gate not ready.

Readiness is three independent checks, all required:

- `naming_ready` — the address is `active` (a `reserved` address is only a hold)
- `routing_ready` — an enabled account exists and the address can still receive
- `notify_ready` — a `notify_enabled` `oc_`/`ou_` binding exists on that account

`check_send_ready` only judges mailboxes the naming service has reserved (a
naming record exists for the local part) — i.e. the default mailboxes T2
creates. Anything else returns `applicable=False, allowed=True`, so legacy
`mail.dealclaw.io` accounts and self-owned mailboxes behave exactly as before.
`DC_MAILBOX_GATE=warn|off` relaxes the gate during rollout; the default is
`enforce`.

Wirings (both never raise into business code):

- **触发 A** — `dc_ls_store.LeadStore.save_lead` calls
  `_ensure_default_mailbox` after the lead is persisted (return value unchanged).
- **触发 B** — `dc_email_send.send_batch` calls the gate before running the
  sender script; a blocked send returns `success=False, sent=False,
  code=send_gate_not_ready` and pushes a "未发送" receipt. `dc_pending_send`
  dispatches through `send_batch`, so the queued path is covered too.

## Send stop switches (T8)

No rate limiting — the quota is already 30/day per tenant. What T8 adds is a
blast-radius brake plus visibility, both in `send_control.py`:

```bash
python3 -m email_gateway.cli send-switch-status [--enterprise ID]
python3 -m email_gateway.cli send-switch-platform --action pause|resume \
    [--reason "..."] [--by WHO]
python3 -m email_gateway.cli send-switch-tenant --enterprise ID \
    --action pause|resume [--reason "..."] [--by WHO]
python3 -m email_gateway.cli send-alerts --enterprise ID [--start D --end D] \
    [--line] [--notify-target oc_xxx|ou_xxx]
```

- State lives in `<data_dir>/send-control/state.json` (no new service, no new
dependency, no SQLite). Tenant keys are canonicalised the same way as
`quality_metrics`.
- Platform switch stops **every** sender — self-owned and managed mailboxes
alike — because all tenants share one `mail.dealclaw.io` and one Provider
account. The tenant switch stops every sending identity of that tenant.
- A blocked send returns `success=False, sent=False, count=0`, `code`
`send_blocked_platform` / `send_blocked_tenant`, a human `reason`, and a
`next_action` naming who can resume. The sender script is never invoked.
- Switch state read failure → **does not block**, loud stderr warning. The
switch is a brake, not a security boundary; a broken state file must not stop
every tenant's mail.
- Thresholds (default `accepted >= 20`, complaint rate > 0.5%, bounce rate >
5%) only **alert** — never auto-cut. Below 20 accepted no ratio alert is
raised, so one complaint in a 30-send day can't be reported as 3.3%.
