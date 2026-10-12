---
name: "openclaw-harness-evaluation"
description: "Evaluate whether external coding agents can serve as OpenClaw harnesses and choose ACPX versus native integration."
---

# OpenClaw Harness Evaluation

## Procedure

1. Resolve the exact external-agent project and repository before evaluating it; distinguish similarly named assistants, CLIs, and coding agents, and record the assumed identity when the request is ambiguous enough to affect the result.

2. Inspect the installed OpenClaw documentation and source before external-agent materials; identify the current extension surfaces and their contracts, then verify the installed version and feature availability without changing configuration or installing packages. Complete this step when the analysis separates native `AgentHarnessV2`, ACP/ACPX external agents, and plain CLI backends instead of treating them as equivalent.

3. Extract the native harness contract from primary OpenClaw sources. Check runtime selection, session/thread mapping, streaming events, tool-call representation, dynamic tools, approvals and hooks, cancellation, usage, terminal status, replay safety, fallback behavior, sandboxing, authentication, compaction, fork/reset/dispose, and optional runtime capabilities. Complete this step with source paths for every load-bearing claim.

4. Check OpenClaw's ACP/ACPX documentation and built-in target aliases before proposing custom code. Determine whether the external agent is already supported, how it is launched, whether persistent sessions can be bound or resumed, and which controls such as stream, steer, cancel, and background execution are exposed. Complete this step when existing product support is clearly separated from theoretical protocol compatibility.

5. Inspect only official or primary external-agent sources for programmable interfaces. Prefer native ACP documentation, then server/SDK/RPC documentation, session lifecycle, event streaming, cancellation, permissions, custom tools, MCP support, and adapters maintained in the agent's ecosystem. Treat adapter maturity and limitations as separate evidence from the underlying agent's capabilities.

6. Score two integration paths independently: existing ACPX integration and a native `AgentHarnessV2` plugin. For each path, state what already works, missing contract items, security-boundary mismatches, expected maintenance surface, and whether OpenClaw policy can be enforced without bypassing hooks or approvals.

7. Recommend the smallest reversible validation path. Default to ACPX when it already covers session persistence, streaming, cancellation, and required controls; recommend a native harness only when the request requires model-level runtime routing, exact OpenClaw dynamic tools, full approval/hook parity, sandbox parity, or native-only capabilities. Keep installation, service startup, configuration edits, and Gateway restart behind a separate approval gate.

8. Verify the local readiness state with read-only checks and report it explicitly: OpenClaw version, ACPX availability, target executable availability, and whether any test was actually run. Never present documented support as a successful local PoC.

## Output

Deliver:
- a concise verdict for ACPX and native integration separately;
- the OpenClaw harness contract checklist with source locations;
- a capability and gap comparison for each candidate agent;
- security, sandbox, fallback, and duplicate-side-effect risks;
- a minimal PoC proposal with acceptance criteria and approval boundaries.
