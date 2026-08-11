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
