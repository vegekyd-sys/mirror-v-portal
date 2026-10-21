import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createApp } from '../app.js';
import { registrationAvatarPreset } from '../services/feishu-register.js';

describe('template avatar', () => {
  it('pre-selects Makaron artwork instead of the deployment fallback', () => {
    const url = 'https://mirror-v-portal.vercel.app/onboard/assets/makaron-avatar.png';
    expect(registrationAvatarPreset({ avatarUrl: url }, 'https://example.com/legacy.png')).toEqual({ avatar: [url] });
  });
  it('keeps the existing fallback for templates without an avatar', () => {
    expect(registrationAvatarPreset({}, ' https://example.com/one.png, https://example.com/two.png ')).toEqual({ avatar: ['https://example.com/one.png', 'https://example.com/two.png'] });
    expect(registrationAvatarPreset({}, '')).toEqual({});
  });
  it('does not register an invalid explicit avatar', () => {
    for (const avatarUrl of ['data:image/png;base64,test', 'http://example.com/image.png', 'https://user:password@example.com/image.png']) {
      expect(() => registrationAvatarPreset({ avatarUrl })).toThrow('INVALID_TEMPLATE_AVATAR_URL');
    }
  });
  it('serves the exact public avatar for the native creation page on another origin', async () => {
    const app = createApp();
    const result = await request(app).get('/onboard/assets/makaron-avatar-5b2041a99122.png').set('Origin', 'https://open.feishu.cn');
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('image/png');
    expect(result.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(createHash('sha256').update(result.body).digest('hex')).toBe('5b2041a991225001a3574c43377b028ae36f9bc1a61cffef96be3bc91e09d362');
    const other = await request(app).get('/onboard/assets/nexus-world-v2.webp');
    expect(other.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('allows the downloaded local video through the onboarding media policy', async () => {
    const result = await request(createApp()).get('/onboard');
    expect(result.status).toBe(200);
    expect(result.headers['content-security-policy']).toContain("media-src 'self' blob:");
    expect(result.headers['content-security-policy']).toContain("object-src 'none'");
  });

  it.each([
    ['dealclaw', 'b651b1783968'],
    ['xingqing', 'a376b49895b1'],
    ['makaron', '154a2a9faba7'],
    ['mirror-v', '1260c99c184d'],
  ])('allows Feishu canvas conversion of the %s portrait, including refreshed URLs', async (agent, hash) => {
    const pathname = `/onboard/assets/agent-${agent}-portrait-${hash}.png?v=canvas-cors-20261021`;
    const result = await request(createApp()).get(pathname).set('Origin', 'https://open.feishu.cn');
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('image/png');
    expect(result.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(createHash('sha256').update(result.body).digest('hex').slice(0, 12)).toBe(hash);
    expect(registrationAvatarPreset({ avatarUrl: `https://mirror-v-portal.vercel.app${pathname}` })).toEqual({ avatar: [`https://mirror-v-portal.vercel.app${pathname}`] });
  });

});
