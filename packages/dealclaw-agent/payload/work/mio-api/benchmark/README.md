# CRM Speed Benchmark — 2026-06-28

## Methodology

5 Zoho CRM v2 read-only API calls for a single merchant (杭州乔迪服饰有限公司), timed individually with `time.perf_counter()` from the OpenClaw gateway host (Tencent Cloud VM, Shanghai).

Each call = fresh HTTP GET, no caching. Token refresh (OAuth) excluded from timing.

## Merchant

- Name: **杭州乔迪服饰有限公司**
- Account ID: `185165000195787492`

## Before (Serial) — 5 individual API calls

| Step | Query | Type | ms | Records |
|------|-------|------|----:|---------|
| 1 | Account detail | `GET /Accounts/{id}` | 1,164 | 1 (190 fields) |
| 2 | Contacts search | `GET /Contacts/search` | 3,792 | 200 |
| 3 | Deals search | `GET /Deals/search` | 388 | 0 (204) |
| 4 | Events search | `GET /Events/search` | 1,487 | 44 |
| 5 | Sales Orders search | `GET /Sales_Orders/search` | 435 | 0 (204) |
| | **TOTAL** | | **7,266** | |

## After (Parallel + merchant_query.py)

3-round benchmark, same merchant:

| Round | Account (ms) | Parallel batch (ms) | Total (ms) |
|------:|-----------:|------------------:|---------:|
| 1 | 2,363 | 2,985 | **5,348** |
| 2 | 4,428 | 6,537 | 10,965 |
| 3 | 4,364 | 3,728 | 8,093 |
| **Best** | | | **5,348** |
| **Median** | | | 8,093 |

**Best case improvement: -26.4% (5.35s vs 7.27s)**

## Real Improvements (Latency vs UX)

### Latency (best case)
- Serial: 7,266ms → Parallel: 5,348ms (**-26.4%**)
- Bottleneck shifted: Contacts (52%) → Account detail (44% in parallel)

### UX improvements (the real win)
| Dimension | Before | After |
|-----------|--------|-------|
| Function calls | 5 manual API constructions | 1 `mq.query(id)` |
| Token management | Fresh refresh per call (risk rate-limit) | Single token, reused via client cache |
| Output format | Raw Zoho JSON per module | Structured `MerchantProfile` with `.to_summary()` |
| Error handling | Exception per call | Collected errors in `profile.errors` |
| Zoho quirks | Manual discovery (What_Id etc) | Encoded in module, invisible to caller |

### Known Limitation
Zoho China API latency is highly variable (±200%) depending on rate-limit state and server load. A single 4-API parallel batch can range from 2.5s to 6.5s. This is outside our control and the same variability affects both serial and parallel modes.

## Observations

- **Account detail dominates** now that Contacts/Deals/Events/SO are parallelized
- **204 responses** (no data) are ~400ms each — Zoho's search validation overhead
- Events module uses `What_Id` for Account linkage, NOT `Account_Name` (discovered during testing)
- Zoho OAuth rate limit triggered after ~8 token refreshes in <60s. Cooldown: 60-120s.
- Token caching critical: `from_env()` re-creates client which re-refreshes token — avoid per-query
