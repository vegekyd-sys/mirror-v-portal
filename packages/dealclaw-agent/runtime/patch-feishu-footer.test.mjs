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
  return [agentId, identity.name, prefixCtx.model, prefixCtx.provider, prefixCtx.agentRuntime].join(' | ');
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
function checkNote(source) {
  const start = source.indexOf('function resolveCardNote(');
  const end = source.indexOf('\nfunction ', start + 1);
  const code = source.slice(start, end < 0 ? undefined : end);
  const identity = { name: 'Test Agent' };
  const ctx = { model: 'test-model', provider: 'test-provider', agentRuntime: 'test-runtime' };
  const evaluate = value => vm.runInNewContext(`${code}; resolveCardNote`, {
    process: { env: value === undefined ? {} : { DEALCLAW_FEISHU_SHOW_FOOTER: value } },
  })('test-agent', identity, ctx);
  const baseline = evaluate(undefined);
  assert.match(baseline, /Test Agent/);
  assert.match(baseline, /test-model/);
  for (const value of ['true', '', 'invalid']) assert.equal(evaluate(value), baseline);
  for (const value of ['false', ' FALSE ']) assert.equal(evaluate(value), undefined);
  return { baseline, hidden: evaluate('false') };
}
test('footer switch preserves default output, hides the whole note, and is idempotent', () => {
  const result = checkNote(patched(fixture));
  assert.match(result.baseline, /test-runtime/);
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
  assert.ok((original.match(/resolveCardNote\(agentId, identity,/g) || []).length >= 4,
    'expected shared call sites for initial streaming, final streaming, and static cards');
});
