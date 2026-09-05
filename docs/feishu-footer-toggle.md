# Feishu reply footer visibility

`DEALCLAW_FEISHU_SHOW_FOOTER=false` hides the entire automatic reply-card note
(Agent / Model / Provider, plus any Runtime field present in the plugin).
`true` or an unset variable enables the footer with the field defaults below.
Case and surrounding whitespace are ignored. Unknown/empty field values use
their field default; an unknown/empty whole-footer value leaves it enabled.

Four independent switches select which existing fields to display:

```text
DEALCLAW_FEISHU_SHOW_AGENT=true
DEALCLAW_FEISHU_SHOW_MODEL=false
DEALCLAW_FEISHU_SHOW_PROVIDER=false
DEALCLAW_FEISHU_SHOW_RUNTIME=false
```

The values above are the built-in defaults: only Agent is shown when no keys
are configured. Explicit `true`/`false` overrides each field independently;
for example, setting SHOW_MODEL to `true` also shows Model. Setting all four to `false` removes
the note and its separator. The whole-footer switch takes precedence over the
four field switches. Labels remain in Agent / Model / Provider / Runtime order;
hidden fields leave no extra separators. Field values still come from the real
reply context, not from these switches. The v3 patch automatically upgrades
existing v1/v2 patches in the trusted PVC copy. Previously explicit values
continue to take precedence over the new defaults.

This controls the generated note only, not the card title, reply body, typing
indicator, tool status, or user-authored card footers. It covers initial streaming,
final streaming, and static reply cards via the shared `resolveCardNote` function.
It does not add a Runtime field to plugin versions that do not have one.

Set the key in Nexus runtime configuration (global or per-tenant override), ensure
the tenant's agent process receives the environment variable, and restart the
agent after applying configuration. Updating only the mounted skill-env file does
not update the environment of an already-running gateway. Historical cards are
not rewritten; the new setting applies to subsequent replies.

The image fallback is patched at build time in both Dockerfiles (this repository
and aochi). The trusted PVC plugin is patched after install and before gateway
startup. Both repositories' changes must be included in the new agent image.
The patch is idempotent and rejects unknown bundle shapes instead of silently
ignoring the requested visibility. Do not bypass that check during upgrades.

Verification against an extracted official plugin package:

```bash
node --test packages/dealclaw-agent/runtime/patch-feishu-footer.test.mjs
```

Set `FEISHU_TEST_PLUGIN_ROOT` to the extracted package directory to additionally
test against its actual monitor bundle and static-card renderer.
Before rollout acceptance, verify one shown and one hidden streaming reply in a
test tenant. Local bundle checks do not constitute a live Feishu UI acceptance.
