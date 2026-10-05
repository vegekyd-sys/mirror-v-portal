import { describe, expect, it } from 'vitest';
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
});
