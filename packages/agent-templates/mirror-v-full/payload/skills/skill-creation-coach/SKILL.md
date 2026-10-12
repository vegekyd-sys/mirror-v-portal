---
name: "skill-creation-coach"
description: "Add quick coach preflight for skill proposals"
---

# Skill Creation Coach

## Purpose

Help contributors create and revise OpenClaw skills that amplify model judgment instead of turning the model into a rigid process executor.

Use this skill when a user asks to create, revise, review, standardize, or promote a reusable skill, workflow, playbook, durable procedure, or Skill Workshop proposal.

## Quick Preflight — Read This First

Before drafting or submitting any durable skill/workflow/procedure proposal, run this fast check. If any answer is weak, fix that part before using Skill Workshop.

### 1. Reusable Trigger

- What future user request should trigger this skill?
- What should NOT trigger it?
- Is this more than a one-off prompt?

If the trigger is unclear or only describes today’s task, keep it as memory/example instead of a skill.

### 2. Capability Amplified

State the useful reusable kernel in one sentence:

> This skill helps the model do `_____` better by providing `_____`.

Good kernels include judgment, routing, safety boundaries, failure handling, validation, or reusable tool knowledge. Weak kernels are just long task instructions.

### 3. Judgment vs. Machine Rules

Separate:

- **Model judgment**: choices the agent should make at runtime.
- **User gates**: choices requiring confirmation.
- **Machine contracts**: exact schemas, commands, or tool calls that must not vary.

If everything is a numbered mandatory sequence, rewrite into phases, decision criteria, and validation gates.

### 4. Background / Worker Routing

Classify the workflow:

- **Light**: quick explanation, lookup, short check, simple validation → run synchronously.
- **Mixed**: quick branches plus heavy branches → encode routing criteria.
- **Background-worthy**: long/polling/resourceful/paid-runtime/deploy/browser/cloud-phone/media/batch work → parent session should submit child work and remain responsive.

For background-worthy branches, require:

- parent = acknowledge / queue / final delivery
- child = execute / artifact / structured result
- child does not send user-visible chat directly unless explicitly delegated
- cleanup obligations are explicit
- validation evidence is required
- delivery failure is tracked as a first-class state

### 5. Sibling Coverage

Search nearby or related skill names when changing routing, safety, credentials, delivery, or background behavior.

Report each sibling as:

- updated now
- needs separate proposal
- intentionally not changed because scope differs
- blocked / not found

Do not fix one skill in a workflow family and silently leave another with conflicting behavior.

### 6. Boundaries and Stop Conditions

Add explicit ask/stop/refuse conditions for:

- external sends or publication
- destructive operations
- credentials or private data
- paid/scarce resources
- ambiguous user intent
- missing assets/data
- low-confidence or unsafe outputs

### 7. Failure Modes and Validation

For operational skills, include the smallest meaningful validation gate:

- test/build/lint
- rendered-output inspection
- URL/status verification
- task/background status check
- cleanup confirmation
- direct statement of why validation cannot run

Also define what to report when APIs are flaky, child workers time out, delivery fails, or artifacts are partial.

## Core Principle

A skill is not a process manual. A skill is a capability amplifier.

Good skills improve judgment, preserve creative room, clarify boundaries, reduce repeated user explanation, make good outcomes easier to reproduce, and keep interactive channels responsive when work becomes lane-blocking or resourceful.

## Trigger Conditions

Read and apply this skill when the task involves any of the following:

- creating a new skill
- updating or revising an existing skill
- reviewing a skill draft
- turning a repeated workflow into reusable instructions
- deciding whether something deserves to become a skill
- writing a playbook, SOP, durable workflow, or reusable agent procedure
- using Skill Workshop to create/update/revise a proposal

Do not use this skill for one-off normal task execution unless the user explicitly wants to make the workflow reusable.

## Operating Mode

Behave as a proactive coach, not a bureaucratic reviewer.

Default posture:

- encourage good author intent
- preserve useful model autonomy
- identify where the draft is too rigid
- identify missing boundaries and failure modes
- identify whether the skill can become lane-blocking/resourceful and needs background execution routing
- identify related or sibling skills that may need the same routing/boundary treatment
- suggest concrete rewrites
- avoid turning the review itself into a rigid checklist ritual

## Review Heuristics

Assess the draft through these lenses.

### Capability Amplification

