/**
 * K8s API client
 *
 * In-cluster: reads ServiceAccount token + CA from standard mount paths.
 * Out-of-cluster (dev/test): falls back to dry-run mode.
 */

import fs from 'node:fs';

let _k8sBaseUrl: string | null = null;
let _k8sToken: string | null = null;
let _k8sCa: string | null = null;

function initK8s(): boolean {
  try {
    _k8sToken = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    _k8sCa = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf8');
    _k8sBaseUrl = `https://${process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc'}:${process.env.KUBERNETES_SERVICE_PORT || '443'}`;
    console.log('[k8s] in-cluster config loaded');
    return true;
  } catch {
    console.log('[k8s] not in cluster — dry-run mode');
    return false;
  }
}

function isInCluster(): boolean {
  if (_k8sBaseUrl === null) {
    try { return initK8s(); } catch { return false; }
  }
  return _k8sToken !== null;
}

async function k8sRequest(method: string, path: string, body?: unknown, contentType?: string): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  if (!isInCluster() || !_k8sBaseUrl || !_k8sToken) {
    return { ok: false, status: 0, body: null, error: 'not in cluster' };
  }

  const url = `${_k8sBaseUrl}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${_k8sToken}`,
        'Content-Type': contentType ?? 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    const resBody = await res.text().catch(() => '');
    let parsed: unknown = resBody;
    try { parsed = JSON.parse(resBody); } catch { /* keep as string */ }

    return { ok: res.ok || res.status === 201, status: res.status, body: parsed };
  } catch (err: any) {
    return { ok: false, status: 0, body: null, error: err.message };
  }
}

export interface TenantRuntimeStatus {
  namespace: string;
  tenantId: string;
  deployments: Array<{
    name: string;
    replicas: number;
    readyReplicas: number;
    availableReplicas: number;
    unavailableReplicas: number;
  }>;
  pods: Array<{
    name: string;
    phase: string;
    ready: boolean;
    containers: Array<{
      name: string;
      image: string;
      ready: boolean;
      restartCount: number;
      state: string;
      /** ISO 8601 — when the current container instance started (running.startedAt). */
      startedAt: string | null;
    }>;
  }>;
}

/** Read-only status for all runtime resources carrying the tenant label. */
export async function getTenantRuntimeStatus(namespace: string, tenantId: string): Promise<TenantRuntimeStatus> {
  const selector = encodeURIComponent(`dealclaw.io/tenant-id=${tenantId}`);
  const [deploymentRes, podRes] = await Promise.all([
    k8sRequest('GET', `/apis/apps/v1/namespaces/${namespace}/deployments?labelSelector=${selector}`),
    k8sRequest('GET', `/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`),
  ]);

  if (!deploymentRes.ok) {
    throw new Error(`list deployments failed: ${deploymentRes.status} ${JSON.stringify(deploymentRes.body)}`);
  }
  if (!podRes.ok) {
    throw new Error(`list pods failed: ${podRes.status} ${JSON.stringify(podRes.body)}`);
  }

  const deploymentItems = (deploymentRes.body as any)?.items || [];
  const podItems = (podRes.body as any)?.items || [];

  return {
    namespace,
    tenantId,
    deployments: deploymentItems.map((item: any) => ({
      name: item?.metadata?.name || '',
      replicas: item?.status?.replicas || 0,
      readyReplicas: item?.status?.readyReplicas || 0,
      availableReplicas: item?.status?.availableReplicas || 0,
      unavailableReplicas: item?.status?.unavailableReplicas || 0,
    })),
    pods: podItems.map((item: any) => ({
      name: item?.metadata?.name || '',
      phase: item?.status?.phase || 'Unknown',
      ready: item?.status?.conditions?.some((condition: any) => condition?.type === 'Ready' && condition?.status === 'True') || false,
      containers: (item?.status?.containerStatuses || []).map((container: any) => ({
        name: container?.name || '',
        image: container?.image || '',
        ready: container?.ready || false,
        restartCount: container?.restartCount || 0,
        state: Object.keys(container?.state || {})[0] || 'unknown',
        startedAt:
          container?.state?.running?.startedAt ??
          container?.state?.terminated?.startedAt ??
          item?.status?.startTime ??
          null,
      })),
    })),
  };
}

// ── Namespace ──

export async function createNamespace(name: string): Promise<void> {
  const res = await k8sRequest('POST', '/api/v1/namespaces', {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name },
  });
  if (!res.ok) {
    // Already exists is OK
    if (res.status !== 409) throw new Error(`createNamespace failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[k8s] namespace created: ${name}`);
}

