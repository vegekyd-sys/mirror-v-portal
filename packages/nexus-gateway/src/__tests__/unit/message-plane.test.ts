import { describe, it, expect } from 'vitest';
import { shouldStartWSClient } from '../../ws-client.js';

describe('shouldStartWSClient (P2 message plane)', () => {
  it('starts WS for feishu platform on the default gateway plane', () => {
    expect(shouldStartWSClient('feishu', undefined)).toBe(true);
    expect(shouldStartWSClient('feishu', 'gateway')).toBe(true);
  });

  it('never starts WS when the openclaw plugin owns the message plane', () => {
    expect(shouldStartWSClient('feishu', 'openclaw')).toBe(false);
  });

  it('web platform never starts WS regardless of plane', () => {
    expect(shouldStartWSClient('web', undefined)).toBe(false);
    expect(shouldStartWSClient('web', 'gateway')).toBe(false);
    expect(shouldStartWSClient('web', 'openclaw')).toBe(false);
  });
});
