---
name: "fcloud-api"
description: "FCloud auth, account/video pagination, full-works fetch with retry, Bitable delivery, config.json required"
---

# fcloud-api

Use this skill when asked to retrieve FCloud / xxfcloud account data, follower counts, works, likes, views, country/status, daily social-account summaries, or full works export.

## Source of truth

- API docs: `work/fcloud/fcloud-api-docs/2.12.5/Fcloud_API_V2.12.5.md`
- Existing credential/script area: `work/fcloud/`
- Config file: `work/fcloud/config.json` (REQUIRED — must be present for refresh_report.py and all fcloud_common imports)
- Do **not** paste or duplicate private keys/API secrets into replies, memory, or new files. Reference existing credential/script locations only.

## Full-works fetch (全量作品拉取)

When asked to pull ALL works from FCloud (typically 5000+ records): "拉全量fcloud作品" / "导出所有视频数据" / "全量作品拉取".

### One-liner

```bash
cd work/fcloud && python3 fetch_all_works.py [output.json]
```

Script: `work/fcloud/fetch_all_works.py` (uses `fcloud_common` for auth + cursor pagination).

### Parameters and rationale

| Setting | Value | Why |
|---------|-------|-----|
| `pageSize` | 50 | Server 30s read timeout — 50 records/page reliably under limit |
| `timeout` | 120s | Per-request timeout, handles server fluctuation |
| `retries` | 3 | ReadTimeout/ConnectionError → exponential backoff (5s/10s/15s) |
| Stop condition | `nextCursor` is None or empty | Never guess total pages |

### Known failure modes

- **Single-page timeout**: Common when server load spikes → auto-retry handles it
- **SSL EOF**: Occasional → retry recovers
- **fcloud_common import hangs**: If file-based execution hangs but inline `python3 -c "..."` works → use inline. Do not spend more than 30s diagnosing; fall back to inline.
- **Login slow**: RSA key loading + encrypted auth can take 5-10s

### Output & verification

- File: `work/fcloud/all_works_YYYYMMDD.json`
- Verify: `python3 -c "import json; d=json.load(open('all_works_YYYYMMDD.json')); print(len(d), len({r.get('accountId') for r in d}))"`
- Expected: 6000± works, 120± accounts for current fcloud instance

### Verified capacity

| Date | Works | Pages | Accounts | Size |
|------|-------|-------|----------|------|
| 2026-07-03 | 5716 | 58 | — | — |
| 2026-07-22 | 6180 | 125 | 124 | 8.2MB |

## Config requirement (CRITICAL — added 2026-07-06)

The `work/fcloud/refresh_report.py` script and all `fcloud_common` imports require `work/fcloud/config.json`. This file must exist with at minimum:

```json
{
  "endpoint": "https://prod-api.xxfcloud.com",
  "client_id": "<client-id>",
  "tenant_id": "<tenant-id>",
  "username": "<username>",
  "private_key_path": "/absolute/path/to/private_key.pem",
  "public_key": "<server-public-key-base64>",
  "lark_target_app": "KZgDbtUwgazFm1ssO9mcpsuTnXc",
  "lark_target_table": "tblUv85YfAXFKoZw",
  "lark_source_app": "GwnBbNHCfaeSgesd6QNcyXCZnNd",
  "lark_source_table": "tbl0adfIhUsJDXr1"
}
```

The private key PEM file must exist at the specified path. If config.json is missing, the cron job output will contain `RuntimeError: Missing lark_* table config`.

Values can also be set via environment variables (see `ENV_BY_KEY` in `work/phone-remote-control/fcloud/common.py`).

## Correct auth path

FCloud auth is **not** plain JSON.

Endpoint:

```text
POST https://prod-api.xxfcloud.com/auth/login
```

Required behavior:

1. Build auth body with:
   - `clientId`
   - `grantType: rsaSecret`
   - `tenantId`
   - `username`
   - `uuid`
   - `ts`
   - `sign`
   - `vid`
   - `did`