export async function deleteNamespace(name: string): Promise<void> {
  const res = await k8sRequest('DELETE', `/api/v1/namespaces/${name}`);
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteNamespace failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  if (res.status !== 404) {
    console.log(`[k8s] namespace deleted: ${name}`);
  }
}

async function deleteNamespacedResource(path: string, kind: string, namespace: string, name: string): Promise<void> {
  const res = await k8sRequest('DELETE', `${path}/${name}`);
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete ${kind} ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  if (res.status !== 404) console.log(`[k8s] ${kind} deleted: ${namespace}/${name}`);
}

export async function deleteSecret(namespace: string, name: string): Promise<void> {
  return deleteNamespacedResource(`/api/v1/namespaces/${namespace}/secrets`, 'secret', namespace, name);
}

export async function deleteDeployment(namespace: string, name: string): Promise<void> {
  return deleteNamespacedResource(`/apis/apps/v1/namespaces/${namespace}/deployments`, 'deployment', namespace, name);
}

export async function deleteService(namespace: string, name: string): Promise<void> {
  return deleteNamespacedResource(`/api/v1/namespaces/${namespace}/services`, 'service', namespace, name);
}

// ── PersistentVolumeClaim ──

export interface PvcSpec {
  namespace: string;
  name: string;
  size: string;
  storageClassName: string;
  accessMode: 'ReadWriteOnce' | 'ReadWriteMany';
  labels: Record<string, string>;
}

export async function createPersistentVolumeClaim(spec: PvcSpec): Promise<void> {
  const body = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: spec.name, namespace: spec.namespace, labels: spec.labels },
    spec: {
      storageClassName: spec.storageClassName,
      accessModes: [spec.accessMode],
      resources: { requests: { storage: spec.size } },
    },
  };

  const res = await k8sRequest('POST', `/api/v1/namespaces/${spec.namespace}/persistentvolumeclaims`, body);
  if (!res.ok) {
    if (res.status !== 409) throw new Error(`createPersistentVolumeClaim ${spec.name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[k8s] PVC created: ${spec.namespace}/${spec.name} (${spec.size}, ${spec.storageClassName})`);
}

export async function deletePersistentVolumeClaim(namespace: string, name: string): Promise<void> {
  return deleteNamespacedResource(`/api/v1/namespaces/${namespace}/persistentvolumeclaims`, 'persistentvolumeclaim', namespace, name);
}

// ── Secret ──

/** Read a secret's type + base64 data. Returns null when it does not exist. */
export async function getSecret(
  namespace: string,
  name: string,
): Promise<{ type: string; data: Record<string, string> } | null> {
  const res = await k8sRequest('GET', `/api/v1/namespaces/${namespace}/secrets/${name}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getSecret ${namespace}/${name} failed: ${res.status}`);
  const body = res.body as any;
  return { type: body?.type || 'Opaque', data: body?.data || {} };
}

/**
 * Create a secret from raw (already base64-encoded) data, preserving the
 * source secret's type (e.g. kubernetes.io/dockerconfigjson). Used to copy
 * secrets across namespaces. 409 (already exists) is tolerated.
 */
export async function copySecretToNamespace(
  namespace: string,
  name: string,
  type: string,
  data: Record<string, string>,
): Promise<void> {
  const res = await k8sRequest('POST', `/api/v1/namespaces/${namespace}/secrets`, {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
    type,
    data,
  });
  if (!res.ok) {
    if (res.status !== 409) throw new Error(`copySecret ${name} -> ${namespace} failed: ${res.status}`);
  }
  console.log(`[k8s] secret created: ${namespace}/${name}`);
}

export async function createSecret(namespace: string, name: string, data: Record<string, string>): Promise<void> {
  const res = await k8sRequest('POST', `/api/v1/namespaces/${namespace}/secrets`, {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
    type: 'Opaque',
    stringData: data,
  });
  if (!res.ok) {
    if (res.status !== 409) throw new Error(`createSecret ${name} failed: ${res.status}`);
  }
  console.log(`[k8s] secret created: ${namespace}/${name}`);
}

/**
 * Create or replace a secret with raw string values (upsert). Unlike
 * createSecret (which tolerates 409 and keeps the OLD content), this makes
 * the secret's content match `data` exactly — used by the Feishu binding
 * flow to rotate DEALCLAW_APP_ID/DEALCLAW_APP_SECRET.
 */
