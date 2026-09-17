// 邮箱路由判据单测
// 运行：node --test scripts/founder-direct/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyEmailProtocol,
  isResendProxyDomain,
  isResendProxyEmail,
  planProxyMigration,
  applyProxyMigration,
  accountFileFor,
} from '../lib/email-routing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(__dirname, '..', '..', '..', 'skills', 'dealclaw-email-bindings', 'SKILL.md');

const NEVER = () => { throw new Error('mxProbe 不应被调用'); };
const MX_TRUE = async () => true;

test('代理域判据：dealclaw.io 任意子域都是代理域', () => {
  for (const d of ['dealclaw.io', 'mail.dealclaw.io', 'bde.dealclaw.io', 'send.dealclaw.io', 'x.y.dealclaw.io', 'mail.dealclaw.com']) {
    assert.equal(isResendProxyDomain(d), true, `${d} 应为代理域`);
  }
});

test('代理域判据：不误伤相似域名', () => {
  for (const d of ['notdealclaw.io', 'dealclaw.io.evil.com', 'dealclaw.com', 'gmail.com', 'meorient.com', '']) {
    assert.equal(isResendProxyDomain(d), false, `${d} 不应为代理域`);
  }
});

test('回归：bde.dealclaw.io 有 MX 也必须判 resend，且不做 MX 探测', async () => {
  const r = await classifyEmailProtocol('sales@bde.dealclaw.io', { mxProbe: MX_TRUE });
  assert.equal(r.protocol, 'resend');
  assert.equal(r.probed, false, '代理域绝不能走 MX 兜底');
  assert.equal(r.source, 'proxy-domain');
});

test('回归：注册表里的旧错误记录（代理域+smtp）被覆盖为 resend 并标记 stale', async () => {
  const registry = { 'sales@bde.dealclaw.io': { protocol: 'smtp', domain: 'bde.dealclaw.io' } };
  const r = await classifyEmailProtocol('sales@bde.dealclaw.io', { registry, mxProbe: NEVER });
  assert.equal(r.protocol, 'resend');
  assert.equal(r.stale, true);
  assert.equal(r.source, 'proxy-domain-override');
});

test('个人邮箱：已知域 → smtp，且不做 DNS 探测', async () => {
  const r = await classifyEmailProtocol('buyer@gmail.com', { mxProbe: NEVER });
  assert.equal(r.protocol, 'smtp');
  assert.equal(r.source, 'known-personal');
  assert.equal(r.probed, false);
});

test('外部未知域：MX 兜底仍然生效（有 MX → smtp）', async () => {
  const r = await classifyEmailProtocol('tian@hainel-metal.com', { mxProbe: MX_TRUE });
  assert.equal(r.protocol, 'smtp');
  assert.equal(r.probed, true);
});

test('外部未知域：无 MX → resend', async () => {
  const r = await classifyEmailProtocol('a@no-mx.example', { mxProbe: async () => false });
  assert.equal(r.protocol, 'resend');
  assert.equal(r.probed, true);
});

test('注册表对非代理域仍优先于默认归类', async () => {
  const registry = { 'a@custom-domain.com': { protocol: 'resend' } };
  const r = await classifyEmailProtocol('a@custom-domain.com', { registry, mxProbe: MX_TRUE });
  assert.equal(r.protocol, 'resend');
  assert.equal(r.source, 'registry');
});

test('发信侧同步判定：代理域 + 旧 smtp 记录 → 仍走 Resend', () => {
  const registry = { 'sales@bde.dealclaw.io': { protocol: 'smtp' } };
  assert.equal(isResendProxyEmail('sales@bde.dealclaw.io', registry), true);
  assert.equal(isResendProxyEmail('buyer@gmail.com', registry), false);
});

test('迁移计划：只挑「代理域 + 非 resend」的记录', () => {
  const registry = {
    'a@bde.dealclaw.io': { protocol: 'smtp' },
    'b@mail.dealclaw.io': { protocol: 'resend' },
    'c@meorient.com': { protocol: 'smtp' },
    'd@send.dealclaw.io': { domain: 'send.dealclaw.io' },
  };
  const plan = planProxyMigration(registry);
  assert.deepEqual(plan.map((p) => p.email), ['a@bde.dealclaw.io', 'd@send.dealclaw.io']);
  assert.equal(plan[0].from, 'smtp');
  assert.equal(plan[1].from, null);
});

test('迁移幂等：apply 之后再 plan 为空，且原注册表不被改动', () => {
  const registry = { 'a@bde.dealclaw.io': { protocol: 'smtp', bound_at: '2026-08-01', note: '旧备注' } };
  const snapshot = JSON.parse(JSON.stringify(registry));
  const next = applyProxyMigration(registry, planProxyMigration(registry), { migratedAt: '2026-09-14T00:00:00.000Z' });
  assert.deepEqual(registry, snapshot, 'apply 不能改原对象');
  assert.equal(next['a@bde.dealclaw.io'].protocol, 'resend');
  assert.equal(next['a@bde.dealclaw.io'].bound_at, '2026-08-01');
  assert.equal(next['a@bde.dealclaw.io'].migrated_from, 'smtp');
  assert.equal(next['a@bde.dealclaw.io'].note.includes('旧备注'), true);
  assert.deepEqual(planProxyMigration(next), []);
});

test('account 文件名与 bind-email.mjs 历史规则一致', () => {
  assert.equal(accountFileFor('A.B@mail.dealclaw.io'), 'a_b_mail_dealclaw_io.json');
});

test('文档与代码判据一致：SKILL.md 必须写通配代理域', () => {
  const md = readFileSync(SKILL, 'utf8');
  assert.match(md, /\*\.dealclaw\.io/, 'SKILL.md 必须写明 *.dealclaw.io 通配代理域');
  assert.doesNotMatch(md, /唯一的代理域/, '不应再出现「只有 mail.dealclaw.io」的说法');
});
