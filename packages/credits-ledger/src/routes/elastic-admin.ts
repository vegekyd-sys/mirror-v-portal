import { Router } from 'express';
import { query } from '../db/pool.js';

/** Read-only administration of the Elastic runtime on the shared Nexus DB. */
const router = Router();

router.get('/summary', async (_req, res) => {
  try {
    const [agents, runs, customers] = await Promise.all([
      query(`SELECT template_id AS "templateId", state, count(*)::int AS count
             FROM elastic_tenants GROUP BY template_id, state ORDER BY template_id, state`),
      query(`SELECT status, count(*)::int AS count FROM elastic_runs GROUP BY status ORDER BY status`),
      query(`SELECT count(*)::int AS count, coalesce(sum(balance),0)::bigint AS balance
             FROM credits_accounts`),
    ]);
    res.json({
      agents: agents.rows,
      runs: runs.rows,
      customers: {
        count: customers.rows[0]?.count ?? 0,
        balance: Number(customers.rows[0]?.balance ?? 0),
      },
    });
  } catch (error) {
    console.error('[elastic-admin] summary failed', error);
    res.status(503).json({ code: 'ELASTIC_ADMIN_UNAVAILABLE' });
  }
});

router.get('/agents', async (_req, res) => {
  try {
    const { rows } = await query(`
      SELECT t.id AS "tenantId", t.name, t.template_id AS "templateId",
             t.template_version AS "templateVersion", t.runtime_provider AS "runtimeProvider",
             t.state, t.created_at AS "createdAt", t.last_activity AS "lastActivity",
             t.last_error AS "lastError", t.wake_count AS "wakeCount",
             (t.app_id IS NOT NULL) AS "feishuBound",
             coalesce((SELECT array_agg(b.channel ORDER BY b.channel)
                       FROM elastic_channel_bindings b
                       WHERE b.tenant_id=t.id AND b.state='active'), ARRAY[]::text[]) AS channels,
             a.id AS "accountId", a.balance
      FROM elastic_tenants t
      LEFT JOIN credits_accounts a ON a.tenant_id=t.id
      ORDER BY t.created_at DESC`);
    res.json({ agents: rows });
  } catch (error) {
    console.error('[elastic-admin] agents failed', error);
    res.status(503).json({ code: 'ELASTIC_ADMIN_UNAVAILABLE' });
  }
});

router.get('/agents/:tenantId/runs', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, channel, status, delivery, created_at AS "createdAt",
             completed_at AS "completedAt", error
      FROM elastic_runs WHERE tenant_id=$1
      ORDER BY created_at DESC LIMIT 50`, [req.params.tenantId]);
    res.json({ runs: rows });
  } catch (error) {
    console.error('[elastic-admin] runs failed', error);
    res.status(503).json({ code: 'ELASTIC_ADMIN_UNAVAILABLE' });
  }
});

export default router;
