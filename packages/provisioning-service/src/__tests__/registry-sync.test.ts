import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/k8s-client.js', () => ({
  getSecret: vi.fn(),
  deploymentExists: vi.fn(),
  createNamespace: vi.fn(),
  createSecret: vi.fn(),
  copySecretToNamespace: vi.fn(),
  createDeployment: vi.fn(),
  createService: vi.fn(),
  createPersistentVolumeClaim: vi.fn(),
  createJob: vi.fn(),
  deleteSecret: vi.fn(),
  deleteDeployment: vi.fn(),
  deleteService: vi.fn(),
  deletePersistentVolumeClaim: vi.fn(),
  deleteNamespace: vi.fn(),
  patchDeploymentImage: vi.fn(),
}));

import {
  syncImageReleases,
  parseTagMeta,
  splitRegistryRef,
  basicAuthFromDockerConfig,
  parseBearerChallenge,
} from '../services/registry-sync.js';
import { getSecret } from '../services/k8s-client.js';
import type { ProvisioningConfig } from '../config.js';

const baseConfig: ProvisioningConfig = {
  port: 0,
  databaseUrl: 'postgresql://test:test@localhost:5432/test',
  k8sDryRun: false,
  runtimeNamespace: 'dealclaw-nexus-production',
  imageRegistry: 'reg.example.com/dealclaw-nexus',
  nexusGatewayImageTag: 'latest',
  dealclawAgentImageTag: 'latest',
  agentPvcSize: '10Gi',
  agentPvcStorageClass: 'alibabacloud-cnfs-nas',
  agentPvcAccessMode: 'ReadWriteOnce',
  ossEndpoint: 'oss-cn-shanghai.aliyuncs.com',
  ossBucket: 'dealclaw-backup',
  ossSecretName: 'dealclaw-oss',
  backupImage: 'test/ossutil',
  creditsLedgerUrl: 'http://credits-ledger:8081',
  creditsLedgerToken: '',
};

interface FakeQuery { sql: string; params?: unknown[] }

