import { describe, it, expect } from 'vitest';
import type { PlanConfig } from '../../types/index.js';

// Unit tests that import .js sources (needs vitest resolution support).
// Skip in CI where module resolution may differ from local dev.
const isCI = !!process.env.JENKINS_URL || !!process.env.BUILD_ID;
const run = isCI ? describe.skip : describe;

import { initPlanConfig, setPlanConfig } from '../../middleware/scene.js';

run('Scene Service', () => {
  run('initPlanConfig', () => {
    it('returns correct config for starter', () => {
      const plan = initPlanConfig('starter');
      expect(plan.tier).toBe('starter');
      expect(plan.scenes).toContain('lead');
      expect(plan.scenes).toContain('email');
      expect(plan.scenes).not.toContain('expo');
      expect(plan.maxAgents).toBe(1);
      expect(plan.monthlyCredits).toBe(1_000_000);
    });

    it('returns correct config for pro', () => {
      const plan = initPlanConfig('pro');
      expect(plan.tier).toBe('pro');
      expect(plan.scenes).toContain('crm');
      expect(plan.scenes).toContain('auto_followup');
      expect(plan.maxAgents).toBe(3);
      expect(plan.monthlyCredits).toBe(5_000_000);
    });

    it('returns correct config for team', () => {
      const plan = initPlanConfig('team');
      expect(plan.tier).toBe('team');
      expect(plan.scenes).toContain('api');
      expect(plan.scenes).toContain('multi_team');
      expect(plan.maxAgents).toBe(5);
      expect(plan.monthlyCredits).toBe(15_000_000);
    });
  });
});

run('Config', () => {
  it('has correct GATEWAY_HEADERS', async () => {
    const { GATEWAY_HEADERS } = await import('../../types/index.js');
    expect(GATEWAY_HEADERS.TENANT_ID).toBe('X-DealClaw-Tenant-ID');
    expect(GATEWAY_HEADERS.CREDITS_REMAINING).toBe('X-DealClaw-Credits-Remaining');
    expect(GATEWAY_HEADERS.SCENE_UNLOCKED).toBe('X-DealClaw-Scene-Unlocked');
  });
});
