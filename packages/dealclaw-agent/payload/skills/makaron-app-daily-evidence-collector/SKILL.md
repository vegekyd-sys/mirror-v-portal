---
name: "makaron-app-daily-evidence-collector"
description: "Makaron.app每日证据包只读收集器方案"
package: makaron-app
kind: implementation-spec
aliases:
  - makaron-daily-evidence-collector
---

# Makaron App Daily Evidence Collector

This is a read-only implementation proposal for Makaron.app daily self-iteration evidence. It is not a normal user-facing skill and does not change production runner behavior by itself.

## Why

Makaron daily review is useful but too manual. Evidence currently lives across:

- `tmp/makaron-active-tasks.json`
- `tmp/makaron-jobs/*.json`
- `tmp/makaron-worker-logs/*.log`
- project memory notes
- Feishu/session history

Risks:

- accepted / reroll / revision signals can be missed;
- review-sidecar decisions are visible in card outputs but not normalized;
- worker metadata and final run status live separately;
- daily reports over-rely on manual session reading;
- active registry mixes dates/projects, making counts noisy.

## Scope

Create a read-only collector for Makaron.app daily evidence.

Inputs:

1. active task registry: `tmp/makaron-active-tasks.json`;
2. worker jobs: `tmp/makaron-jobs/*.json`;
3. worker logs: `tmp/makaron-worker-logs/*.log`;
4. review-sidecar evidence from registry/logs;
5. feedback signals from card actions and future structured feedback sink;
6. optional Feishu context only when local evidence is insufficient.

Outputs:

```text
work/makaron-daily-evidence/YYYY-MM-DD/evidence.json
work/makaron-daily-evidence/YYYY-MM-DD/evidence.jsonl
work/makaron-daily-evidence/YYYY-MM-DD/summary.md
```

The collector must not send messages, edit cards, trigger Makaron, mutate registry, apply skills, or restart workers.

## Non-goals

- No production runner modification in this step.
- No automatic skill application.
- No automatic Makaron reruns.
- No Feishu message spam.
- No storing secrets or raw private prompts beyond already-local task evidence.
- No replacing V’s judgment; collector provides evidence and V writes recommendations.

## Proposed CLI

```bash
node scripts/makaron-card-runner/collect-daily-evidence.cjs \
  --date 2026-06-15 \
  --out work/makaron-daily-evidence/2026-06-15 \
  --chat <GROUP_ID>
```

Options:

- `--date YYYY-MM-DD`, default Asia/Shanghai today;
- `--out <dir>`, default `work/makaron-daily-evidence/<date>`;
- `--chat <oc_xxx|ou_xxx>` optional filter;
- `--include-memory` optional read-only memory note references;
- `--json` print final summary JSON to stdout;
- `--strict` fail if any source cannot be parsed.

## Evidence Schema

Each task should normalize to fields:

- date, taskId, chatId, cardId, title, sanitized brief;
- status: `delivered|accepted|revision|failed|blocked|in_progress|unknown`;
- phase, timestamps, projectId, projectUrl;
- jobPaths, logPaths, runIds, expected output type, sentAssets;
- reviewSidecar enabled/gateContinues/decisions;
- feedback accepted/lastCardAction/writtenFeedback;
- risks;
- evidence source paths.

## Classification Rules v0

Status normalization:

- `accepted` if registry `accepted === true` or `lastCardAction === positive_acceptance`;
- `revision` if `lastCardAction === revision_request` or output/log mentions reroll/revision;
- `failed` if registry `failed === true` or worker summary contains failed/error;
- `blocked` if status contains `执行受阻`, missing Makaron key, or no project after worker handoff;
- `delivered` if `done === true` and assets were sent but no acceptance;
- `in_progress` if `done !== true` and `failed !== true` with recent update;
- `unknown` otherwise.

Risk tags:

- `text_logo_risk`
- `ip_risk`
- `crop_material_risk`
- `motion_realism_risk`
- `delivery_verification_risk`

## Implementation Phases

### Phase 0 — read-only prototype

Add `scripts/makaron-card-runner/collect-daily-evidence.cjs`.

Prototype steps:

1. read registry safely;
2. filter tasks whose `createdAt` or `updatedAt` falls within the Asia/Shanghai day;
3. read matching job files by filename date and/or cardId/chatId;
4. read matching worker logs and parse final JSON summaries;
5. merge registry + job + worker summaries by `cardId`, then `chatId + projectUrl`, then date proximity;
6. extract review-sidecar decisions from registry outputs;
7. write JSON/JSONL/Markdown summary;
8. never mutate source files.

### Phase 1 — daily review integration

Update Makaron daily review prompt/job to use evidence package first.

### Phase 2 — structured feedback sink

Separate later proposal for sidecar decision JSONL, final prompt correction, feedback reason, media URLs, and delivery verification.

## Validation Gates

Before implementation is reported complete:

1. run collector for a known historical date;
2. confirm known worker jobs appear;
3. confirm review-sidecar decisions are extracted when present;
4. confirm source files unchanged;
5. confirm report identifies delivered/accepted/revision/blocked tasks;
6. run `node --check scripts/makaron-card-runner/collect-daily-evidence.cjs`.

## Safety / Privacy

- Read-only only.
- Do not include secrets or env vars.
- Avoid dumping full raw prompts in Markdown summary; use short sanitized briefs.
- Keep full evidence paths local.
- Feishu history reads are optional and minimal.

## Package Note

This proposal belongs to the future `makaron-app` package, likely under implementation-spec. Applying it should mean approval to implement Phase 0 only, not to mutate production runner behavior.
