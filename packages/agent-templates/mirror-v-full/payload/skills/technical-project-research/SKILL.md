---
name: "technical-project-research"
description: "调研 MCP、开源项目或技术产品时，先解释它主要做什么，再给能力、边界、认证与风险结论。"
---

# Technical Project Research

## Procedure

1. Identify the exact project, provider, repository, or product variant before comparing capabilities; finish when the evaluated target and any material alternatives are named separately.
2. Lead the user-facing result with a plain-language purpose statement: “This is mainly used to …”; finish when a non-specialist can understand the primary job without knowing its protocol, authentication, or risks.
3. Give 2–4 concrete example requests or workflows immediately after the purpose; finish when the user can picture how they would use it.
4. State the functional boundary next: list the main supported actions and the important things it does not do; finish when similarly named but distinct products cannot be confused.
5. Only then explain implementation shape, authentication, permissions, credential reuse, maturity, compliance, and security risks; finish when each conclusion is tied to first-party documentation or inspected source.
6. End with a direct adoption recommendation and the safest small validation path; finish when the reader knows whether to adopt, avoid, or test and which credential class must remain isolated.

## Output Order

1. One-sentence primary purpose
2. Concrete use examples
3. Capabilities and non-capabilities
4. Authentication and credential-reuse answer
5. Security, compliance, and maturity risks
6. Recommendation and minimal validation plan

## Verification

Before sending, check that the opening paragraph answers “what is this mainly for?” without leading with repository internals, policy caveats, or credential details.
