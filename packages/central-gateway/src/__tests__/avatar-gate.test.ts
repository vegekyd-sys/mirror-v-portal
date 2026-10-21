import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { checkTemplateAvatars } from '../check-template-avatars.js';
import { nativeAvatarUrl } from '../services/avatar-policy.js';

const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
const digest = createHash('sha256').update(png).digest('hex').slice(0, 12);
const filename = `agent-future-new-agent-portrait-${digest}.png`;
const url = `https://mirror-v-portal.vercel.app/onboard/assets/${filename}`;

describe('future template avatar publication gate', () => {
  it('adds the shared cache version to a newly configured template without operator parameters', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ templates: [{ id: 'future-agent', avatarUrl: url, listed: true }] }));
    try {
      const response = await request(createApp()).get('/onboard/templates');
      expect(response.status).toBe(200);
      expect(response.body.templates[0].avatarUrl).toBe(`${url}?v=canvas-cors-20261021`);
    } finally { vi.unstubAllGlobals(); }
  });
  it('serves a previously unknown Agent with anonymous CORS and automatic cache version', async () => {
    const file = fileURLToPath(new URL(`../../public/onboard/${filename}`, import.meta.url));
    fs.writeFileSync(file, png);
    try {
      const response = await request(createApp()).get(`/onboard/assets/${filename}`).set('Origin', 'https://open.feishu.cn');
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(nativeAvatarUrl(url, 'https://mirror-v-portal.vercel.app')).toBe(`${url}?v=canvas-cors-20261021`);
      const signed = 'https://other.example/onboard/assets/' + filename + '?signature=keep';
      expect(nativeAvatarUrl(signed, 'https://mirror-v-portal.vercel.app')).toBe(signed);
    } finally { fs.unlinkSync(file); }
  });

  function fixture(avatar = url, bytes: Buffer | string = png, cors: string | null = '*', mime = 'image/png') {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return calls.length === 1
        ? Response.json({ templates: [{ id: 'future-agent', avatarUrl: avatar }] })
        : new Response(bytes, { headers: { 'content-type': mime, ...(cors ? { 'access-control-allow-origin': cors } : {}) } });
    }) as typeof fetch;
    return { calls, fetcher };
  }
  it('decodes valid PNG artwork and checks the real hash and CORS request', async () => {
    const { fetcher, calls } = fixture();
    expect(await checkTemplateAvatars('https://example.com/catalog', fetcher)).toMatchObject([{ id: 'future-agent', width: 1, height: 1, cors: true }]);
    expect(calls[1].init).toMatchObject({ headers: { Origin: 'https://open.feishu.cn' }, redirect: 'error' });
  });
  it('blocks the original 200-but-no-CORS failure', async () => {
    await expect(checkTemplateAvatars('https://example.com/catalog', fixture(url, png, null).fetcher)).rejects.toThrow('AVATAR_CORS_FAILED:future-agent');
  });
  it('blocks HTML, corrupt PNG data and mismatched content hashes', async () => {
    for (const [fetcher, error] of [
      [fixture(url, '<html>not an image</html>', '*', 'text/html').fetcher, 'AVATAR_MIME_FAILED'],
      [fixture(url, png.subarray(0, 34)).fetcher, 'AVATAR_IMAGE_INVALID'],
      [fixture(url.replace(digest, '000000000000')).fetcher, 'AVATAR_HASH_FAILED'],
    ] as const) await expect(checkTemplateAvatars('https://example.com/catalog', fetcher)).rejects.toThrow(error);
  });
  it('blocks an absent avatar or insecure URL', async () => {
    const noAvatar = (async () => Response.json({ templates: [{ id: 'future-agent' }] })) as typeof fetch;
    await expect(checkTemplateAvatars('https://example.com/catalog', noAvatar)).rejects.toThrow('AVATAR_REQUIRED');
    const insecure = fixture(url.replace('https:', 'http:'));
    await expect(checkTemplateAvatars('https://example.com/catalog', insecure.fetcher)).rejects.toThrow('AVATAR_URL_INVALID');
    expect(insecure.calls).toHaveLength(1);
  });
});