2. Signature:
   - concatenate `tenantId + username + uuid + ts`
   - SHA256 hex digest
   - RSA private-key sign digest with SHA1withRSA / PKCS1v15
   - base64 encode signature as `sign`
3. Encrypt request body:
   - random 32-character AES key
   - base64 encode AES key
   - RSA encrypt base64 AES key using FCloud server public key
   - send encrypted key in `encrypt-key` header
   - AES/ECB/PKCS7-pad JSON body, then base64 encode as HTTP body
4. Headers for auth:

```text
Content-Type: application/json; charset=UTF-8
encrypt-key: <rsa-encrypted aes key>
clientid: <client id>
```

Also include `vid` and `did` in the **auth body**. Keeping them in headers too is harmless, but putting them only in headers is insufficient.

## Account filtering (MANDATORY — CRITICAL)

**Never use raw account data from query-list without filtering.** FCloud returns all accounts including unbound, banned, empty, and test accounts.

Apply these rules before building rows:

```python
def is_valid_account(account: dict) -> bool:
    if not account:
        return False
    status = account.get('status') or 0
    if status != 0:           # 0=normal, 1=banned, 2=unbound, 3=risk-control
        return False
    follower = int(account.get('follower') or 0)
    works = int(account.get('works') or 0)
    if follower == 0 or works == 0:  # empty/test accounts
        return False
    return True
```

Status values:
- `0` = normal
- `1` = banned/frozen
- `2` = unbound (解绑)
- `3` = risk-control

Verified 2026-07-06: 盈兴 category had 15 accounts → 3 after filtering (12 filtered: 3 status=2 unbound + 9 empty/test).

## Critical pitfalls learned

- Plain JSON `/auth/login` can return `code=403 msg=没有访问权限，请联系管理员授权`; this is not enough evidence that FCloud admin permissions are missing.
- `/auth/login` docs say `请求参数加密：是`; always use encrypted request body.
- If auth returns `参数校验异常 [vid can not be blank null,did can not be blank null]`, put `vid` and `did` in the encrypted auth body.
- For subsequent API calls, use header name `clientid`, **not** `client-id`; otherwise response may be `code=401 客户端ID与Token不匹配`.
- Do not blame FCloud/admin/whitelist until encryption, `vid/did`, and `clientid` header have all been verified.
- **config.json must exist** or all fcloud_common imports will fail with `Missing FCloud config`.
- **Always filter accounts** (status/follower/works) before using query-list results. FCloud returns garbage (unbound/empty/test) accounts that inflate customer account counts.

## Account/follower data endpoint

Endpoint:

```text
POST /user-res/open-api/account/query-list
```

Only ONE account query endpoint exists in Open API. There is no `queryAccounts` or filtering parameter.

Request:

```json
{
  "pageSize": 100,
  "cursor": 0,
  "mediaApp": 2
}
```

Notes:

- `pageSize` required; max is 100.
- `cursor` optional; use `page.nextCursor` to paginate all accounts.
- `mediaApp` optional; `2` means TikTok.
- **No server-side filtering available.** All filtering (status, follower, works) must be client-side.

Response fields useful for reporting:

- `acctId` account id
- `mediaApp` social app; `2` TikTok
- `name`, `userName`
- `countryCode`
- `categoryId`, `categoryName`
- `works`
- `follower`
- `following`
- `likes`
- `views`
- `pubTime`
- `status`: `0` normal, `1` banned, `2` unbound, `3` risk-control

## Video/works data endpoint

```text
POST /user-res/open-api/resource/query-works
```

Request:

```json
{
  "pageSize": 100,
  "cursor": 0
}
```

Response includes per-video fields:

