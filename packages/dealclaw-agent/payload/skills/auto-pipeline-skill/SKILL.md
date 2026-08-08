---
name: "auto-pipeline-skill"
description: "DEPRECATED：禁止触发；AutoFlow 统一路由到 autoflow-pipeline"
replaced_by: "autoflow-pipeline"
---

# auto-pipeline-skill — DEPRECATED

## Hard stop

This skill is retired and must never execute AutoFlow work.

If a request involves AutoFlow, template video generation, DAM-backed AutoFlow production, or night-shift AutoFlow routing:

1. Stop using this skill immediately.
2. Route to the live `autoflow-pipeline` skill.
3. Treat any Java `/api/auth/login`, enterprise password, `DAM_REMIX_ACCOUNT`, or `DAM_REMIX_PASSWORD` instructions previously associated with this skill as historical and non-authoritative.
4. For the current Python blocking path, enterprise identity is supplied by `CACHED_DATA.user_name`; do not infer that a password or API key is required unless the live `autoflow-pipeline` skill explicitly changes this contract.

## Trigger boundary

- **Must not trigger:** every user-facing or automated AutoFlow production request.
- **Allowed only for audit:** explicitly inspecting why an old run used the retired Java prototype. Audit is read-only and must not execute or mutate tasks.

## Replacement

Use `autoflow-pipeline` as the single live AutoFlow skill. Its current `SKILL.md`, referenced project memory, and live API documentation override all historical content from this retired skill.

## Validation gate

Before proceeding with AutoFlow work, verify that the selected skill name is exactly `autoflow-pipeline`. If both skill names appear in context, choose `autoflow-pipeline` and report the sibling as deprecated.

## Safety

Do not delete historical tasks or artifacts merely because they were created through the retired path. Stop, preserve evidence, and resume only through the live skill under the applicable Base/Cron authorization gates.
