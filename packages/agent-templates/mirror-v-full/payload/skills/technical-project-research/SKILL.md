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

## Repository Evidence (when the target is a GitHub project)

- Resolve the repository from `api.github.com/search/repositories?q=<name>&sort=stars` and use the returned `full_name` and `stargazers_count`; never construct or trust a URL supplied in the request — near-identical names are common (`hmjz100/LinkSwift` vs `hmjs100/LinkSwift`).
- Read shape and maintenance from `/repos/{owner}/{repo}`, `/contents/`, `/commits?per_page=15`, `/issues?state=all&sort=updated`, `/releases`; these answer "script vs CLI", activity, and current breakage without cloning.
- Oversized `web_fetch` responses spill to `/tmp/openclaw-web-fetch-*.log`; parse that file locally with `json.JSONDecoder().raw_decode` (some single-item responses carry trailing text) and print only `number/state/created_at/title`.
- Never print a full minified bundle or `.user.js`: one embedded base64 data URI floods the read and truncates it. Use `grep -oE 'https?://[^/"]+' | sort | uniq -c`, `grep -oE ... | cut -c1-160`, or `grep -c` for endpoints and counts.
- Tie every claim to a concrete identifier (issue number, file path, config key); mark anything not actually read as 未证实 rather than inferring it.

## Business API Trials

1. Choose a small sample matching the intended customer's product, country, and workflow; define business acceptance criteria before spending. Keep the evaluated product's records separate from any downstream product used only as a comparison.
2. For buyer discovery, validate in order: company location, channel role, and product fit from source evidence; then contact responsibility and current company; then email identity/domain and verification status. Spend on contact enrichment only after the company passes. Keep company candidates, role-matched contacts, and verified work emails as separate deliverables; import activity or current buying intent requires its own evidence.
3. When routed results do not meet those criteria, test an explicitly selected provider on the same request and reapply business checks. If a provider accepts only natural-language queries, put geography and role constraints in the query and verify them afterward; do not describe this as enforced structured filtering.
4. Close the trial by reconciling per-request charges with starting/ending balance and outstanding holds. Preserve selected provider, latency, business acceptance, and verification verdicts in redacted evidence, including rejected or unusable results. Calculate cost per qualified result only when at least one result meets the predefined standard.

## Provider Services Exposed Through Another Agent

When asked to bring a platform's partner services into our own agent, research each service provider's current official developer portal, Skill/MCP repository, and user-authorization entry directly; the host platform's integration docs alone do not settle availability. Separate publishing our service into that platform from consuming its partners externally. Classify the interfaces found by consumer vs merchant/enterprise access and by actual operations: search, quote, order creation, payment handoff, status, cancellation/refund. Verify operations against source or documented tools rather than promotional examples such as “book”; report missing public entry points as “not found in this review,” not proof of exclusivity or nonexistence. Finish with the available application path and a read-only or preview test before any real transaction.