export async function putSecret(namespace: string, name: string, data: Record<string, string>): Promise<void> {
  // PUT requires the current resourceVersion, so GET it first.
  const getRes = await k8sRequest('GET', `/api/v1/namespaces/${namespace}/secrets/${name}`);
  if (getRes.ok) {
    const resourceVersion = (getRes.body as any)?.metadata?.resourceVersion;
    const res = await k8sRequest('PUT', `/api/v1/namespaces/${namespace}/secrets/${name}`, {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace, resourceVersion },
      type: 'Opaque',
      stringData: data,
    });
    if (!res.ok) throw new Error(`putSecret ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
    console.log(`[k8s] secret replaced: ${namespace}/${name}`);
    return;
  }
  if (getRes.status !== 404) {
    throw new Error(`putSecret: getSecret ${namespace}/${name} failed: ${getRes.status}`);
  }
  // Not found — create it.
  const res = await k8sRequest('POST', `/api/v1/namespaces/${namespace}/secrets`, {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
    type: 'Opaque',
    stringData: data,
  });
  if (!res.ok) throw new Error(`putSecret ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  console.log(`[k8s] secret created: ${namespace}/${name}`);
}

// ── Deployment ──

export interface ProbeTuning {
  path: string;
  initialDelaySeconds: number;
  periodSeconds: number;
  failureThreshold: number;
  timeoutSeconds: number;
}

export interface DeploymentSpec {
  name: string;
  namespace: string;
  image: string;
  port: number;
  labels: Record<string, string>;
  envFrom?: Array<{ secretRef: { name: string } }>;
  env?: Array<{ name: string; value: string }>;
  replicas?: number;
  requests?: { cpu: string; memory: string };
  limits?: { cpu: string; memory: string };
  livenessPath?: string;
  readinessPath?: string;
  /**
   * Optional per-probe tuning. Defaults are intentionally tight (fast-start
   * stateless services like nexus-gateway); slow-boot pods (dealclaw-agent,
   * which rsyncs a payload + boots an OpenClaw gateway) MUST pass a
   * startupProbe and looser liveness/readiness values.
   */
  startupProbe?: Partial<ProbeTuning>;
  livenessProbe?: Partial<ProbeTuning>;
  readinessProbe?: Partial<ProbeTuning>;
  runAsUser?: number;
  automountServiceAccountToken?: boolean;
  imagePullSecrets?: Array<{ name: string }>;
  securityContext?: Record<string, unknown>;
  volumes?: Array<{
    name: string;
    persistentVolumeClaim?: { claimName: string };
    secret?: { secretName: string; defaultMode?: number };
  }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
}

export async function createDeployment(spec: DeploymentSpec): Promise<void> {
  const container: Record<string, unknown> = {
    name: spec.name,
    image: spec.image,
    ports: [{ containerPort: spec.port }],
    resources: {
      requests: spec.requests || { cpu: '100m', memory: '128Mi' },
      limits: spec.limits || { cpu: '300m', memory: '256Mi' },
    },
  };

  if (spec.envFrom?.length) container.envFrom = spec.envFrom;
  if (spec.env?.length) container.env = spec.env;
  if (spec.volumeMounts?.length) container.volumeMounts = spec.volumeMounts;

  // Startup probe gates liveness/readiness until the app has actually booted.
  // Defaults: up to 30 × 10s = 300s to become ready — generous enough for the
  // OpenClaw gateway cold boot without ever restarting a healthy slow starter.
  if (spec.startupProbe) {
    const sp = spec.startupProbe;
    container.startupProbe = {
      httpGet: { path: sp.path ?? spec.livenessPath ?? spec.readinessPath ?? '/healthz', port: spec.port },
      periodSeconds: sp.periodSeconds ?? 10,
      failureThreshold: sp.failureThreshold ?? 30,
      timeoutSeconds: sp.timeoutSeconds ?? 5,
    };
  }
  if (spec.livenessPath) {
    const lp = spec.livenessProbe ?? {};
    container.livenessProbe = {
      httpGet: { path: spec.livenessPath, port: spec.port },
      initialDelaySeconds: lp.initialDelaySeconds ?? 5,
      periodSeconds: lp.periodSeconds ?? 15,
      failureThreshold: lp.failureThreshold ?? 3,
      // NB: /healthz on dealclaw-agent internally fetches the OpenClaw
      // gateway /v1/models with a 2s abort — keep the probe timeout above
      // that so a slow-but-healthy gateway isn't counted as a probe timeout.
      timeoutSeconds: lp.timeoutSeconds ?? 3,
    };
  }
  if (spec.readinessPath) {
    const rp = spec.readinessProbe ?? {};
    container.readinessProbe = {
      httpGet: { path: spec.readinessPath, port: spec.port },
      initialDelaySeconds: rp.initialDelaySeconds ?? 3,
      periodSeconds: rp.periodSeconds ?? 10,
      failureThreshold: rp.failureThreshold ?? 3,
      timeoutSeconds: rp.timeoutSeconds ?? 3,
    };
  }

  const podSpec: Record<string, unknown> = {
    containers: [container],
    automountServiceAccountToken: spec.automountServiceAccountToken ?? false,
  };

  if (spec.imagePullSecrets?.length) podSpec.imagePullSecrets = spec.imagePullSecrets;
  if (spec.volumes?.length) podSpec.volumes = spec.volumes;
  if (spec.runAsUser) {
    podSpec.securityContext = {
      runAsNonRoot: true,
      runAsUser: spec.runAsUser,
      runAsGroup: spec.runAsUser,
      fsGroup: spec.runAsUser,
      fsGroupChangePolicy: 'OnRootMismatch',
    };
  }

  const body = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: spec.labels,
    },
    spec: {
      replicas: spec.replicas ?? 1,
      selector: { matchLabels: spec.labels },
      template: {
        metadata: { labels: spec.labels },
        spec: podSpec,
      },
    },
  };

  const res = await k8sRequest('POST', `/apis/apps/v1/namespaces/${spec.namespace}/deployments`, body);
  if (!res.ok) {
    if (res.status !== 409) throw new Error(`createDeployment ${spec.name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[k8s] deployment created: ${spec.namespace}/${spec.name}`);
}

