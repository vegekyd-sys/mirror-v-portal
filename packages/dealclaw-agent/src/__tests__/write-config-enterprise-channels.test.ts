import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const script = path.join(repoRoot, 'runtime', 'write-config.mjs');
const enterpriseEnvKeys = [
  'DEALCLAW_WECOM_BOUND',
  'DEALCLAW_WECOM_BOT_ID',
  'DEALCLAW_WECOM_SECRET',
  'DEALCLAW_WECOM_TRUSTED',
  'DEALCLAW_DINGTALK_BOUND',
  'DEALCLAW_DINGTALK_CLIENT_ID',
  'DEALCLAW_DINGTALK_CLIENT_SECRET',
  'DEALCLAW_DINGTALK_TRUSTED',
] as const;

function writeConfig(overrides: Record<string, string> = {}): {
  config: any;
  configPath: string;
} {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-enterprise-state-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-enterprise-workspace-'));
  const configPath = path.join(stateDir, 'openclaw.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_WORKSPACE_DIR: workspace,
    OPENCLAW_CONFIG_PATH: configPath,
    DEALCLAW_MESSAGE_PLANE: 'openclaw',
  };
  for (const key of enterpriseEnvKeys) delete env[key];
  Object.assign(env, overrides);
  execFileSync('node', [script], { env, encoding: 'utf8' });
  return {
    config: JSON.parse(fs.readFileSync(configPath, 'utf8')),
    configPath,
  };
}

function runWriteConfig(overrides: Record<string, string> = {}): any {
  return writeConfig(overrides).config;
}

function expectNoEnterpriseChannels(config: any): void {
  expect(config.channels?.wecom).toBeUndefined();
  expect(config.channels?.['dingtalk-connector']).toBeUndefined();
  expect(config.plugins.entries['wecom-openclaw-plugin']).toBeUndefined();
  expect(config.plugins.entries['dingtalk-connector']).toBeUndefined();
  expect(config.plugins.allow).not.toContain('wecom-openclaw-plugin');
  expect(config.plugins.allow).not.toContain('dingtalk-connector');
}

