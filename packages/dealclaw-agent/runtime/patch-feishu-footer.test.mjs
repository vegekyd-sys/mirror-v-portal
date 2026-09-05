import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./patch-feishu-footer.mjs', import.meta.url));
const fixture = `function resolveCardNote(agentId, identity, prefixCtx) {
\tconst parts = [\`Agent: \${identity?.name?.trim() || agentId}\`];
\tif (prefixCtx.model) parts.push(\`Model: \${prefixCtx.model}\`);
\tif (prefixCtx.provider) parts.push(\`Provider: \${prefixCtx.provider}\`);
\tif (prefixCtx.agentRuntime) parts.push(\`Runtime: \${prefixCtx.agentRuntime}\`);
\treturn parts.join(" | ");
}
function createFeishuReplyDispatcher() {}`;
function patched(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-footer-test-'));
  const file = path.join(dir, 'monitor.account-test.mjs');
  fs.writeFileSync(file, source);
  execFileSync(process.execPath, [script, '--file', file]);
  const first = fs.readFileSync(file, 'utf8');
  execFileSync(process.execPath, [script, '--file', file]);
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'patch must be idempotent');
  return first;
}
function noteFunction(source, env = {}) {
  const start = source.indexOf('function resolveCardNote(');
  const end = source.indexOf('\n}', start) + 2;
  const code = source.slice(start, end);
  return vm.runInNewContext(`${code}; resolveCardNote`, { process: { env } });
}
function checkNote(source) {
  const identity = { name: 'Test Agent' };
  const ctx = { model: 'test-model', provider: 'test-provider', agentRuntime: 'test-runtime' };
  const evaluate = value => noteFunction(source,
    value === undefined ? {} : { DEALCLAW_FEISHU_SHOW_FOOTER: value })('test-agent', identity, ctx);
  const baseline = evaluate(undefined);
  assert.equal(baseline, 'Agent: Test Agent');
  for (const value of ['true', '', 'invalid']) assert.equal(evaluate(value), baseline);
  for (const value of ['false', ' FALSE ']) assert.equal(evaluate(value), undefined);
  return { baseline, hidden: evaluate('false') };
}
function checkCombinations(source, labels) {
  const identity = { name: 'V | Model: name-text' };
  const ctx = { model: 'gpt-example', provider: 'example', agentRuntime: 'codex' };
  const parts = ['Agent: V | Model: name-text', 'Model: gpt-example', 'Provider: example', 'Runtime: codex'];
  for (let mask = 0; mask < 16; mask++) {
    const env = {};
    ['Agent', 'Model', 'Provider', 'Runtime'].forEach((label, i) => {
      env[`DEALCLAW_FEISHU_SHOW_${label.toUpperCase()}`] = mask & (1 << i) ? 'true' : 'false';
    });
    const expected = parts.filter((_, i) => labels.includes(['Agent', 'Model', 'Provider', 'Runtime'][i]) && (mask & (1 << i))).join(' | ') || undefined;
    assert.equal(noteFunction(source, env)('agent', identity, ctx), expected, `combination ${mask}`);
    env.DEALCLAW_FEISHU_SHOW_FOOTER = 'false';
    assert.equal(noteFunction(source, env)('agent', identity, ctx), undefined, 'whole-footer switch takes precedence');
  }
}
test('footer defaults to Agent only, supports whole-note hiding, and is idempotent', () => {
  const source = patched(fixture);
  checkNote(source);
  for (const value of [undefined, '', 'invalid']) {
    const env = Object.fromEntries(['AGENT', 'MODEL', 'PROVIDER', 'RUNTIME'].map(key => [`DEALCLAW_FEISHU_SHOW_${key}`, value]));
    assert.equal(noteFunction(source, env)('agent', { name: 'Test' }, {
      model: 'model', provider: 'provider', agentRuntime: 'codex',
    }), 'Agent: Test');
  }
  assert.equal(noteFunction(source, { DEALCLAW_FEISHU_SHOW_MODEL: ' TRUE ' })(
    'agent', { name: 'Test' }, { model: 'model', provider: 'provider', agentRuntime: 'codex' },
  ), 'Agent: Test | Model: model');
});
test('v2 all-visible defaults upgrade to Agent-only without losing overrides', () => {
  const current = patched(fixture);
  const old = current.replace('dealclaw-feishu-footer-toggle-v3', 'dealclaw-feishu-footer-toggle-v2')
    .replace(`\t\tif (!label) return true;
\t\tconst value = process.env[visibilityKeys[label]]?.trim().toLowerCase();
\t\tif (value === "true") return true;
\t\tif (value === "false") return false;
\t\treturn label === "Agent: ";`,
      '\t\treturn !label || process.env[visibilityKeys[label]]?.trim().toLowerCase() !== "false";');
  const upgraded = patched(old);
  checkNote(upgraded);
  checkCombinations(upgraded, ['Agent', 'Model', 'Provider', 'Runtime']);
});
test('all 16 field combinations preserve values and separators, including Runtime', () => {
  const source = patched(fixture);
  checkCombinations(source, ['Agent', 'Model', 'Provider', 'Runtime']);
  const env = { DEALCLAW_FEISHU_SHOW_AGENT: ' FALSE ' };
  assert.equal(noteFunction(source, env)('agent', {}, {}), undefined, 'missing metadata is not fabricated');
});
test('v1 whole-footer patch upgrades to independent switches without duplicate gates', () => {
  const v1 = fixture.replace('function resolveCardNote(agentId, identity, prefixCtx) {',
    'function resolveCardNote(agentId, identity, prefixCtx) {\n\t// dealclaw-feishu-footer-toggle-v1\n\tif (process.env.DEALCLAW_FEISHU_SHOW_FOOTER?.trim().toLowerCase() === "false") return undefined;');
  const source = patched(v1);
  assert.ok(!source.includes('dealclaw-feishu-footer-toggle-v1'));
  checkCombinations(source, ['Agent', 'Model', 'Provider', 'Runtime']);
});
test('unknown bundle is rejected without modification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-footer-test-'));
  const file = path.join(dir, 'unknown.mjs');
  fs.writeFileSync(file, 'export const unknown = true;');
  assert.throws(() => execFileSync(process.execPath, [script, '--file', file], { stdio: 'pipe' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const unknown = true;');
});
test('official installed bundle uses the same footer gate for all reply paths', {
  skip: !process.env.FEISHU_TEST_PLUGIN_ROOT,
}, () => {
  const dist = path.join(process.env.FEISHU_TEST_PLUGIN_ROOT, 'dist');
  const file = fs.readdirSync(dist).find(name => /^monitor\.account-.*\.js$/.test(name));
  const original = fs.readFileSync(path.join(dist, file), 'utf8');
  const result = patched(original);
  const notes = checkNote(result);
  checkCombinations(result, ['Agent', 'Model', 'Provider']);
  const rendererFile = fs.readdirSync(dist).find(name => /^send-.*\.js$/.test(name)
    && fs.readFileSync(path.join(dist, name), 'utf8').includes('function buildStructuredCard('));
  const renderer = fs.readFileSync(path.join(dist, rendererFile), 'utf8');
  const start = renderer.indexOf('function buildStructuredCard(');
  const end = renderer.indexOf('\n}', start) + 2;
  const build = vm.runInNewContext(`${renderer.slice(start, end)}; buildStructuredCard`, {
    resolveFeishuCardTemplate: value => value,
  });
  const header = { title: 'Keep title', template: 'blue' };
  const shown = build('Keep body', { header, note: notes.baseline });
  const hidden = build('Keep body', { header, note: notes.hidden });
  assert.equal(shown.body.elements.length, 3);
  assert.equal(hidden.body.elements.length, 1, 'hidden note must also remove separator');
  assert.equal(hidden.body.elements[0].content, 'Keep body');
  assert.equal(hidden.header.title.content, 'Keep title');
  const allHidden = noteFunction(result, {
    DEALCLAW_FEISHU_SHOW_AGENT: 'false', DEALCLAW_FEISHU_SHOW_MODEL: 'false',
    DEALCLAW_FEISHU_SHOW_PROVIDER: 'false', DEALCLAW_FEISHU_SHOW_RUNTIME: 'false',
  })('agent', {}, { model: 'model', provider: 'provider' });
  assert.equal(build('Keep body', { header, note: allHidden }).body.elements.length, 1);
  assert.ok((original.match(/resolveCardNote\(agentId, identity,/g) || []).length >= 4,
    'expected shared call sites for initial streaming, final streaming, and static cards');
});
