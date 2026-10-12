---
name: "memory-promotion-audit"
description: "Audit LLM Wiki promotion safely; produce additive, rollback-safe upgrades without damaging existing memory."
---

# Memory Promotion Audit

Use when reviewing or upgrading an LLM Wiki, reflection-to-memory pipeline, promotion queue, memory lint, or retrieval indexing.

## Procedure

1. Trace the implemented write path from raw logs through candidate creation, review states, promoted pages, indexes, and retrieval registration; distinguish names shown in reports from the behavior the code actually performs. Complete when each counter is mapped to a concrete mutation or lookup mechanism.

2. Measure the current system read-only: count proposal states and destinations, sample oldest and newest candidates, classify lint output by cause, and test retrieval with one known promoted page. Complete when backlog, structural errors, index coverage, and searchability are reported separately.

3. Reclassify queued candidates using the current routing logic before proposing bulk action. Treat identical historical review reasons as stale metadata when candidate content routes to different types. Complete when every proposed bulk operation has a dry-run disposition such as merge, review, skip, supersede, or blocked.

4. Inspect the platform's native memory or wiki capability before expanding a custom promotion script. Compare its provenance, contradiction handling, compilation, retrieval corpus, and rollback boundaries with the existing pipeline. Complete when the design states which layer remains source of truth and which layer is derived.

5. Design the upgrade as additive layers: preserve raw observations, keep candidates as auditable records, merge durable knowledge into canonical entity or project pages, and compile a separate retrieval-oriented wiki. Do not equate Markdown navigation links with search indexing. Complete when source evidence and target ownership are explicit for every promoted claim.

6. Protect existing units with a shadow rollout: no move, delete, overwrite, or mass reformat; use a separate compiled vault or namespace; disable prompt injection from the new layer initially; retain a one-step rollback. Complete when the old retrieval path continues to work unchanged.

7. Separate health signals: structural errors, review backlog, unindexed canonical pages, generated/work files, workspace dirtiness, and new regressions must not share one permanent red status. Complete when alerts can identify a newly introduced problem without being masked by known debt.

8. Validate before cutover with known-answer retrieval tests, provenance checks, duplicate rate, contradiction detection, latency, and rollback verification. Enable combined retrieval or prompt consumption only after the shadow layer passes the agreed gates.

## Guardrails

- Bulk clearing is not success unless each item has an auditable disposition.
- Never infer search registration from a filename, link count, or a field named `indexed` or `reindexed`; prove it with the actual retrieval interface.
- Preserve superseded facts with temporal or status metadata when history matters.
- Configuration changes, plugin activation, restarts, destructive cleanup, and core-memory edits require their normal approval gates.