// ── Deployment Patch (rolling update) ──

export interface PatchImageSpec {
  namespace: string;
  name: string;
  image: string;
}

export async function patchDeploymentImage(spec: PatchImageSpec): Promise<void> {
  const body = {
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: spec.name,
              image: spec.image,
            },
          ],
        },
      },
    },
  };

  const res = await k8sRequest(
    'PATCH',
    `/apis/apps/v1/namespaces/${spec.namespace}/deployments/${spec.name}`,
    body,
    'application/strategic-merge-patch+json',
  );

  if (!res.ok) {
    throw new Error(`patchDeployment ${spec.name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[k8s] deployment patched (rolling update): ${spec.namespace}/${spec.name} -> ${spec.image}`);
}

// ── Deployment Probe Patch ──

/**
 * Full probe objects for the dealclaw-agent container. Its cold boot is slow
 * (rsync payload → write-config → OpenClaw gateway boot + plugin pre-warm →
 * bridge /healthz responsive), so the default tight liveness
 * (initialDelay=5, period=15, failureThreshold=3 ≈ 35s to first kill) restarts
 * the pod in a loop before the gateway is ready.
 *
 * Keep this in sync with the Partial<ProbeTuning> values passed to
 * createDeployment in provisioning.ts.
 */
export function buildAgentProbes(port: number, path: string) {
  return {
    startupProbe: {
      httpGet: { path, port },
      periodSeconds: 10,
      failureThreshold: 30,
      timeoutSeconds: 5,
    },
    livenessProbe: {
      httpGet: { path, port },
      initialDelaySeconds: 20,
      periodSeconds: 15,
      failureThreshold: 5,
      timeoutSeconds: 5,
    },
    readinessProbe: {
      httpGet: { path, port },
      initialDelaySeconds: 10,
      periodSeconds: 10,
      failureThreshold: 5,
      timeoutSeconds: 5,
    },
  };
}

export interface PatchProbesSpec {
  namespace: string;
  name: string;
  port: number;
  path: string;
}

/**
 * Strategic-merge-patch the startup/liveness/readiness probes on an existing
 * Deployment. Used to repair already-provisioned dealclaw-agent Deployments
 * that were created before the slow-boot probe fix shipped.
 */