describe('write-config enterprise channels', () => {
  it('does not enable unbound enterprise plugins', () => {
    expectNoEnterpriseChannels(runWriteConfig());
  });

  it('enables only WeCom using the string secret required by plugin 2026.7.2', () => {
    const config = runWriteConfig({
      DEALCLAW_WECOM_BOUND: '1',
      DEALCLAW_WECOM_BOT_ID: 'wecom-bot-id',
      DEALCLAW_WECOM_SECRET: 'wecom-plaintext-secret',
    });

    expect(config.channels.wecom).toMatchObject({
      enabled: true,
      connectionMode: 'websocket',
      botId: 'wecom-bot-id',
      secret: 'wecom-plaintext-secret',
    });
    expect(config.plugins.allow).toContain('wecom-openclaw-plugin');
    expect(config.plugins.entries['wecom-openclaw-plugin']).toEqual({ enabled: true });
    expect(config.plugins.load.paths).toContain(
      '/opt/dealclaw/plugins/wecom/node_modules/@wecom/wecom-openclaw-plugin',
    );
    expect(config.channels['dingtalk-connector']).toBeUndefined();
    expect(config.channels.wecom.secret).toBe('wecom-plaintext-secret');
  });

  it('keeps the WeCom plaintext secret in an owner-only config file', () => {
    const { configPath } = writeConfig({
      DEALCLAW_WECOM_BOUND: '1',
      DEALCLAW_WECOM_BOT_ID: 'wecom-bot-id',
      DEALCLAW_WECOM_SECRET: 'wecom-plaintext-secret',
    });

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('restores owner-only permissions when rewriting an existing config', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-enterprise-state-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-enterprise-workspace-'));
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.writeFileSync(configPath, '{}\n', { mode: 0o644 });

    execFileSync('node', [script], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: workspace,
        OPENCLAW_CONFIG_PATH: configPath,
        DEALCLAW_MESSAGE_PLANE: 'openclaw',
        DEALCLAW_WECOM_BOUND: '1',
        DEALCLAW_WECOM_BOT_ID: 'wecom-bot-id',
        DEALCLAW_WECOM_SECRET: 'wecom-plaintext-secret',
      },
      encoding: 'utf8',
    });

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('enables only DingTalk and keeps its secret as an env SecretRef', () => {
    const config = runWriteConfig({
      DEALCLAW_DINGTALK_BOUND: '1',
      DEALCLAW_DINGTALK_CLIENT_ID: 'ding-client-id',
      DEALCLAW_DINGTALK_CLIENT_SECRET: 'ding-plaintext-secret',
    });

    expect(config.channels['dingtalk-connector']).toMatchObject({
      enabled: true,
      clientId: 'ding-client-id',
      clientSecret: {
        source: 'env',
        provider: 'default',
        id: 'DEALCLAW_DINGTALK_CLIENT_SECRET',
      },
    });
    expect(config.plugins.allow).toContain('dingtalk-connector');
    expect(config.plugins.entries['dingtalk-connector']).toEqual({ enabled: true });
    expect(config.plugins.load.paths).toContain(
      '/opt/dealclaw/plugins/dingtalk/node_modules/@dingtalk-real-ai/dingtalk-connector',
    );
    expect(config.channels.wecom).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('ding-plaintext-secret');
  });

  it('enables both enterprise channels together', () => {
    const config = runWriteConfig({
      DEALCLAW_WECOM_BOUND: '1',
      DEALCLAW_WECOM_BOT_ID: 'wecom-bot-id',
      DEALCLAW_WECOM_SECRET: 'wecom-secret',
      DEALCLAW_DINGTALK_BOUND: '1',
      DEALCLAW_DINGTALK_CLIENT_ID: 'ding-client-id',
      DEALCLAW_DINGTALK_CLIENT_SECRET: 'ding-secret',
    });

    expect(config.channels.wecom.enabled).toBe(true);
    expect(config.channels['dingtalk-connector'].enabled).toBe(true);
    expect(config.plugins.allow).toEqual(
      expect.arrayContaining(['wecom-openclaw-plugin', 'dingtalk-connector']),
    );
  });

  it('omits image sideload paths when trusted installs are available', () => {
    const config = runWriteConfig({
      DEALCLAW_WECOM_BOUND: '1',
      DEALCLAW_WECOM_BOT_ID: 'wecom-bot-id',
      DEALCLAW_WECOM_SECRET: 'wecom-secret',
      DEALCLAW_WECOM_TRUSTED: '1',
      DEALCLAW_DINGTALK_BOUND: '1',
      DEALCLAW_DINGTALK_CLIENT_ID: 'ding-client-id',
      DEALCLAW_DINGTALK_CLIENT_SECRET: 'ding-secret',
      DEALCLAW_DINGTALK_TRUSTED: '1',
    });

    expect(config.plugins.load.paths.some((value: string) => value.includes('/plugins/wecom/'))).toBe(false);
    expect(config.plugins.load.paths.some((value: string) => value.includes('/plugins/dingtalk/'))).toBe(false);
    expect(config.plugins.entries['wecom-openclaw-plugin'].enabled).toBe(true);
    expect(config.plugins.entries['dingtalk-connector'].enabled).toBe(true);
  });

  it('does not enable a bound channel with incomplete credentials', () => {
    const config = runWriteConfig({
      DEALCLAW_WECOM_BOUND: '1',
      DEALCLAW_WECOM_BOT_ID: 'wecom-bot-id',
      DEALCLAW_DINGTALK_BOUND: '1',
      DEALCLAW_DINGTALK_CLIENT_SECRET: 'ding-secret',
    });
    expectNoEnterpriseChannels(config);
  });
});