- `title` 视频标题
- `description` 作品描述
- `shares` 分享数
- `likes` 点赞数
- `comments` 评论数
- `views` 浏览数
- `pubTime` 发布时间
- `shareUrl` 分享链接
- `accountId` 关联账号ID (JOIN on account query-list)
- `coverUrl` 封面图
- `embedLink` 内嵌链接
- `id`, `localUrl`, `status`, `resourceId`

## Account statistics endpoint

Endpoint:

```text
POST /user-res/open-api/account/statistic-list
```

Request:

```json
{
  "accountIdList": [123],
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD"
}
```

Returns time-series lists for:

- views: `viewCountList`
- likes: `likesCountList`
- followers: `followerCountList`

## Pagination contract (hard rule)

**Never guess the page count. Never stop at an arbitrary round number.**

```text
DO: loop on pageSize=100, pass page.nextCursor as cursor, stop only when nextCursor is None/empty.
DON'T: for page in range(10) or max_pages=100 — data sizes change.
```

Verified 2026-07-03: 5716 works, 58 pages.
Verified 2026-07-22: 6180 works, 125 pages, 124 accounts (pageSize=50 for timeout safety).

## Bitable delivery rules

When delivering FCloud data into Feishu Bitable:

1. **Do not write into a table users are actively viewing.** Create new table and swap, or write when no one is looking.
2. **Batch insert size ≤ 50 records.** 500-record batches hit `Argument list too long`.
3. **Always verify final count after write.**
4. **Account for duplicates if writes were interrupted** — deduplicate on `shareUrl`.
5. **Use `lark-cli --as user base` commands for reading Bitable data**, not raw API GET `/records` (which may hit `RolePermNotAllow` even when access exists).
6. **Bitable permissions are per-account, not inherited.** User access ≠ bot access. Add bot as collaborator via "应用" tab in Feishu sharing dialog.

## Minimal validation gate

Before claiming FCloud is working or broken:

1. Run encrypted auth and confirm `code=200 msg=Success`.
2. Query `/user-res/open-api/account/query-list` and confirm `code=200`.
3. Verify at least one account row contains `acctId` and `follower`.
4. Apply `is_valid_account()` filter and report filtered count.
5. If any step fails, report the exact endpoint, sanitized headers/body shape, and response code/msg.

## Incident notes

### 2026-07-02

Verified successful path:

- Encrypted `/auth/login` with `vid/did` in body succeeded.
- Account query succeeded after changing data-query header from `client-id` to `clientid`.
- Returned 50 accounts including `follower`, `following`, `works`, `likes`, `countryCode`, and `status`.

### 2026-07-03

- First delivery truncated at 10 pages (1000 rows). Actual total: 5716. Learned: always full pagination.
- batch_create with 500 records hit shell `Argument list too long`; safe batch is 20–50.
- In-place table rewrite while users viewed it caused confusion.
- Process killed mid-insert left duplicates (1116), deduplicated on `shareUrl`.

### 2026-07-06

- Cron job failed 7/4–7/6 because `config.json` was missing after agent refactored `refresh_report.py` to use `fcloud_common`.
- 盈兴 data dispute: fcloud returned 15 accounts but only 3 are deliverable. Root cause: `query-list` returns ALL accounts including unbound (status=2) and empty/test (0 follower/0 works) without server-side filtering.
- Account filtering rules added: `status != 0` OR `follower == 0` OR `works == 0` → exclude.
- The `queryAccounts` endpoint mentioned by stakeholders does NOT exist in the Open API (all variants return 404). Only `query-list` is available.
- The xlsx reference file (全量导出作品数据_2026-07-02.xlsx) contains different account names from fcloud — likely from a different system, not from fcloud Open API.

### 2026-07-22

- Pagination timeout: single-page 30s read timeout hit on page 10+ even with pageSize=99. Reduced to pageSize=50, added 120s timeout + 3 retries.
- SSL EOF errors recovered by retry.
- fcloud_common module import hangs when run from file/heredoc; inline `python3 -c "..."` works as fallback.
- Success: 6180 works, 125 pages, 124 accounts, 8.2MB output.