Ask what this skill helps the model do better. Prefer guidance like “Use this when…”, “Prefer X when…”, “Stop and ask when…”, and “Validate by…”. Avoid merely restating one task instance.

### Creativity Preservation

Leave room for model reasoning and adaptation. Examples should guide, not cage. Replace unnecessary absolutes with intent, decision criteria, examples, boundaries, and validation.

### Judgment Delegation

Separate runtime judgment, user confirmation gates, and deterministic machine contracts.

### Lane-Blocking / Resourceful Work Classification

Do not classify a skill as heavy merely because a step may take more than 10 seconds, takes a screenshot, or performs small validation.

Treat a branch as background-worthy when it commonly:

- holds an interactive chat/Gateway lane for long or unpredictable waits
- repeatedly polls external systems
- uses scarce or paid resources: cloud phones, browsers, GPUs, media workers, device runtimes
- starts long build/render/export/download/upload pipelines
- performs batch media generation/editing, large crawls, browser automation, or device operations
- has cleanup obligations that must run even on failure
- benefits from child execution because the parent should acknowledge quickly

For background-worthy skills, require explicit parent/child execution policy and validation evidence.

### Related Skill Coverage

When updating or reviewing routing, safety, delivery, credentials, or background execution, check sibling/adjacent skills sharing backend, product area, trigger phrases, or user intent. State what was updated, deferred, intentionally skipped, or blocked.

### Boundary Clarity

A good skill says when to stop, ask, or refuse. It does not hide risk behind helpfulness.

### Failure Modes

Add handling for ambiguous inputs, missing assets, weak tool results, flaky APIs, insufficient permissions, low-quality output, timed-out background tasks, lost child sessions, stalled worker runs, partial artifacts, and resource cleanup failures.

### Verification

Every operational skill should include a smallest meaningful validation gate. Do not claim completion based only on intent or file existence when behavior can be checked.

## Anti-Patterns

Flag and rewrite these patterns:

- **Dead Flow**: long fixed sequence for a judgment-heavy task. Rewrite into phases, decision criteria, and validation gates.
- **Prompt Disguised as Skill**: one-off prompt with no durable trigger, boundaries, or reusable knowledge.
- **Over-Constraint**: absolute language that removes useful judgment.
- **Missing Stop Conditions**: instructions say what to do but not when to pause.
- **Missing Background Routing**: long/polling/resourceful work without parent/child execution policy.
- **Incomplete Sibling Coverage**: one skill fixed while siblings keep unsafe or blocking behavior.
- **Over-Eager Backgrounding**: quick checks/screenshots/QC mislabeled as heavy by default.
- **Tool Ritual**: requiring tools when mutable state or verification does not need them.
- **Review Theater**: lots of scoring but no actionable improvement.

## Coaching Output Format

For skill review, use a concise structure:

1. Overall read.
2. What is strong.
3. Main risks, including background routing and sibling coverage when relevant.
4. Suggested rewrites.
5. Missing gates: safety, failure, verification, trigger boundaries, background execution routing, related-skill coverage.
6. Recommendation: create / revise / split / keep as memory / do not promote.

## Creation Flow

When creating a skill from scratch:

1. Run Quick Preflight.
2. Identify reusable trigger.
3. Define capability amplified.
4. Classify light/mixed/background-worthy routing.
5. Check sibling skills.
6. State core principle.
7. Add operating mode and decision criteria.
8. Add boundaries and ask/stop conditions.
9. Add failure modes and fallback behavior.
10. Add validation gates.
11. Add 1–3 examples or anti-patterns if helpful.
12. Use Skill Workshop to create/update/revise the proposal.

## Skill Workshop Integration

When the final result should be durable, use the `skill_workshop` tool rather than writing proposal files manually.

- Use `create` for a new skill proposal.
- Use `update` for an existing live skill.
- Use `revise` for an existing pending proposal.
- Do not apply, reject, or quarantine proposals unless the user explicitly asks.

When updating core workspace documents such as AGENTS.md, SOUL.md, REDLINES.md, or MEMORY.md, show an exact diff and get explicit confirmation before applying.

## Good Skill Traits

- clear trigger conditions
- memorable core principle
- model judgment preserved where useful
- exactness only where necessary
- explicit risk boundaries
- background routing judgment when relevant
- related-skill consistency when part of a workflow family
- failure modes and fallback paths
- validation gate
- examples that guide without caging

## Tone

Be direct, constructive, and practical. Avoid shaming contributors; help them create better reusable cognition.
