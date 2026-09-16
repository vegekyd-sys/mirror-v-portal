import { spawn, spawnSync } from 'node:child_process';
import { bootstrap } from './bootstrap.mjs';
import { createEmbedProxy } from './embed-proxy.mjs';

process.umask(0o077);
const origins = bootstrap();
if (origins.pluginRegistryRefreshRequired) {
  const refresh = spawnSync('openclaw', ['plugins', 'registry', '--refresh'], { stdio: 'inherit' });
  if (refresh.status !== 0) throw new Error(`Plugin registry refresh failed with status ${refresh.status}`);
}
const child = spawn('openclaw', ['gateway', '--port', '18790', '--bind', 'loopback'], { stdio: 'inherit' });
const proxy = createEmbedProxy(origins);
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true; proxy.close(); child.kill(signal);
  setTimeout(() => { child.kill('SIGKILL'); process.exit(1); }, 25_000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
child.on('error', () => { console.error('OpenClaw could not start'); process.exit(1); });
child.on('exit', code => { proxy.close(); process.exit(code ?? (stopping ? 0 : 1)); });
proxy.on('error', () => stop('SIGTERM'));
proxy.listen(18789, '0.0.0.0');
