import { Router } from 'express';
import { listPlans, createCustomer, topupCredits, getCustomerSummary, listCustomers } from '../services/customer-admin.js';

const router = Router();

// ── Plan Templates ──

// GET /v1/admin/plans — list all plan templates
router.get('/v1/admin/plans', async (_req, res) => {
  try {
    const plans = await listPlans();
    res.json({ plans });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// ── Customer Management ──

// GET /v1/admin/customers — list all customers
router.get('/v1/admin/customers', async (req, res) => {
  try {
    const customers = await listCustomers(req.query.status as string | undefined);
    // Stats
    const stats = customers.reduce((acc: any, c) => {
      acc[c.status] = (acc[c.status] || 0) + 1;
      if (c.balance < 50000 && c.status === 'active') acc.lowBalance = (acc.lowBalance || 0) + 1;
      return acc;
    }, {});
    stats.total = customers.length;
    stats.totalBalance = customers.reduce((s: number, c: any) => s + c.balance, 0);
    stats.totalConsumed = customers.reduce((s: number, c: any) => s + c.totalConsumed, 0);

    res.json({ customers, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/admin/customers/:tenantId — customer detail
router.get('/v1/admin/customers/:tenantId', async (req, res) => {
  try {
    const summary = await getCustomerSummary(req.params.tenantId);
    if (!summary) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Customer not found' });
      return;
    }
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// POST /v1/admin/customers — create a customer with plan
router.post('/v1/admin/customers', async (req, res) => {
  try {
    const { tenantId, companyName, contactName, contactEmail, planId } = req.body;
    if (!tenantId || !planId) {
      res.status(400).json({ code: 'VALIDATION', message: 'tenantId and planId are required' });
      return;
    }

    const result = await createCustomer({ tenantId, companyName, contactName, contactEmail, planId });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }

    res.json({
      ...result,
      message: `客户 ${companyName || tenantId} 已开通 ${result.planName}，初始 ${result.balance?.toLocaleString()} Credit`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// POST /v1/admin/customers/:tenantId/topup — top-up credits
router.post('/v1/admin/customers/:tenantId/topup', async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || amount <= 0) {
      res.status(400).json({ code: 'VALIDATION', message: 'amount must be positive' });
      return;
    }

    const result = await topupCredits({
      tenantId: req.params.tenantId,
      amount: Math.floor(amount),
      reason,
    });

    if (!result.ok) {
      res.status(404).json(result);
      return;
    }

    res.json({
      ...result,
      message: `已充值 ${amount.toLocaleString()} Credit，余额 ${result.balanceBefore?.toLocaleString()} → ${result.balanceAfter?.toLocaleString()}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// ── V Command Interface ──

// POST /v1/admin/v-command — natural language admin command for V
router.post('/v1/admin/v-command', async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) {
      res.status(400).json({ code: 'VALIDATION', message: 'command is required' });
      return;
    }

    const result = await executeVCommand(command);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL', message: String(err) });
  }
});

/**
 * Parse and execute a natural language admin command from Tianyi.
 * 
 * Supported patterns:
 *   "给 XX 客户开 Start 套餐" / "开通XX start 500K"
 *   "给 XX 充值 100K Credit"
 *   "查看 XX 客户"
 *   "客户列表"
 */
async function executeVCommand(command: string): Promise<{ ok: boolean; action: string; message: string; data?: any }> {
  const cmd = command.trim();

  // Pattern: 给/为 XX 客户 开/开通 Start/Growth/Ultra/Enterprise
  const createMatch = cmd.match(/(?:给|为)\s*(.+?)(?:客户)?\s*(?:开|开通|激活)\s*(start|growth|ultra|enterprise|启航|成长|规模|企业)/i);
  if (createMatch) {
    const name = createMatch[1].trim();
    const planMap: Record<string, string> = { '启航': 'start', '成长': 'growth', '规模': 'ultra', '企业': 'enterprise' };
    const planId = planMap[createMatch[2].toLowerCase()] || createMatch[2].toLowerCase();
    const tenantId = nameToTenantId(name);

    const result = await createCustomer({
      tenantId,
      companyName: name,
      planId,
    });

    if (result.ok) {
      return {
        ok: true,
        action: 'create_customer',
        message: `✅ ${name} 已开通 ${result.planName}\n初始 Credit: ${result.balance?.toLocaleString()}\n可在后台查看: https://43.156.232.2:8443/admin/`,
        data: result,
      };
    }
    return { ok: false, action: 'create_customer', message: `❌ 开通失败: ${result.error}` };
  }

  // Pattern: 给/为 XX 充值 N Credit / N K
  const topupMatch = cmd.match(/(?:给|为)\s*(.+?)(?:客户)?\s*(?:充值|加|再给)\s*(\d+)\s*(?:k|K|万|w|W)?\s*(?:credit)?/i);
  if (topupMatch) {
    const name = topupMatch[1].trim();
    const rawAmount = parseInt(topupMatch[2]);
    let amount = rawAmount;
    // If followed by k/K, multiply by 1000
    if (/[kK]/.test(topupMatch[0])) amount *= 1000;
    // If followed by 万/w, multiply by 10000
    if (/[万wW]/.test(topupMatch[0])) amount *= 10000;

    const tenantId = nameToTenantId(name);
    const result = await topupCredits({ tenantId, amount });

    if (result.ok) {
      return {
        ok: true,
        action: 'topup',
        message: `✅ ${name} 已充值 ${amount.toLocaleString()} Credit\n余额: ${result.balanceBefore?.toLocaleString()} → ${result.balanceAfter?.toLocaleString()}`,
        data: result,
      };
    }
    return { ok: false, action: 'topup', message: `❌ 充值失败: ${result.error}` };
  }

  // Pattern: 查看/查 XX 客户
  const viewMatch = cmd.match(/(?:查看|查|看看)\s*(.+?)(?:客户)?$/i);
  if (viewMatch) {
    const name = viewMatch[1].trim();
    const tenantId = nameToTenantId(name);
    const summary = await getCustomerSummary(tenantId);

    if (!summary) {
      return { ok: false, action: 'view_customer', message: `❌ 未找到客户: ${name}` };
    }

    return {
      ok: true,
      action: 'view_customer',
      message: formatCustomerCard(summary),
      data: summary,
    };
  }

  // Pattern: 客户列表 / 所有客户
  if (/(?:客户列表|所有客户|列出客户)/i.test(cmd)) {
    const customers = await listCustomers();
    const active = customers.filter(c => c.status === 'active');
    const totalBalance = active.reduce((s, c) => s + c.balance, 0);
    const totalConsumed = active.reduce((s, c) => s + c.totalConsumed, 0);

    const lines = [`📊 客户总览（${customers.length} 个客户，${active.length} 个活跃）`];
    lines.push(`总余额: ${(totalBalance/1000).toFixed(0)}K | 总消耗: ${(totalConsumed/1000).toFixed(0)}K`);
    lines.push('');
    for (const c of customers) {
      const pct = c.lifetimeConsumed > 0 ? Math.round(c.totalConsumed / c.lifetimeConsumed * 100) : 0;
      lines.push(`${c.status === 'active' ? '🟢' : '⏸️'} ${c.companyName || c.tenantId} | ${c.planTier} | 余额 ${(c.balance/1000).toFixed(0)}K | 已用 ${(c.totalConsumed/1000).toFixed(0)}K`);
    }

    return { ok: true, action: 'list_customers', message: lines.join('\n') };
  }

  return {
    ok: false,
    action: 'unknown',
    message: `❌ 没理解指令。支持的格式:\n• "给 XX 开通 start"\n• "给 XX 充值 100K"\n• "查看 XX"\n• "客户列表"`,
  };
}

function nameToTenantId(name: string): string {
  // Pinyin/simple slug: remove spaces, lowercase
  return name.replace(/\s+/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function formatCustomerCard(s: any): string {
  const pct = s.lifetimeConsumed > 0 ? Math.round(s.totalConsumed / s.lifetimeConsumed * 100) : 0;
  return [
    `📋 ${s.companyName || s.tenantId}`,
    `套餐: ${s.planName || s.planTier}`,
    s.planDetails ? `年费: ¥${s.planDetails.annualFee.toLocaleString()} | 续充: ¥${s.planDetails.renewalPrice}/100K (${Math.round((1-s.planDetails.renewalDiscount)*100)}% off)` : '',
    `余额: ${(s.balance/1000).toFixed(0)}K / 累计获得 ${(s.lifetimeCredited/1000).toFixed(0)}K`,
    `30天消耗: ${(s.consumed30d/1000).toFixed(1)}K | 累计消耗: ${(s.totalConsumed/1000).toFixed(0)}K`,
    `任务数: ${s.totalTasks}`,
    s.subscriptionEnd ? `到期: ${new Date(s.subscriptionEnd).toLocaleDateString('zh-CN')}` : '',
    `状态: ${s.status === 'active' ? '🟢 正常' : s.status}`,
  ].filter(Boolean).join('\n');
}

export default router;
