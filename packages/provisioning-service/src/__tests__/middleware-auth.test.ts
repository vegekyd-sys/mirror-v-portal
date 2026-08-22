import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import {
  createServiceOrAdminAuthMiddleware,
  verifyAdminJwt,
} from '../middleware/auth.js';

const SECRET = 'test-jwt-secret';

function signJwt(payload: object, secret: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const toSign = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}`;
  const sig = createHmac('sha256', secret).update(toSign).digest('base64url');
  return `${toSign}.${sig}`;
}

function runAuth(mw: ReturnType<typeof createServiceOrAdminAuthMiddleware>, authHeader?: string) {
  const req = { headers: authHeader ? { authorization: authHeader } : {} } as Request;
  let status = 0;
  let body: any = null;
  let passed = false;
  const res = {
    status: (s: number) => ((status = s), res),
    json: (b: unknown) => ((body = b), res),
  } as unknown as Response;
  const next: NextFunction = () => {
    passed = true;
  };
  mw(req, res, next);
  return { status, body, passed, req };
}

describe('createServiceOrAdminAuthMiddleware', () => {
  const savedService = process.env.PROVISIONING_API_TOKEN;
  const savedJwt = process.env.ADMIN_JWT_SECRET;

  beforeEach(() => {
    process.env.PROVISIONING_API_TOKEN = 'svc-token';
    process.env.ADMIN_JWT_SECRET = SECRET;
  });

  afterEach(() => {
    if (savedService === undefined) delete process.env.PROVISIONING_API_TOKEN;
    else process.env.PROVISIONING_API_TOKEN = savedService;
    if (savedJwt === undefined) delete process.env.ADMIN_JWT_SECRET;
    else process.env.ADMIN_JWT_SECRET = savedJwt;
  });

  const mw = () => createServiceOrAdminAuthMiddleware('PROVISIONING_API_TOKEN');

  it('accepts the shared service token', () => {
    const r = runAuth(mw(), 'Bearer svc-token');
    expect(r.passed).toBe(true);
  });

  it('accepts a valid admin JWT and attaches adminUser', () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signJwt({ sub: 'adm_seed_001', username: 'maqing', role: 'admin', iat: now, exp: now + 3600 }, SECRET);
    const r = runAuth(mw(), `Bearer ${jwt}`);
    expect(r.passed).toBe(true);
    expect((r.req as any).adminUser.username).toBe('maqing');
  });

  it('rejects a JWT signed with a different secret', () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signJwt({ sub: 'x', username: 'x', role: 'admin', iat: now, exp: now + 3600 }, 'wrong-secret');
    const r = runAuth(mw(), `Bearer ${jwt}`);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
  });

  it('rejects an expired admin JWT', () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signJwt({ sub: 'x', username: 'x', role: 'admin', iat: now - 7200, exp: now - 3600 }, SECRET);
    expect(verifyAdminJwt(jwt)).toBeNull();
    const r = runAuth(mw(), `Bearer ${jwt}`);
    expect(r.status).toBe(401);
  });

  it('rejects missing token', () => {
    const r = runAuth(mw());
    expect(r.status).toBe(401);
  });

  it('503 when neither secret is configured', () => {
    delete process.env.PROVISIONING_API_TOKEN;
    delete process.env.ADMIN_JWT_SECRET;
    const r = runAuth(mw(), 'Bearer anything');
    expect(r.status).toBe(503);
  });
});
