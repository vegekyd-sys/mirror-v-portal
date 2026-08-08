/**
 * Scene Unlock Middleware
 * 
 * Checks whether the requested operation is allowed under the current plan tier.
 * Returns SCENE_LOCKED if the customer tries to use a feature not in their plan.
 */

import type { Request, Response, NextFunction } from 'express';
import type { PlanConfig, PlanTier, GatewayError } from '../types/index.js';

const PLAN_SCENES: Record<PlanTier, string[]> = {
  starter: ['lead', 'email'],
  growth: ['lead', 'email', 'expo', 'research'],
  pro: ['lead', 'email', 'expo', 'research', 'crm', 'auto_followup'],
  team: ['lead', 'email', 'expo', 'research', 'crm', 'auto_followup', 'api', 'multi_team'],
};

export function initPlanConfig(tier: PlanTier): PlanConfig {
  return {
    tier,
    maxAgents: { starter: 1, growth: 2, pro: 3, team: 5 }[tier],
    cpuLimit: { starter: '2', growth: '4', pro: '6', team: '8' }[tier],
    memoryLimit: { starter: '4Gi', growth: '8Gi', pro: '12Gi', team: '16Gi' }[tier],
    scenes: PLAN_SCENES[tier],
    monthlyCredits: { starter: 1_000_000, growth: 2_000_000, pro: 5_000_000, team: 15_000_000 }[tier],
  };
}

let DEFAULT_PLAN: PlanConfig = initPlanConfig('starter');

// N2 FIX: cached scene list for request header injection
let _cachedScenes: string | null = null;

/** N2 FIX: get cached scene CSV string */
export function sceneHeaders(tier: PlanTier): string {
  if (!_cachedScenes) {
    _cachedScenes = PLAN_SCENES[tier].join(',');
  }
  return _cachedScenes;
}

export function setPlanConfig(plan: PlanConfig) {
  DEFAULT_PLAN = plan;
}

/**
 * Express middleware: check scene access
 */
export function sceneMiddleware(req: Request, res: Response, next: NextFunction) {
  const plan = DEFAULT_PLAN;
  const requiredScene = req.body?.scene as string | undefined;

  if (!requiredScene) {
    // No specific scene required — allow
    next();
    return;
  }

  if (!plan.scenes.includes(requiredScene)) {
    const err: GatewayError = {
      code: 'SCENE_LOCKED',
      message: `Scene "${requiredScene}" is not available on your ${plan.tier} plan`,
      detail: `Available scenes: ${plan.scenes.join(', ')}`,
    };
    res.status(403).json(err);
    return;
  }

  next();
}