export async function patchDeploymentProbes(spec: PatchProbesSpec): Promise<void> {
  const probes = buildAgentProbes(spec.port, spec.path);
  const body = {
    spec: {
      template: {
        spec: {
          containers: [{ name: spec.name, ...probes }],
        },
      },
    },
  };

  const res = await k8sRequest(
    'PATCH',
    `/apis/apps/v1/namespaces/${spec.namespace}/deployments/${spec.name}`,
    body,
    'application/strategic-merge-patch+json',
  );

  if (!res.ok) {
    throw new Error(`patchDeploymentProbes ${spec.name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[k8s] deployment probes patched: ${spec.namespace}/${spec.name}`);
}

// ── Deployment Scale ──

export interface ScaleSpec {
  namespace: string;
  name: string;
  replicas: number;
}

export async function scaleDeployment(spec: ScaleSpec): Promise<void> {
  const body = { spec: { replicas: spec.replicas } };

  const res = await k8sRequest(
    'PATCH',
    `/apis/apps/v1/namespaces/${spec.namespace}/deployments/${spec.name}`,
    body,
    'application/strategic-merge-patch+json',
  );

  if (!res.ok) {
    throw new Error(`scaleDeployment ${spec.name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[k8s] deployment scaled: ${spec.namespace}/${spec.name} -> ${spec.replicas}`);
}

// ── Deployment Image Update (recreate) ──

/**
 * Update a Deployment's container image using a recreate (scale 0 → scale N)
 * strategy instead of the default RollingUpdate.
 *
 * Rationale: dealclaw-agent is single-replica and shares its PVC (SQLite)
 * with the pod that replaces it. A RollingUpdate spawns the new pod *before*
 * the old one terminates — the two concurrent agents contend for the same
 * SQLite file and neither passes startupProbe (and, on RWO volumes, the
 * second pod can't even attach the volume). Scaling to 0 first fully
 * terminates the old pod and releases the volume, then the image is patched
 * (no-op while at 0 replicas) and the pod is brought back up cleanly.
 *
 * Steps: GET (replicas + selector) → scale 0 → patch image → poll for pod
 * termination (≤30s) → scale back to the original replicas.
 * Returns false when the Deployment does not exist (404) or is unavailable
 * (out-of-cluster dry-run); throws on other API errors.
 */
export async function updateDeploymentImageRecreate(
  namespace: string,
  name: string,
  image: string,
): Promise<boolean> {
  // 1. Read the current deployment to get replica count + pod selector.
  const getRes = await k8sRequest('GET', `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
  if (getRes.status === 404 || getRes.status === 0) return false;
  if (!getRes.ok) throw new Error(`updateDeploymentImageRecreate ${name} GET failed: ${getRes.status}`);
  const deploy = getRes.body as Record<string, any>;
  const replicas: number = deploy?.spec?.replicas ?? 1;
  const matchLabels: Record<string, string> = deploy?.spec?.selector?.matchLabels ?? { app: name };

  // 2. Scale to 0 first — terminates the old pod and releases its PVC before
  //    the new image lands, so there is never a dual-pod overlap.
  await scaleDeployment({ namespace, name, replicas: 0 });

  // 3-5. Patch the image, poll for pod termination, then scale back up. Any
  //     failure after the scale-to-0 rolls the replica count back so the
  //     tenant never stays stranded at 0 (the old pod returns on the
  //     unchanged image).
  try {
    // 3. Patch the image while at 0 replicas (no rolling churn).
    await patchDeploymentImage({ namespace, name, image });

    // 4. Poll for pod termination (≤30s, 5s intervals) before scaling up.
    const labelStr = Object.entries(matchLabels).map(([k, v]) => `${k}=${v}`).join(',');
    const labelSelector = encodeURIComponent(labelStr);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      const podRes = await k8sRequest(
        'GET',
        `/api/v1/namespaces/${namespace}/pods?labelSelector=${labelSelector}`,
      );
      if (!podRes.ok) break; // best-effort — proceed to scale back regardless
      const items = (podRes.body as Record<string, any>)?.items ?? [];
      const active = items.filter(
        (p: Record<string, any>) =>
          p.metadata?.deletionTimestamp === undefined &&
          p.status?.phase !== 'Succeeded' &&
          p.status?.phase !== 'Failed',
      );
      if (active.length === 0) break;
    }

    // 5. Scale back to the original replicas (new image).
    await scaleDeployment({ namespace, name, replicas });
  } catch (err) {
    // Best-effort rollback: restore the replica count so the deployment is
    // never left at 0.
    await scaleDeployment({ namespace, name, replicas }).catch(() => {});
    throw err;
  }

  console.log(`[k8s] deployment image updated (recreate 0→${replicas}): ${namespace}/${name} -> ${image}`);
  return true;
}

// ── Deployment Restart (rollout) ──

/**
 * Restart a Deployment safely by scaling to 0 then back to its original
 * replica count. This avoids the dual-pod overlap that a RollingUpdate
 * annotation-patch causes when the old pod shares a PVC (SQLite) with the
 * new one — two concurrent agents deadlock on the same DB file and neither
 * passes startupProbe.
 *
 * Steps: GET deployment → patch restarted-at annotation (observability) →
 * scale 0 → poll for pod termination (≤30s) → scale back to original.
 * 404 is tolerated; dry-run (status 0) returns false.
 */
export async function restartDeployment(namespace: string, name: string): Promise<boolean> {
  // 1. Read current deployment to get replica count + pod selector.
  const getRes = await k8sRequest('GET', `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
  if (getRes.status === 404 || getRes.status === 0) return false;
  if (!getRes.ok) throw new Error(`restartDeployment ${name} GET failed: ${getRes.status}`);
  const deploy = getRes.body as Record<string, any>;
  const replicas: number = deploy?.spec?.replicas ?? 1;
  const matchLabels: Record<string, string> = deploy?.spec?.selector?.matchLabels ?? { app: name };

  // 2. Patch the restarted-at annotation (observability + ensures RS turnover).
  const patchRes = await k8sRequest(
    'PATCH',
    `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
    {
      spec: {
        template: {
          metadata: {
            annotations: { 'dealclaw.io/restarted-at': new Date().toISOString() },
          },
        },
      },
    },
    'application/strategic-merge-patch+json',
  );
  if (!patchRes.ok) {
    if (patchRes.status === 404) return false;
    throw new Error(`restartDeployment ${name} patch failed: ${patchRes.status}`);
  }

  // 3. If 0 replicas, annotation alone suffices — nothing to scale.
  if (replicas === 0) {
    console.log(`[k8s] deployment restarted (0 replicas): ${namespace}/${name}`);
    return true;
  }

  // 4. Scale to 0 — breaks any dual-pod overlap / SQLite lock contention.
  await scaleDeployment({ namespace, name, replicas: 0 });

  // 5. Poll for pod termination (≤30s, 5s intervals).
  const labelStr = Object.entries(matchLabels).map(([k, v]) => `${k}=${v}`).join(',');
  const labelSelector = encodeURIComponent(labelStr);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const podRes = await k8sRequest(
      'GET',
      `/api/v1/namespaces/${namespace}/pods?labelSelector=${labelSelector}`,
    );
    if (!podRes.ok) break; // best-effort — proceed to scale back regardless
    const items = (podRes.body as Record<string, any>)?.items ?? [];
    const active = items.filter(
      (p: Record<string, any>) =>
        p.metadata?.deletionTimestamp === undefined &&
        p.status?.phase !== 'Succeeded' &&
        p.status?.phase !== 'Failed',
    );
    if (active.length === 0) break;
  }

  // 6. Scale back to original replicas.
  await scaleDeployment({ namespace, name, replicas });

  console.log(`[k8s] deployment restarted (scale 0→${replicas}): ${namespace}/${name}`);
  return true;
}

/** Whether a Deployment exists (used by self-heal checks). */
export async function deploymentExists(namespace: string, name: string): Promise<boolean> {
  const res = await k8sRequest('GET', `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`deploymentExists ${namespace}/${name} failed: ${res.status}`);
  return true;
}

/**
 * Read a Deployment's full object. Returns null when it does not exist.
 * Used by the skill-env mount check (volumes / volumeMounts inspection).
 */
export async function getDeployment(
  namespace: string,
  name: string,
): Promise<Record<string, any> | null> {
  const res = await k8sRequest('GET', `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getDeployment ${namespace}/${name} failed: ${res.status}`);
  return res.body as Record<string, any>;
}

/**
 * Strategic-merge patch on a Deployment (partial spec body, same shape as
 * the K8s API). Callers use it to add volumes / volumeMounts without
 * replacing the rest of the pod template.
 */
export async function patchDeployment(
  namespace: string,
  name: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const res = await k8sRequest(
    'PATCH',
    `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
    body,
    'application/strategic-merge-patch+json',
  );
  if (!res.ok) {
    if (res.status === 404) return false;
    throw new Error(`patchDeployment ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[k8s] deployment patched: ${namespace}/${name}`);
  return true;
}

/**
 * Ensure a Deployment's container envFrom includes the given secret.
 * Idempotent: when the secret is already referenced nothing is patched and
 * false is returned. Used to retro-fit the llm-proxy-config Secret onto
 * gateways created before the LLM egress proxy existed.
 *
 * NB: envFrom is a plain list without a merge key, so a strategic-merge
 * patch REPLACES the whole list — the current entries are read first and
 * resent together with the new one.
 */
export async function patchDeploymentEnvFromSecret(
  namespace: string,
  name: string,
  secretName: string,
): Promise<boolean> {
  const deploy = await getDeployment(namespace, name);
  if (!deploy) return false;
  const containers = deploy?.spec?.template?.spec?.containers ?? [];
  const container = containers.find((c: any) => c?.name === name);
  if (!container) return false;
  const envFrom: Array<{ secretRef: { name: string } }> = container.envFrom ?? [];
  if (envFrom.some((e: any) => e?.secretRef?.name === secretName)) return false;
  return patchDeployment(namespace, name, {
    spec: {
      template: {
        spec: {
          containers: [{ name, envFrom: [...envFrom, { secretRef: { name: secretName } }] }],
        },
      },
    },
  });
}

/**
 * Set (or replace) a single env var on a Deployment's main container.
 * Container env is a list keyed by `name` for strategic merge, so the patch
 * merges this one entry into the existing env without dropping the rest.
 * Patching env changes the pod template → triggers a rolling restart.
 * Returns false when the deployment does not exist.
 */
export async function patchDeploymentEnvVar(
  namespace: string,
  name: string,
  varName: string,
  value: string,
): Promise<boolean> {
  const deploy = await getDeployment(namespace, name);
  if (!deploy) return false;
  const containers = deploy?.spec?.template?.spec?.containers ?? [];
  const container = containers.find((c: any) => c?.name === name);
  if (!container) return false;
  const existing = (container.env ?? []).find((e: any) => e?.name === varName);
  if (existing && existing.value === value) return false;
  return patchDeployment(namespace, name, {
    spec: {
      template: {
        spec: {
          containers: [{ name, env: [{ name: varName, value }] }],
        },
      },
    },
  });
}

// ── Service ──
export async function createService(
  namespace: string,
  name: string,
  port: number,
  labels: Record<string, string>,
): Promise<void> {
  const body = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace, labels },
    spec: {
      selector: labels,
      ports: [{ port, targetPort: port, name: 'http' }],
    },
  };

  const res = await k8sRequest('POST', `/api/v1/namespaces/${namespace}/services`, body);
  if (!res.ok) {
    if (res.status !== 409) throw new Error(`createService ${name} failed: ${res.status}`);
  }
  console.log(`[k8s] service created: ${namespace}/${name}`);
}

// ── Job (one-shot backup/archive) ──

export interface JobSpec {
  namespace: string;
  name: string;
  labels: Record<string, string>;
  image: string;
  /** Shell command to run inside the container */
  command: string[];
  env?: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef: { name: string; key: string } } }>;
  volumeName: string;
  pvcClaimName: string;
  mountPath: string;
  /** Auto-delete finished Job after this many seconds (default 86400 = 24h) */
  ttlSecondsAfterFinished?: number;
  backoffLimit?: number;
  imagePullSecrets?: Array<{ name: string }>;
}

export async function createJob(spec: JobSpec): Promise<void> {
  const container: Record<string, unknown> = {
    name: spec.name,
    image: spec.image,
    command: spec.command,
    volumeMounts: [
      { name: spec.volumeName, mountPath: spec.mountPath },
    ],
  };

  if (spec.env?.length) container.env = spec.env;

  const body = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: spec.name, namespace: spec.namespace, labels: spec.labels },
    spec: {
      ttlSecondsAfterFinished: spec.ttlSecondsAfterFinished ?? 86_400,
      backoffLimit: spec.backoffLimit ?? 2,
      template: {
        metadata: { labels: spec.labels },
        spec: {
          restartPolicy: 'Never',
          containers: [container],
          volumes: [
            { name: spec.volumeName, persistentVolumeClaim: { claimName: spec.pvcClaimName } },
          ],
        },
      },
    },
  };

  if (spec.imagePullSecrets?.length) {
    (body.spec.template.spec as Record<string, unknown>).imagePullSecrets = spec.imagePullSecrets;
  }

  const res = await k8sRequest('POST', `/apis/batch/v1/namespaces/${spec.namespace}/jobs`, body);
  if (!res.ok) {
    if (res.status !== 409) throw new Error(`createJob ${spec.name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[k8s] job created: ${spec.namespace}/${spec.name}`);
}

// ── Pod console: logs + exec (admin console features) ──

/** RFC 1123 label value — safe for pod / container / namespace path segments. */
export function isSafeK8sName(value: string, maxLen = 63): boolean {
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) && value.length <= maxLen;
}

/** Full-width tenant UUIDs are `dealclaw-<32 hex>`; validate before path use. */
export function isSafeTenantId(tenantId: string): boolean {
  return /^[0-9a-f]{32}$/.test(tenantId);
}

/**
 * Lightweight check that the given pod actually exists in the tenant's
 * namespace AND carries the tenant label. Prevents exec/log access to pods
 * outside the tenant's namespace even if a caller passes an arbitrary name.
 * Returns the pod object, or null when missing / not owned by the tenant.
 */
export async function getTenantPod(
  namespace: string,
  tenantId: string,
  podName: string,
): Promise<Record<string, any> | null> {
  const res = await k8sRequest('GET', `/api/v1/namespaces/${namespace}/pods/${podName}`);
  if (!res.ok) return null;
  const pod = res.body as Record<string, any>;
  const owner = pod?.metadata?.labels?.['dealclaw.io/tenant-id'];
  if (owner !== tenantId) return null;
  return pod;
}

export interface PodLogOptions {
  container?: string;
  tailLines?: number;
  sinceSeconds?: number;
  timestamps?: boolean;
  /** Cap the one-shot response size (k8s limitBytes, default 1MiB). */
  limitBytes?: number;
}

function buildPodLogQuery(opts: PodLogOptions, follow: boolean): string {
  const params = new URLSearchParams();
  if (opts.container) params.set('container', opts.container);
  if (opts.tailLines && opts.tailLines > 0) params.set('tailLines', String(Math.min(opts.tailLines, 10_000)));
  if (opts.sinceSeconds && opts.sinceSeconds > 0) params.set('sinceSeconds', String(opts.sinceSeconds));
  if (opts.timestamps) params.set('timestamps', 'true');
  if (follow) params.set('follow', 'true');
  params.set('limitBytes', String(opts.limitBytes ?? 1_048_576));
  return params.toString();
}

/**
 * One-shot pod log fetch (no follow). Returns the raw text. Throws on
 * upstream errors with the apiserver's message.
 */
export async function getPodLogs(
  namespace: string,
  podName: string,
  opts: PodLogOptions = {},
): Promise<string> {
  const path = `/api/v1/namespaces/${namespace}/pods/${podName}/log?${buildPodLogQuery(opts, false)}`;
  const res = await k8sRequest('GET', path);
  if (!res.ok) {
    throw new Error(`getPodLogs ${namespace}/${podName} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return typeof res.body === 'string' ? res.body : String(res.body ?? '');
}

/**
 * Streaming pod log fetch (`follow=true`). Returns the raw fetch Response so
 * the route can pipe the upstream body straight to the client. The caller
 * owns the AbortSignal (client disconnect cancels the upstream request).
 */
export async function streamPodLogs(
  namespace: string,
  podName: string,
  opts: PodLogOptions,
  signal?: AbortSignal,
): Promise<Response> {
  if (!isInCluster() || !_k8sBaseUrl || !_k8sToken) {
    throw new Error('not in cluster');
  }
  const path = `/api/v1/namespaces/${namespace}/pods/${podName}/log?${buildPodLogQuery(opts, true)}`;
  return fetch(`${_k8sBaseUrl}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${_k8sToken}` },
    signal,
  });
}

/**
 * Open a WebSocket to the K8s exec API (remotecommand subprotocol
 * `v4.channel.k8s.io`). Returns the connected `ws` client; the caller is
 * responsible for relaying the channel-framed messages.
 */
export async function openPodExecWs(
  namespace: string,
  podName: string,
  opts: { container?: string; command: string[]; tty?: boolean },
): Promise<import('ws').WebSocket> {
  if (!isInCluster() || !_k8sBaseUrl || !_k8sToken) {
    throw new Error('not in cluster');
  }
  const { WebSocket } = await import('ws');
  const params = new URLSearchParams();
  if (opts.container) params.set('container', opts.container);
  for (const part of opts.command) params.append('command', part);
  params.set('stdin', 'true');
  params.set('stdout', 'true');
  params.set('stderr', 'true');
  params.set('tty', opts.tty === false ? 'false' : 'true');

  const url = `${_k8sBaseUrl.replace(/^http/, 'ws')}/api/v1/namespaces/${namespace}/pods/${podName}/exec?${params.toString()}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['v4.channel.k8s.io'], {
      headers: { Authorization: `Bearer ${_k8sToken}` },
      ca: _k8sCa ?? undefined,
      handshakeTimeout: 10_000,
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(err));
  });
}
