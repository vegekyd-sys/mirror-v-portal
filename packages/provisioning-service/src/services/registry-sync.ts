/**
 * Registry sync — the source of truth for image releases.
 *
 * Replaces the old Jenkins post-build hook (POST /v1/admin/image-releases,
 * removed): instead of builds pushing records into the DB, the
 * provisioning-service pulls the tag list straight from the container
 * registry (Docker Registry HTTP API v2) and upserts them into the
 * image_releases table. Build metadata (git commit / build number) is
 * recovered from the tag itself, which the CI tags as
 * `<branch>.<git-sha>.<build-number>` (e.g. master.a7bcda5b.42).
 *
 * Credentials come from the `registry-secret-vpc` dockerconfigjson pull
 * secret in the control-plane namespace — the same credentials the cluster
 * already uses to pull images, so no extra ACR API keys are needed.
 *
 * Triggers:
 *  - boot + periodic (see index.ts, every 30 min)
 *  - manual: POST /v1/admin/image-releases/sync (admin console 刷新 button)
 *
 * Guarantees:
 *  - Idempotent: ON CONFLICT (service, tag) DO NOTHING — repeated syncs
 *    never duplicate rows and never overwrite existing metadata.
 *  - Never throws for a single service being unreachable: the per-service
 *    error is reported in the result so one broken repo does not block
 *    the others.
 *  - Read-only against the registry: only GET /v2/<repo>/tags/list.
 */

import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { getSecret } from './k8s-client.js';

export const REGISTRY_SYNC_SERVICES = ['dealclaw-agent', 'nexus-gateway'] as const;
export const REGISTRY_SYNC_CREATED_BY = 'registry-sync';

/** `<branch>.<git-sha-7..40>.<build-number>` CI tag format. */
const TAG_META_PATTERN = /^([A-Za-z0-9._-]+)\.([0-9a-f]{7,40})\.(\d+)$/;

const REGISTRY_PULL_SECRET = 'registry-secret-vpc';

export interface RegistrySyncServiceResult {
  service: string;
  ok: boolean;
  /** Tags found in the registry for this service. */
  discovered: number;
  /** Rows newly inserted into image_releases. */
  inserted: number;
  error?: string;
}

export interface RegistrySyncResult {
  ok: boolean;
  results: RegistrySyncServiceResult[];
}

/** Split an imageRegistry reference `host/path` into its two parts. */
export function splitRegistryRef(imageRegistry: string): { host: string; path: string } {
  const idx = imageRegistry.indexOf('/');
  if (idx === -1) return { host: imageRegistry, path: '' };
  return { host: imageRegistry.slice(0, idx), path: imageRegistry.slice(idx + 1) };
}

/** Parse tag metadata; returns null for non-CI tags (e.g. `latest`). */
export function parseTagMeta(tag: string): { branch: string; gitCommit: string; buildNumber: string } | null {
  const m = TAG_META_PATTERN.exec(tag);
  if (!m) return null;
  return { branch: m[1], gitCommit: m[2], buildNumber: m[3] };
}

/**
 * Extract a Basic-auth header value for `host` from a dockerconfigjson
 * document (the payload of a kubernetes.io/dockerconfigjson Secret).
 * Accepts either `auth` (base64 user:pass) or `username`/`password` fields.
 */
export function basicAuthFromDockerConfig(
  dockerconfigjson: string,
  host: string,
): string | null {
  try {
    const doc = JSON.parse(dockerconfigjson) as {
      auths?: Record<string, { auth?: string; username?: string; password?: string }>;
    };
    const entry = doc.auths?.[host] ?? doc.auths?.[`https://${host}`];
    if (!entry) return null;
    if (entry.auth) return entry.auth;
    if (entry.username && entry.password != null) {
      return Buffer.from(`${entry.username}:${entry.password}`).toString('base64');
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve the Basic-auth header for the registry from the pull secret. */
async function resolveRegistryAuth(
  config: ProvisioningConfig,
): Promise<string | null> {
  const { host } = splitRegistryRef(config.imageRegistry);
  const secret = await getSecret(config.runtimeNamespace, REGISTRY_PULL_SECRET);
  const raw = secret?.data?.['.dockerconfigjson'];
  if (!raw) return null;
  try {
    return basicAuthFromDockerConfig(Buffer.from(raw, 'base64').toString('utf8'), host);
  } catch {
    return null;
  }
}

/**
 * Sync tags for all tenant-facing services from the container registry
 * into the image_releases table. See module doc for semantics.
 */
export async function syncImageReleases(
  pool: pg.Pool,
  config: ProvisioningConfig,
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<RegistrySyncResult> {
  const fetchFn = fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));

  if (config.k8sDryRun) {
    return {
      ok: true,
      results: REGISTRY_SYNC_SERVICES.map((service) => ({
        service,
        ok: true,
        discovered: 0,
        inserted: 0,
        error: 'skipped (k8s dry-run mode)',
      })),
    };
  }

  const { host, path } = splitRegistryRef(config.imageRegistry);
  const repoPrefix = path ? `${path}/` : '';
  let authHeader: string | null = null;
  try {
    authHeader = await resolveRegistryAuth(config);
  } catch (err) {
    console.warn(
      `[registry-sync] failed to read pull secret ${REGISTRY_PULL_SECRET}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!authHeader) {
    // Anonymous pull works for public repos; ACR is not anonymous, so this
    // usually means the secret is missing — report loudly but per-service
    // errors below will carry the 401 detail.
    console.warn(`[registry-sync] no credentials found for ${host} in ${REGISTRY_PULL_SECRET}; trying unauthenticated`);
  }

  const results: RegistrySyncServiceResult[] = [];

  for (const service of REGISTRY_SYNC_SERVICES) {
    const url = `https://${host}/v2/${repoPrefix}${service}/tags/list`;
    try {
      const res = await fetchFn(url, {
        headers: authHeader ? { Authorization: `Basic ${authHeader}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        results.push({
          service,
          ok: false,
          discovered: 0,
          inserted: 0,
          error: `registry returned HTTP ${res.status}`,
        });
        continue;
      }
      const body = (await res.json()) as { tags?: unknown };
      const tags = Array.isArray(body.tags)
        ? body.tags.filter((t): t is string => typeof t === 'string' && t.length > 0)
        : [];

      let inserted = 0;
      for (const tag of tags) {
        const meta = parseTagMeta(tag);
        const result = await pool.query(
          `INSERT INTO image_releases
             (service, tag, image, git_commit, build_number, build_env, created_by, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (service, tag) DO NOTHING
           RETURNING id`,
          [
            service,
            tag,
            `${config.imageRegistry}/${service}:${tag}`,
            meta?.gitCommit ?? null,
            meta?.buildNumber ?? null,
            null,
            REGISTRY_SYNC_CREATED_BY,
            meta ? `branch ${meta.branch}` : null,
          ],
        );
        if (result.rowCount === 1) inserted += 1;
      }

      results.push({ service, ok: true, discovered: tags.length, inserted });
    } catch (err) {
      results.push({
        service,
        ok: false,
        discovered: 0,
        inserted: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ok = results.every((r) => r.ok);
  return { ok, results };
}
