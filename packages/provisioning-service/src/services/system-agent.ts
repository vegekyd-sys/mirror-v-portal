import https from 'node:https';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export class SystemAgentError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Dedicated client: no dry-run success, refreshed projected token, verified cluster CA.
export async function clusterRequest(method: string, path: string, body?: unknown): Promise<any> {
  const root = '/var/run/secrets/kubernetes.io/serviceaccount';
  let token: string, ca: string;
  try { token = fs.readFileSync(`${root}/token`, 'utf8').trim(); ca = fs.readFileSync(`${root}/ca.crt`, 'utf8'); }
  catch { throw new SystemAgentError(503, '集群凭据不可用'); }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc',
      port: process.env.KUBERNETES_SERVICE_PORT || 443, path, method, ca,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' },
    }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2_097_152) res.destroy(new Error('response too large'));
        else chunks.push(chunk);
      });
      res.on('error', () => reject(new SystemAgentError(502, '集群响应中断')));
      res.on('end', () => {
        const status = res.statusCode || 502;
        if (status >= 400) return reject(new SystemAgentError(status === 404 ? 404 : status === 409 ? 409 : 502,
          status === 409 ? '实例已被其他操作修改，请刷新后重试' : `集群请求失败 (${status})`));
        const text = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new SystemAgentError(502, '无法连接集群 API')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

type RequestFn = typeof clusterRequest;
const NAME = 'nexus-manager';
const PREVIOUS = 'nexus.dealclaw.io/previous-credentials';

export function createSystemAgentService(request: RequestFn = clusterRequest) {
  function settings() {
    if (process.env.NEXUS_MANAGER_ENABLED !== 'true') throw new SystemAgentError(503, 'Nexus Manager 尚未启用');
    const namespace = process.env.NEXUS_MANAGER_NAMESPACE || 'dealclaw-system';
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) throw new SystemAgentError(503, '实例命名空间配置错误');
    let url: URL;
    try { url = new URL(process.env.NEXUS_MANAGER_UI_URL || ''); }
    catch { throw new SystemAgentError(503, '原生 UI 地址尚未配置'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^(\/|(?:\/[a-zA-Z0-9_-]+)+\/?)$/.test(url.pathname)) {
      throw new SystemAgentError(503, '原生 UI 必须使用不含凭据的 HTTPS 地址和有效路径');
    }
    return { namespace, uiUrl: url.origin + url.pathname.replace(/\/$/, '') + '/', core: `/api/v1/namespaces/${namespace}`, deployment: `/apis/apps/v1/namespaces/${namespace}/deployments/${NAME}` };
  }
  const pods = (core: string) => request('GET', `${core}/pods?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${NAME}`)}`);
  function container(d: any) {
    const c = d.spec?.template?.spec?.containers?.find((v: any) => v.name === NAME);
    if (!c) throw new SystemAgentError(409, '实例容器配置不匹配');
    return c;
  }
  function secretName(d: any): string | undefined {
    const name = container(d).envFrom?.find((v: any) => v.secretRef?.name?.startsWith('nexus-manager-credentials-'))?.secretRef.name;
    return name;
  }
  async function update(s: ReturnType<typeof settings>, d: any, spec: any, annotations?: any) {
    return request('PATCH', s.deployment, {
      metadata: { resourceVersion: d.metadata.resourceVersion, ...(annotations ? { annotations } : {}) }, spec,
    });
  }
  async function switchSecret(s: ReturnType<typeof settings>, d: any, name: string) {
    const current = secretName(d);
    const containers = d.spec.template.spec.containers.map((c: any) => c.name !== NAME ? c : ({
      ...c, envFrom: current
        ? c.envFrom.map((ref: any) => ref.secretRef?.name === current ? { secretRef: { name } } : ref)
        : [...(c.envFrom || []), { secretRef: { name } }],
    }));
    await update(s, d, { template: { spec: { containers } } }, current ? { [PREVIOUS]: current } : undefined);
    return { accepted: true, message: d.spec.replicas === 0 ? '已保存；下次启动加载新凭据' : '已保存，正在重建 Pod；模型可用性请在原生 UI 验证' };
  }
  return {
    async status() {
      const s = settings();
      const [d, p] = await Promise.all([request('GET', s.deployment), pods(s.core)]);
      const ready = d.status?.observedGeneration >= d.metadata.generation && d.status?.updatedReplicas === 1 && d.status?.readyReplicas === 1;
      return { name: NAME, namespace: s.namespace, uiUrl: s.uiUrl, version: d.metadata.resourceVersion,
        state: d.spec.replicas === 0 ? 'stopped' : ready ? 'ready' : 'starting',
        image: container(d).image, canRollbackCredentials: Boolean(d.metadata.annotations?.[PREVIOUS]),
        pods: (p.items || []).map((p: any) => ({ name: p.metadata.name, phase: p.status?.phase,
          containers: (p.status?.containerStatuses || []).map((c: any) => ({ name: c.name, ready: c.ready, restartCount: c.restartCount })) })),
      };
    },
    async action(action: string, version: string) {
      const s = settings(); const d = await request('GET', s.deployment);
      if (!version || d.metadata.resourceVersion !== version) throw new SystemAgentError(409, '实例已变化，请刷新后重试');
      if (action === 'rollback-credentials') {
        const name = d.metadata.annotations?.[PREVIOUS];
        if (!/^nexus-manager-credentials-[a-z0-9-]+$/.test(name || '')) throw new SystemAgentError(409, '没有可恢复的凭据版本');
        await request('GET', `${s.core}/secrets/${name}`);
        return switchSecret(s, d, name);
      }
      if (action === 'restart' && d.spec.replicas === 0) throw new SystemAgentError(409, '实例已停止，请先启动');
      const spec = action === 'restart'
        ? { template: { metadata: { annotations: { 'nexus.dealclaw.io/restarted-at': randomUUID() } } } }
        : { replicas: action === 'start' ? 1 : 0 };
      await update(s, d, spec);
      return { accepted: true, message: '操作已提交，正在等待实例状态更新' };
    },
    async credentials(apiKey: string, version: string) {
      if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)) throw new SystemAgentError(400, 'API Key 格式不正确');
      const s = settings(); const d = await request('GET', s.deployment);
      if (!version || d.metadata.resourceVersion !== version) throw new SystemAgentError(409, '实例已变化，请刷新后重试');
      const current = secretName(d);
      const previous = current ? await request('GET', `${s.core}/secrets/${current}`) : { data: {} };
      const name = `nexus-manager-credentials-${randomUUID()}`;
      await request('POST', `${s.core}/secrets`, {
        apiVersion: 'v1', kind: 'Secret', immutable: true, type: 'Opaque',
        metadata: { name, labels: { 'app.kubernetes.io/name': NAME } },
        data: { ...previous.data, NEXUS_MODEL_API_KEY: Buffer.from(apiKey.trim()).toString('base64') },
      });
      // If the optimistic deployment update conflicts, the unused immutable Secret is harmless.
      return switchSecret(s, d, name);
    },
    async logs(pod: string, previous: boolean) {
      const s = settings(); const p = await pods(s.core);
      if (!/^[a-z0-9-]+$/.test(pod) || !(p.items || []).some((v: any) => v.metadata.name === pod)) throw new SystemAgentError(404, 'Pod 不属于 Nexus Manager');
      const query = new URLSearchParams({ container: NAME, tailLines: '300', limitBytes: '131072', timestamps: 'true', previous: String(previous) });
      const result = await request('GET', `${s.core}/pods/${pod}/log?${query}`);
      // Known injected credentials are scrubbed; runtime must also avoid logging other secrets.
      const d = await request('GET', s.deployment);
      const names = new Set([secretName(d), d.metadata.annotations?.[PREVIOUS], 'nexus-manager-gateway'].filter(Boolean));
      let logs = String(result);
      for (const name of names) {
        const sec = await request('GET', `${s.core}/secrets/${name}`);
        for (const value of Object.values(sec.data || {})) {
          const decoded = Buffer.from(String(value), 'base64').toString();
          if (decoded) logs = logs.split(decoded).join('[REDACTED]');
        }
      }
      return { logs };
    },
  };
}
