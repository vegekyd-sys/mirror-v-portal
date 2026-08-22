import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';

// Gateway headers injected by nexus-gateway
const GATEWAY_HEADERS = {
  TENANT_ID: 'x-dealclaw-tenant-id',
  USER_ID: 'x-dealclaw-user-id',
  KEY_CONFIG_REF: 'x-dealclaw-key-config-ref',
  CREDITS_REMAINING: 'x-dealclaw-credits-remaining',
  SCENE_UNLOCKED: 'x-dealclaw-scene-unlocked',
  PLAN_TIER: 'x-dealclaw-plan-tier',
};

export interface MockConfig {
  /** Fail with given status code to simulate errors */
  failWithStatus?: number;
  /** Delay response by N ms */
  delayMs?: number;
}

let mockConfig: MockConfig = {};

export function setMockConfig(cfg: MockConfig) {
  mockConfig = { ...mockConfig, ...cfg };
}

export function getMockConfig(): MockConfig {
  return { ...mockConfig };
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  // Health check
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'mock-agent', version: '0.1.0' });
  });

  /**
   * POST /execute — Simulate DealClaw agent execution.
   *
   * Receives gateway-forwarded request with tenant/user context headers.
   * Returns realistic agent responses.
   */
  app.post('/execute', async (req: Request, res: Response) => {
    const tenantId = req.headers[GATEWAY_HEADERS.TENANT_ID] as string || 'unknown';
    const userId = req.headers[GATEWAY_HEADERS.USER_ID] as string || 'unknown';
    const planTier = req.headers[GATEWAY_HEADERS.PLAN_TIER] as string || 'starter';
    const creditsRemaining = req.headers[GATEWAY_HEADERS.CREDITS_REMAINING] as string || 'N/A';
    const intent = req.body?.intent;
    const message = req.body?.message || req.body?.text || '';

    // Configurable delay
    if (mockConfig.delayMs) {
      await new Promise(r => setTimeout(r, mockConfig.delayMs));
    }

    // Configurable failure
    if (mockConfig.failWithStatus) {
      res.status(mockConfig.failWithStatus).json({
        code: 'AGENT_ERROR',
        message: `Mock agent simulated error ${mockConfig.failWithStatus}`,
      });
      return;
    }

    // Route by intent
    const response = handleIntent(intent, message, { tenantId, userId, planTier, creditsRemaining });

    res.json({
      ok: true,
      agent: 'mock-agent',
      ...response,
      meta: {
        tenantId,
        planTier,
        creditsRemaining,
        processedAt: new Date().toISOString(),
      },
    });
  });

  // Admin: set mock behavior
  app.post('/admin/config', (req: Request, res: Response) => {
    setMockConfig(req.body);
    res.json({ ok: true, config: getMockConfig() });
  });

  // Admin: reset mock config
  app.delete('/admin/config', (_req, res) => {
    mockConfig = {};
    res.json({ ok: true, config: getMockConfig() });
  });

  return app;
}

function handleIntent(
  intent: any,
  message: string,
  ctx: { tenantId: string; userId: string; planTier: string; creditsRemaining: string },
) {
  const kind = intent?.kind || 'chat';

  switch (kind) {
    case 'search_buyers':
      return {
        intent: 'search_buyers',
        result: {
          leads: [
            {
              company: 'Munich Energy GmbH',
              country: 'Germany',
              industry: 'Solar Inverters',
              matchScore: 92,
              reason: 'German micro-inverter distributor, fits your product line',
            },
            {
              company: 'Berlin SolarTech AG',
              country: 'Germany',
              industry: 'Renewable Energy',
              matchScore: 85,
              reason: 'Growing installer network in DACH region',
            },
            {
              company: 'PV Solutions Hamburg',
              country: 'Germany',
              industry: 'Solar Distribution',
              matchScore: 78,
              reason: 'Imports Chinese PV components regularly',
            },
          ],
          total: 3,
        },
      };

    case 'company_profile':
      return {
        intent: 'company_profile',
        result: {
          company: {
            name: 'Munich Energy GmbH',
            founded: 2012,
            country: 'Germany',
            city: 'Munich',
            employees: '50-200',
            revenue: '$10M-$50M',
          },
          profile: {
            industry: 'Solar Inverters & Battery Storage',
            mainProducts: ['Micro-inverters', 'Battery systems', 'Monitoring software'],
            businessModel: 'Distributor',
            companyType: 'Trading',
          },
          recommendation: {
            score: 4,
            reason: 'High match — they import micro-inverters from China and your product line fits their portfolio',
          },
        },
      };

    case 'generate_email':
      return {
        intent: 'generate_email',
        result: {
          subject: 'Micro-inverter partnership opportunity — Solarunis',
          body: `Dear Munich Energy team,

I came across your impressive portfolio in solar inverter distribution across the DACH region. Solarunis specializes in high-efficiency micro-inverters that could complement your existing product line.

Key highlights:
- Efficiency: 97.5% peak
- Warranty: 25 years
- Certifications: TÜV, VDE, CE

Would you be open to a brief call to explore potential collaboration?

Best regards,
${ctx.tenantId} Team`,
          channel: 'email',
        },
      };

    case 'chat':
    default:
      return {
        intent: 'chat',
        reply: `你好！我是 DealClaw AI 销售助手（Mock Agent）。

当前租户: ${ctx.tenantId}
套餐: ${ctx.planTier}
剩余 credits: ${ctx.creditsRemaining}

我可以帮你：
• 搜索海外买家
• 生成企业画像
• 写多语言开发信
• 管理知识库

你想做什么？`,
      };
  }
}