function makeFakePool() {
  const queries: FakeQuery[] = [];
  const inserted: Array<Record<string, any>> = [];
  const pool = {
    queries,
    inserted,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO image_releases')) {
        inserted.push({ params });
        return { rows: [{ id: inserted.length }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

function dockerConfigSecret(auth = 'dXNlcjpwYXNz') {
  return {
    type: 'kubernetes.io/dockerconfigjson',
    data: {
      '.dockerconfigjson': Buffer.from(
        JSON.stringify({ auths: { 'reg.example.com': { auth } } }),
      ).toString('base64'),
    },
  };
}

function tagsResponse(tags: string[]) {
  return new Response(JSON.stringify({ name: 'x', tags }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseTagMeta', () => {
  it('parses CI tags like master.a7bcda5b.42', () => {
    expect(parseTagMeta('master.a7bcda5b.42')).toEqual({
      branch: 'master',
      gitCommit: 'a7bcda5b',
      buildNumber: '42',
    });
  });
  it('returns null for non-CI tags', () => {
    expect(parseTagMeta('latest')).toBeNull();
    expect(parseTagMeta('v1.2.3')).toBeNull();
  });
});

describe('splitRegistryRef', () => {
  it('splits host and repo path', () => {
    expect(splitRegistryRef('reg.example.com/dealclaw-nexus')).toEqual({
      host: 'reg.example.com',
      path: 'dealclaw-nexus',
    });
    expect(splitRegistryRef('reg.example.com')).toEqual({ host: 'reg.example.com', path: '' });
  });
});

describe('basicAuthFromDockerConfig', () => {
  it('reads the auth field for the registry host', () => {
    const cfg = JSON.stringify({ auths: { 'reg.example.com': { auth: 'abc123' } } });
    expect(basicAuthFromDockerConfig(cfg, 'reg.example.com')).toBe('abc123');
  });
  it('builds auth from username/password', () => {
    const cfg = JSON.stringify({ auths: { 'reg.example.com': { username: 'u', password: 'p' } } });
    expect(basicAuthFromDockerConfig(cfg, 'reg.example.com')).toBe(Buffer.from('u:p').toString('base64'));
  });
  it('returns null for unknown host or bad json', () => {
    expect(basicAuthFromDockerConfig('{}', 'reg.example.com')).toBeNull();
    expect(basicAuthFromDockerConfig('not json', 'reg.example.com')).toBeNull();
  });
});

describe('syncImageReleases', () => {
  beforeEach(() => {
    vi.mocked(getSecret).mockReset();
  });

  it('fetches tags for both services and inserts them with parsed metadata', async () => {
    vi.mocked(getSecret).mockResolvedValue(dockerConfigSecret() as any);
    const pool = makeFakePool();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url.startsWith('https://reg.example.com/v2/dealclaw-nexus/')).toBe(true);
      expect((init?.headers as any)?.Authorization).toBe('Basic dXNlcjpwYXNz');
      const svc = url.includes('dealclaw-agent') ? 'dealclaw-agent' : 'nexus-gateway';
      return tagsResponse(svc === 'dealclaw-agent'
        ? ['master.a7bcda5b.42', 'master.8fdf60bd.40', 'latest']
        : ['master.e3d43339.7']);
    });

    const r = await syncImageReleases(pool, baseConfig, fetchImpl as any);

    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({ service: 'dealclaw-agent', ok: true, discovered: 3, inserted: 3 });
    expect(r.results[1]).toMatchObject({ service: 'nexus-gateway', ok: true, discovered: 1, inserted: 1 });

    // Inserted rows carry the parsed metadata
    const firstInsert = pool.inserted[0].params as any[];
    expect(firstInsert[0]).toBe('dealclaw-agent');
    expect(firstInsert[1]).toBe('master.a7bcda5b.42');
    expect(firstInsert[2]).toBe('reg.example.com/dealclaw-nexus/dealclaw-agent:master.a7bcda5b.42');
    expect(firstInsert[3]).toBe('a7bcda5b');
    expect(firstInsert[4]).toBe('42');
    expect(firstInsert[6]).toBe('registry-sync');
  });

  it('reports per-service errors without throwing when one repo is unreachable', async () => {
    vi.mocked(getSecret).mockResolvedValue(dockerConfigSecret() as any);
    const pool = makeFakePool();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('dealclaw-agent')) return new Response('unauthorized', { status: 401 });
      return tagsResponse(['master.e3d43339.7']);
    });

    const r = await syncImageReleases(pool, baseConfig, fetchImpl as any);

    expect(r.ok).toBe(false);
    expect(r.results[0]).toMatchObject({ service: 'dealclaw-agent', ok: false, error: 'registry returned HTTP 401' });
    expect(r.results[1].ok).toBe(true);
    expect(pool.inserted).toHaveLength(1);
  });

  it('skips everything in dry-run mode', async () => {
    const pool = makeFakePool();
    const fetchImpl = vi.fn();
    const r = await syncImageReleases(pool, { ...baseConfig, k8sDryRun: true }, fetchImpl as any);
    expect(r.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(pool.queries).toHaveLength(0);
  });

  it('still syncs (unauthenticated) when the pull secret is missing', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const pool = makeFakePool();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as any)?.Authorization).toBeUndefined();
      return tagsResponse(['master.e3d43339.7']);
    });
    const r = await syncImageReleases(pool, baseConfig, fetchImpl as any);
    expect(r.ok).toBe(true);
    expect(pool.inserted).toHaveLength(2);
  });

  it('exchanges credentials for a bearer token on 401 Bearer challenge (ACR flow)', async () => {
    vi.mocked(getSecret).mockResolvedValue(dockerConfigSecret() as any);
    const pool = makeFakePool();
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as any)?.Authorization });
      if (url.startsWith('https://auth.example.com/token')) {
        // Realm exchange must carry the Basic credentials
        expect((init?.headers as any)?.Authorization).toBe('Basic dXNlcjpwYXNz');
        expect(url).toContain('service=registry.example.com');
        expect(url).toContain(encodeURIComponent('repository:dealclaw-nexus/dealclaw-agent:pull'));
        return new Response(JSON.stringify({ token: 'tok-123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('dealclaw-agent')) {
        const auth = (init?.headers as any)?.Authorization;
        if (auth === 'Basic dXNlcjpwYXNz') {
          return new Response('unauthorized', {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:dealclaw-nexus/dealclaw-agent:pull"',
            },
          });
        }
        expect(auth).toBe('Bearer tok-123');
        return tagsResponse(['master.a7bcda5b.42']);
      }
      // nexus-gateway: no challenge, direct 200
      return tagsResponse(['master.e3d43339.7']);
    });

    const r = await syncImageReleases(pool, baseConfig, fetchImpl as any);

    expect(r.ok).toBe(true);
    expect(r.results[0]).toMatchObject({ service: 'dealclaw-agent', ok: true, discovered: 1, inserted: 1 });
    expect(r.results[1]).toMatchObject({ service: 'nexus-gateway', ok: true, inserted: 1 });
    // dealclaw-agent: basic 401 → realm → bearer retry
    const agentCalls = calls.filter((c) => c.url.includes('/v2/dealclaw-nexus/dealclaw-agent/tags/list'));
    expect(agentCalls.map((c) => c.auth)).toEqual(['Basic dXNlcjpwYXNz', 'Bearer tok-123']);
  });

  it('reports the realm error when the token exchange fails', async () => {
    vi.mocked(getSecret).mockResolvedValue(dockerConfigSecret() as any);
    const pool = makeFakePool();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://auth.example.com/token')) {
        return new Response('forbidden', { status: 403 });
      }
      return new Response('unauthorized', {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:dealclaw-nexus/dealclaw-agent:pull"',
        },
      });
    });

    const r = await syncImageReleases(pool, baseConfig, fetchImpl as any);

    expect(r.ok).toBe(false);
    expect(r.results[0]).toMatchObject({ service: 'dealclaw-agent', ok: false, error: 'auth realm returned HTTP 403' });
    expect(r.results[1]).toMatchObject({ service: 'nexus-gateway', ok: false, error: 'auth realm returned HTTP 403' });
    expect(pool.inserted).toHaveLength(0);
  });
});

describe('parseBearerChallenge', () => {
  it('extracts realm, service and scope', () => {
    expect(
      parseBearerChallenge(
        'Bearer realm="https://dockerauth-vpc.cn-hangzhou.aliyuncs.com/auth",service="registry.aliyuncs.com:cn-hangzhou:china:cri-x",scope="repository:dealclaw-nexus/dealclaw-agent:pull"',
      ),
    ).toEqual({
      realm: 'https://dockerauth-vpc.cn-hangzhou.aliyuncs.com/auth',
      service: 'registry.aliyuncs.com:cn-hangzhou:china:cri-x',
      scope: 'repository:dealclaw-nexus/dealclaw-agent:pull',
    });
  });
  it('returns null for non-bearer headers', () => {
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseBearerChallenge('Bearer')).toBeNull();
  });
});
