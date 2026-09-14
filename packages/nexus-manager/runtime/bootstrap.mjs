import fs from 'node:fs';
import path from 'node:path';

export function httpsOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Expected an HTTPS origin');
  return u.origin;
}

export function normalizeUiBasePath(value = '') {
  if (value === '' || value === '/') return '';
  if (!/^(\/[a-zA-Z0-9_-]+)+\/?$/.test(value)) throw new Error('Invalid UI base path');
  return value.replace(/\/$/, '');
}

export function bootstrap(env = process.env, payload = '/opt/nexus-manager/payload') {
  const adminOrigin = httpsOrigin(env.NEXUS_ADMIN_ORIGIN);
  const uiOrigin = httpsOrigin(env.NEXUS_UI_ORIGIN);
  const uiBasePath = normalizeUiBasePath(env.NEXUS_UI_BASE_PATH);
  if (adminOrigin === uiOrigin) throw new Error('Admin and Gateway must use separate origins');
  if (!env.OPENCLAW_GATEWAY_TOKEN || env.OPENCLAW_GATEWAY_TOKEN.length < 32) throw new Error('Gateway token must contain at least 32 characters');
  const state = env.OPENCLAW_STATE_DIR;
  const workspace = env.OPENCLAW_WORKSPACE_DIR;
  const configPath = env.OPENCLAW_CONFIG_PATH;
  for (const dir of [env.OPENCLAW_HOME, state, workspace]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(payload)) {
    try { fs.copyFileSync(path.join(payload, name), path.join(workspace, name), fs.constants.COPYFILE_EXCL); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  // First boot only. Native Control UI remains the owner of mutable configuration.
  if (!fs.existsSync(configPath)) {
    const base = new URL(env.NEXUS_MODEL_BASE_URL);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Model endpoint must use HTTPS without credentials');
    if (!env.NEXUS_MODEL_ID) throw new Error('Initial model ID is missing');
    const config = {
      plugins: { allow: ['feishu'], load: { paths: ['/opt/nexus-manager/plugins/feishu/node_modules/@openclaw/feishu'] } },
      gateway: { mode: 'local', bind: 'loopback', port: 18790,
        // The embed adapter is the only network listener. It strips caller-supplied
        // forwarding/identity headers before rebuilding X-Forwarded-* locally.
        trustedProxies: ['127.0.0.1', '::1'],
        auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' },
        controlUi: { enabled: true, allowedOrigins: [uiOrigin], ...(uiBasePath ? { basePath: uiBasePath } : {}) } },
      models: { mode: 'merge', providers: { nexus: {
        baseUrl: env.NEXUS_MODEL_BASE_URL, apiKey: '${NEXUS_MODEL_API_KEY}', api: 'openai-completions',
        models: [{ id: env.NEXUS_MODEL_ID, name: env.NEXUS_MODEL_ID }],
      } } },
      memory: { search: { enabled: false } },
      agents: { defaults: { workspace, model: { primary: `nexus/${env.NEXUS_MODEL_ID}` } } },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { adminOrigin, uiOrigin, uiBasePath };
}
