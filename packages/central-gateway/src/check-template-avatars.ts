import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

const MAX_BYTES = 8 * 1024 * 1024;
const FEISHU_ORIGIN = 'https://open.feishu.cn';

/** Read-only publication gate: public URL, CORS, real PNG decode, and file hash. */
export async function checkTemplateAvatars(catalogUrl: string, fetchImpl: typeof fetch = fetch) {
  const catalog = await fetchImpl(catalogUrl, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!catalog.ok) throw Error('AVATAR_CATALOG_UNAVAILABLE');
  const body = await catalog.json() as { templates?: Array<{ id: string; avatarUrl?: string }> };
  if (!Array.isArray(body.templates) || !body.templates.length) throw Error('AVATAR_CATALOG_EMPTY');
  const results = [];
  for (const template of body.templates) {
    const id = template.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw Error('AVATAR_TEMPLATE_INVALID');
    if (!template.avatarUrl) throw Error(`AVATAR_REQUIRED:${id}`);
    const url = new URL(template.avatarUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw Error(`AVATAR_URL_INVALID:${id}`);
    const response = await fetchImpl(url, { headers: { Origin: FEISHU_ORIGIN }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Error(`AVATAR_HTTP_FAILED:${id}`);
    if (!['*', FEISHU_ORIGIN].includes(response.headers.get('access-control-allow-origin') || '')) throw Error(`AVATAR_CORS_FAILED:${id}`);
    if (response.headers.get('cross-origin-resource-policy') === 'same-origin') throw Error(`AVATAR_CORP_FAILED:${id}`);
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'image/png') throw Error(`AVATAR_MIME_FAILED:${id}`);
    if (!response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw Error(`AVATAR_SIZE_INVALID:${id}`);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) throw Error(`AVATAR_SIZE_INVALID:${id}`);
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 33 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error(`AVATAR_IMAGE_INVALID:${id}`);
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096) throw Error(`AVATAR_DIMENSIONS_INVALID:${id}`);
    try { PNG.sync.read(buffer); } catch { throw Error(`AVATAR_IMAGE_INVALID:${id}`); }
    const sha256 = createHash('sha256').update(new Uint8Array(buffer)).digest('hex');
    const expected = url.pathname.match(/-([a-f0-9]{12})\.png$/)?.[1];
    if (expected && !sha256.startsWith(expected)) throw Error(`AVATAR_HASH_FAILED:${id}`);
    results.push({ id, width, height, bytes, sha256, cors: true });
  }
  return results;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const flag = process.argv.indexOf('--catalog');
  const catalog = flag >= 0 ? process.argv[flag + 1] : 'https://mirror-v-portal.vercel.app/onboard/templates';
  checkTemplateAvatars(catalog).then(results => console.log(JSON.stringify({ ok: true, avatars: results })))
    .catch(error => { console.error(JSON.stringify({ ok: false, error: String(error.message) })); process.exitCode = 1; });
}
