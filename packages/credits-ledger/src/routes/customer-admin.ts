import { Router } from 'express';
import { listPlans, getPlan, upsertPlan, deletePlan, createCustomer, topupCredits, getCustomerSummary, listCustomers } from '../services/customer-admin.js';
import { query } from '../db/pool.js';

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

// POST /v1/admin/plans — create or update a plan
router.post('/v1/admin/plans', async (req, res) => {
  try {
    const { planId, planName, tier, annualFeeYuan, initialCredit, seatsMin, seatsMax,
            renewalDiscount, renewalPricePer100k, monthlyAllowance, features, sortOrder } = req.body;
    if (!planId || !planName || !tier || !annualFeeYuan || !initialCredit || !renewalPricePer100k) {
      res.status(400).json({
        code: 'VALIDATION',
        message: 'planId, planName, tier, annualFeeYuan, initialCredit, renewalPricePer100k are required',
      });
      return;
    }
    const plan = await upsertPlan({
      planId, planName, tier,
      annualFeeYuan: Number(annualFeeYuan),
      initialCredit: Number(initialCredit),
      seatsMin, seatsMax,
      renewalDiscount: renewalDiscount != null ? Number(renewalDiscount) : undefined,
      renewalPricePer100k: Number(renewalPricePer100k),
      monthlyAllowance: monthlyAllowance != null ? Number(monthlyAllowance) : undefined,
      features, sortOrder,
    });
    res.json({ ok: true, plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// DELETE /v1/admin/plans/:planId — delete a plan
router.delete('/v1/admin/plans/:planId', async (req, res) => {
  try {
    const ok = await deletePlan(req.params.planId);
    if (!ok) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Plan not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// POST /v1/admin/plans/:planId/freeze — freeze a plan (prevent new subscriptions)
router.post('/v1/admin/plans/:planId/freeze', async (req, res) => {
  try {
    const plan = await getPlan(req.params.planId);
    if (!plan) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Plan not found' });
      return;
    }
    // Mark plan as disabled (prevent new signups, existing accounts unaffected)
    await upsertPlan({
      planId: plan.planId,
      planName: plan.planName,
      tier: plan.tier,
      annualFeeYuan: plan.annualFeeYuan,
      initialCredit: plan.initialCredit,
      renewalPricePer100k: plan.renewalPricePer100k,
      monthlyAllowance: plan.monthlyAllowance,
      features: plan.features ?? undefined,
      sortOrder: -1, // move to bottom when frozen
    });
    // Add status column update via direct query
    await query('UPDATE plan_templates SET status = $1, updated_at = NOW() WHERE plan_id = $2',
      ['frozen', req.params.planId]);
    res.json({ ok: true, message: `Plan ${plan.planName} frozen` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// POST /v1/admin/plans/:planId/unfreeze — unfreeze a plan
router.post('/v1/admin/plans/:planId/unfreeze', async (req, res) => {
  try {
    const plan = await getPlan(req.params.planId);
    if (!plan) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Plan not found' });
      return;
    }
    await query('UPDATE plan_templates SET status = $1, updated_at = NOW() WHERE plan_id = $2',
      ['active', req.params.planId]);
    res.json({ ok: true, message: `Plan ${plan.planName} unfrozen` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// POST /v1/admin/plans/:planId/freeze-customers — freeze/unfreeze all customers on a plan
router.post('/v1/admin/plans/:planId/freeze-customers', async (req, res) => {
  try {
    const { action } = req.body; // 'freeze' or 'unfreeze'
    if (action !== 'freeze' && action !== 'unfreeze') {
      res.status(400).json({ code: 'VALIDATION', message: 'action must be "freeze" or "unfreeze"' });
      return;
    }

    const plan = await getPlan(req.params.planId);
    if (!plan) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Plan not found' });
      return;
    }

    const newStatus = action === 'freeze' ? 'suspended' : 'active';
    const result = await query(
      'UPDATE credits_accounts SET status = $1, updated_at = NOW() WHERE plan_id = $2 AND status != $3 RETURNING id, company_name',
      [newStatus, req.params.planId, newStatus]
    );

    const affected = result.rows.map((r: any) => ({ accountId: r.id, companyName: r.company_name }));
    res.json({
      ok: true,
      action,
      planName: plan.planName,
      affectedCount: affected.length,
      affected,
    });
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
      if (c.status === 'active') {
        acc.active = (acc.active || 0) + 1;
        acc.totalBalance = (acc.totalBalance || 0) + c.balance;
        acc.totalConsumed = (acc.totalConsumed || 0) + (c.lifetimeConsumed || 0);
        if (c.balance < 50000) acc.lowBalance = (acc.lowBalance || 0) + 1;
      }
      return acc;
    }, {});
    stats.total = customers.length;
    stats.closed = customers.filter(c => c.status === 'closed').length;

    res.json({ customers, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/admin/customers/:tenantId — customer detail (full audit trail)
router.get('/v1/admin/customers/:tenantId', async (req, res) => {
  try {
    const summary = await getCustomerSummary(req.params.tenantId);
    if (!summary) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Customer not found' });
      return;
    }

    const accountId = `acct_${req.params.tenantId}`;

    // All transactions (debit + credit + freeze + unfreeze)
    const { rows: allTxns } = await query(
      `SELECT id, type, amount, balance_before, balance_after, reference, description, category, created_at
       FROM credits_transactions
       WHERE account_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [accountId]
    );

    // Shadow billing events (estimated & settled, only shadow-priced skills)
    const { rows: estEvents } = await query(
      `SELECT id, skill_id, skill_name, credit_amount, quantity, status, billing_mode, result_summary, created_at
       FROM skill_billing_events
       WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [req.params.tenantId]
    );

    // Live billing events only (for live aggregation)
    const { rows: liveEvents } = await query(
      `SELECT id, skill_id, skill_name, credit_amount, quantity, status, created_at
       FROM skill_billing_events
       WHERE tenant_id = $1 AND billing_mode = 'live'
       ORDER BY created_at DESC LIMIT 500`,
      [req.params.tenantId]
    );

    // Shadow billing events only (for shadow aggregation)
    const { rows: shadowEvents } = await query(
      `SELECT id, skill_id, skill_name, credit_amount, quantity, status, created_at
       FROM skill_billing_events
       WHERE tenant_id = $1 AND billing_mode = 'shadow'
       ORDER BY created_at DESC LIMIT 500`,
      [req.params.tenantId]
    );

    // Daily consumption aggregation (live billing only)
    // Use AT TIME ZONE to correct UTC→Asia/Shanghai date boundaries
    const { rows: dailyConsumption } = await query(
      `SELECT DATE(created_at AT TIME ZONE 'Asia/Shanghai') as day,
              COALESCE(skill_name, skill_id) as skill,
              SUM(credit_amount) as total_credit,
              COUNT(*) as call_count
       FROM skill_billing_events
       WHERE tenant_id = $1 AND status = 'settled' AND billing_mode = 'live'
       GROUP BY DATE(created_at AT TIME ZONE 'Asia/Shanghai'), COALESCE(skill_name, skill_id)
       ORDER BY day DESC LIMIT 60`,
      [req.params.tenantId]
    );

    // Daily totals (for chart, live billing only)
    const { rows: dailyTotals } = await query(
      `SELECT DATE(created_at AT TIME ZONE 'Asia/Shanghai') as day,
              SUM(credit_amount) as total
       FROM skill_billing_events
       WHERE tenant_id = $1 AND status = 'settled' AND billing_mode = 'live'
       GROUP BY DATE(created_at AT TIME ZONE 'Asia/Shanghai')
       ORDER BY day DESC LIMIT 30`,
      [req.params.tenantId]
    );

    // Aggregate by skill from live billing events (settled)
    const liveBreakdown: Record<string, number> = {};
    for (const e of liveEvents) {
      if (e.status !== 'settled') continue;
      const key = e.skill_name || e.skill_id;
      liveBreakdown[key] = (liveBreakdown[key] || 0) + Number(e.credit_amount);
    }

    // Shadow billing aggregation (shadow-priced skills only)
    const shadowBreakdown: Record<string, number> = {};
    for (const e of shadowEvents) {
      if (e.status !== 'settled') continue;
      const key = e.skill_name || e.skill_id;
      shadowBreakdown[key] = (shadowBreakdown[key] || 0) + Number(e.credit_amount);
    }

    res.json({
      ...summary,
      // Full audit trail
      auditLog: allTxns.map((t: any) => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount),
        balanceBefore: Number(t.balance_before),
        balanceAfter: Number(t.balance_after),
        reference: t.reference,
        description: t.description,
        category: t.category,
        time: t.created_at,
        source: 'credits_transactions (DB)',
      })),
      // Billing events (with billing mode)
      billingEvents: estEvents.map((e: any) => ({
        id: e.id,
        skillId: e.skill_id,
        skillName: e.skill_name,
        credit: Number(e.credit_amount),
        quantity: e.quantity,
        status: e.status,
        billingMode: e.billing_mode || 'live',
        resultSummary: e.result_summary,
        time: e.created_at,
        source: 'skill_billing_events (Agent实时写入)',
      })),
      // Aggregations
      liveBreakdown,       // 正式计费：settled live billing events 按 Skill 汇总
      skillBreakdown: liveBreakdown,  // 向后兼容别名（旧前端引用）
      shadowBreakdown,     // 影子计费：settled shadow billing events 按 Skill 汇总（不扣费）
      liveConsumed: Object.values(liveBreakdown).reduce((s, v) => s + v, 0),
      shadowConsumed: Object.values(shadowBreakdown).reduce((s, v) => s + v, 0),
      dailyConsumption: dailyConsumption.map((d: any) => ({
        day: d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day).slice(0, 10),
        skill: d.skill,
        totalCredit: Number(d.total_credit),
        callCount: Number(d.call_count),
      })),
      dailyTotals: dailyTotals.map((d: any) => ({
        day: d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day).slice(0, 10),
        total: Number(d.total),
      })),
      dataSources: {
        transactions: 'credits_transactions — 扣费/充值记录 (T+1回填)',
        billingEvents: 'skill_billing_events — Agent Skill调用后实时写入 (~1s延迟)',
        dailyConsumption: '按日汇总 aggregating skill_billing_events WHERE settled',
      },
    });
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

// POST /v1/admin/customers/:tenantId/renew — renewal/续费 with plan-based pricing
router.post('/v1/admin/customers/:tenantId/renew', async (req, res) => {
  try {
    const { creditAmount, reason } = req.body;
    if (!creditAmount || creditAmount <= 0) {
      res.status(400).json({ code: 'VALIDATION', message: 'creditAmount must be positive' });
      return;
    }

    const tenantId = req.params.tenantId;
    const accountId = `acct_${tenantId}`;

    // Get customer's plan for pricing
    const { rows } = await query(
      'SELECT plan_id, plan_tier, id FROM credits_accounts WHERE tenant_id = $1 OR id = $2',
      [tenantId, `acct_${tenantId}`]
    );
    if (rows.length === 0) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Customer not found' });
      return;
    }

    const planId = rows[0].plan_id || 'start';
    const planResult = await query('SELECT * FROM plan_templates WHERE plan_id = $1', [planId]);
    const plan = planResult.rows[0];

    // Calculate price
    const blocksOf100k = creditAmount / 100000;
    const pricePer100k = plan ? Number(plan.renewal_price_per_100k) : 1000;
    const discount = plan ? Number(plan.renewal_discount) : 1.0;
    const estimatedCost = Math.round(blocksOf100k * pricePer100k);

    const result = await topupCredits({
      tenantId,
      amount: creditAmount,
      reason: reason || `续费充值（${plan?.plan_name || planId} 套餐，${blocksOf100k.toFixed(1)} 个 100K 块）`,
    });

    if (!result.ok) {
      res.status(404).json(result);
      return;
    }

    res.json({
      ...result,
      planTier: plan?.plan_name || planId,
      pricePer100k,
      discount,
      estimatedCost,
      creditAmount,
      message: `续费成功！¥${estimatedCost.toLocaleString()} → ${creditAmount.toLocaleString()} Credit（${plan?.plan_name || planId} 套餐 ${Math.round((1-discount)*100)}% off）`,
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
  // Keep alphanumeric, Chinese chars, replace spaces/special with underscore
  const cleaned = name.replace(/\s+/g, '_').replace(/[^\w一-鿿]/g, '');
  // If result is mostly Chinese, use first 2 chars + hash
  if (/[一-鿿]/.test(cleaned) && cleaned.replace(/[a-z0-9_]/g, '').length > cleaned.length / 2) {
    // Chinese name: use pinyin approximation or just hash
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
    return 'client_' + Math.abs(hash).toString(36).slice(0, 8);
  }
  return cleaned.toLowerCase().replace(/[^a-z0-9_]/g, '') || 'client_' + Date.now().toString(36);
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
