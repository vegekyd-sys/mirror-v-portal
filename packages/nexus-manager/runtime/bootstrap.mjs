import fs from 'node:fs';

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

export function bootstrap(env = process.env) {
  const adminOrigin = httpsOrigin(env.NEXUS_ADMIN_ORIGIN);
  const uiOrigin = httpsOrigin(env.NEXUS_UI_ORIGIN);
  const uiBasePath = normalizeUiBasePath(env.NEXUS_UI_BASE_PATH);
  const state = env.OPENCLAW_STATE_DIR;
  const workspace = env.OPENCLAW_WORKSPACE_DIR;
  for (const dir of [env.OPENCLAW_HOME, state, workspace]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The NAS is the sole owner of OpenClaw state. Do not seed, migrate, or
  // reconcile openclaw.json here: native UI changes must survive restarts.
  return { adminOrigin, uiOrigin, uiBasePath };
}
