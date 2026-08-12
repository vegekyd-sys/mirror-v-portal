/**
 * Admin Skills Routes — skill sync, activate, reject.
 *
 * POST /v1/admin/skills/sync
 *   Scans dealclaw-agent payload/skills/ for SKILL.md files.
 *   Auto-registers any skill not yet in skill_prices as status=shadow, activation=pending.
 *   Auto-prices based on category + keywords.
 *   Returns: { registered: [...], skipped: N, errors: [...] }
 *
 * POST /v1/admin/skills/:skillId/activate
 *   Activates a pending skill → activation_status=approved.
 *   Body: { finalPrice?: number }
 *
 * POST /v1/admin/skills/:skillId/reject
 *   Rejects a pending skill → activation_status=rejected.
 */

import { Router, type Request, type Response } from 'express';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '../db/pool.js';
import { requireAdmin, requireRole } from './admin-auth.js';

const router = Router();

// ── Auto-pricing rules ──

const CATEGORY_BASE: Record<string, number> = {
  insight: 5000,
  buyer: 300,
  outreach: 80,
  exhibition: 300,
  content: 3000,
  action: 500,
  planning: 1500,
  admin: 100,
  internal: 100,
  account: 200,
  customer: 500,
};

function extractCategory(skillId: string, content: string): string {
  // Try to extract from SKILL.md content
  const catMatch = content.match(/category[：:]\s*(\w+)/i);
  if (catMatch) return catMatch[1].toLowerCase();

  // Fall back to prefix-based
  const prefix = skillId.split('-')[0];
  return prefix || 'other';
}

function extractChineseName(content: string): string {
  const nameMatch = content.match(/(?:中文名|名称|name)[：:]\s*(.+)/i);
  if (nameMatch) return nameMatch[1].trim().slice(0, 128);
  return '';
}

function extractDescription(content: string): string {
  const descMatch = content.match(/(?:描述|description|说明)[：:]\s*(.+)/i);
  if (descMatch) return descMatch[1].trim().slice(0, 256);
  return '';
}

function extractResponsiblePerson(content: string): string | null {
  const personMatch = content.match(/(?:负责人|responsible|owner)[：:]\s*(.+)/i);
  if (personMatch) return personMatch[1].trim().slice(0, 64);
  return null;
}

function autoPrice(category: string, skillId: string, content: string): number {
  const base = CATEGORY_BASE[category] ?? 200;
  let multiplier = 1.0;

  const lower = (skillId + content).toLowerCase();

  // Video / AI multipliers
  if (/视频|video|生成|generate/.test(lower)) multiplier *= 2.0;
  else if (/ai|分析|分析报告|洞察|report/.test(lower)) multiplier *= 1.5;

  // Bulk discount
  if (/批量|batch|import|导入/.test(lower)) multiplier *= 0.8;

  // Long SKILL.md = more complex
  if (content.length > 500) multiplier *= 1.2;

  // Floor at 100, round to nearest 100
  return Math.max(100, Math.round((base * multiplier) / 100) * 100);
}

// ── Sync route ──

router.post('/v1/admin/skills/sync', requireAdmin, requireRole('admin'), async (_req: Request, res: Response) => {
  const skillsDir = _req.body?.skillsDir || join(process.cwd(), '..', 'dealclaw-agent', 'payload', 'skills');
  const results = { registered: [] as any[], skipped: 0, errors: [] as string[] };

  if (!existsSync(skillsDir)) {
    res.status(400).json({ code: 'BAD_REQUEST', message: `Skills directory not found: ${skillsDir}` });
    return;
  }

  try {
    const dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const skillId of dirs) {
      const skillMdPath = join(skillsDir, skillId, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;

      // Check if already registered
      const { rows: existing } = await query(
        'SELECT skill_id, activation_status FROM skill_prices WHERE skill_id = $1',
        [skillId]
      );

      if (existing.length > 0) {
        results.skipped++;
        continue;
      }

      try {
        const content = readFileSync(skillMdPath, 'utf-8');
        const category = extractCategory(skillId, content);
        const skillName = extractChineseName(content) || skillId;
        const description = extractDescription(content);
        const creditPerUnit = autoPrice(category, skillId, content);
        const responsiblePerson = extractResponsiblePerson(content);

        await query(
          `INSERT INTO skill_prices (skill_id, skill_name, description, category, credit_per_unit,
             status, activation_status, responsible_person, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 100)`,
          [skillId, skillName, description, category, creditPerUnit,
           'shadow', 'pending', responsiblePerson]
        );

        results.registered.push({ skillId, skillName, category, creditPerUnit, responsiblePerson });
      } catch (err: any) {
        results.errors.push(`${skillId}: ${err.message}`);
      }
    }

    res.json({
      ok: true,
      totalScanned: dirs.length,
      ...results,
    });
  } catch (err: any) {
    console.error('[admin-skills] sync error:', err);
    res.status(500).json({ code: 'INTERNAL', message: err.message });
  }
});

// ── Activate: set activation_status = 'approved' ──

router.post('/v1/admin/skills/:skillId/activate', requireAdmin, requireRole('admin'), async (req: Request, res: Response) => {
  const { skillId } = req.params;
  const { finalPrice } = req.body ?? {};
  const approvedBy = (req as any).adminUser.username;

  try {
    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    updates.push(`activation_status = 'approved'`);
    updates.push(`approved_by = $${paramIdx++}`);
    params.push(approvedBy);
    updates.push(`approved_at = NOW()`);
    updates.push(`status = 'live'`); // change from shadow to live

    if (typeof finalPrice === 'number' && finalPrice > 0) {
      updates.push(`credit_per_unit = $${paramIdx++}`);
      params.push(finalPrice);
    }

    params.push(skillId);

    const { rowCount } = await query(
      `UPDATE skill_prices SET ${updates.join(', ')}, updated_at = NOW() WHERE skill_id = $${paramIdx}`,
      params
    );

    if ((rowCount ?? 0) === 0) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Skill 不存在' });
      return;
    }

    res.json({ ok: true, skillId, status: 'activated' });
  } catch (err: any) {
    console.error('[admin-skills] activate error:', err);
    res.status(500).json({ code: 'INTERNAL', message: err.message });
  }
});

// ── Reject: set activation_status = 'rejected' ──

router.post('/v1/admin/skills/:skillId/reject', requireAdmin, requireRole('admin'), async (req: Request, res: Response) => {
  const { skillId } = req.params;
  const approvedBy = (req as any).adminUser.username;

  try {
    const { rowCount } = await query(
      `UPDATE skill_prices
       SET activation_status = 'rejected', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE skill_id = $2`,
      [approvedBy, skillId]
    );

    if ((rowCount ?? 0) === 0) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Skill 不存在' });
      return;
    }

    res.json({ ok: true, skillId, status: 'rejected' });
  } catch (err: any) {
    console.error('[admin-skills] reject error:', err);
    res.status(500).json({ code: 'INTERNAL', message: err.message });
  }
});

// ── GET /v1/admin/skills/pending — list pending skills ──

router.get('/v1/admin/skills/pending', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT skill_id, skill_name, description, category, credit_per_unit,
              activation_status, responsible_person, status, created_at
       FROM skill_prices
       WHERE activation_status = 'pending'
       ORDER BY created_at DESC`
    );

    res.json({
      ok: true,
      count: rows.length,
      skills: rows.map((r: any) => ({
        skillId: r.skill_id,
        skillName: r.skill_name,
        description: r.description,
        category: r.category,
        creditPerUnit: Number(r.credit_per_unit),
        activationStatus: r.activation_status,
        responsiblePerson: r.responsible_person,
        status: r.status,
        createdAt: r.created_at,
      })),
    });
  } catch (err: any) {
    console.error('[admin-skills] pending list error:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// ── GET /v1/admin/skills — list ALL skills with activation status ──

router.get('/v1/admin/skills', requireAdmin, async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    let where = '';
    const params: unknown[] = [];

    if (status) {
      where = 'WHERE activation_status = $1';
      params.push(status);
    }

    const { rows } = await query(
      `SELECT skill_id, skill_name, description, category, credit_per_unit,
              activation_status, responsible_person, status, approved_by, approved_at,
              created_at, updated_at, sort_order
       FROM skill_prices
       ${where}
       ORDER BY sort_order ASC, skill_id ASC`,
      params
    );

    // Stats
    const { rows: statsRows } = await query(
      `SELECT activation_status, COUNT(*) FROM skill_prices GROUP BY activation_status`
    );
    const stats: Record<string, number> = {};
    statsRows.forEach((r: any) => { stats[r.activation_status] = Number(r.count); });
    stats.total = Object.values(stats).reduce((a, b) => a + b, 0);

    res.json({
      ok: true,
      stats,
      skills: rows.map((r: any) => ({
        skillId: r.skill_id,
        skillName: r.skill_name,
        description: r.description,
        category: r.category,
        creditPerUnit: Number(r.credit_per_unit),
        activationStatus: r.activation_status,
        responsiblePerson: r.responsible_person,
        status: r.status,
        approvedBy: r.approved_by,
        approvedAt: r.approved_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        sortOrder: r.sort_order,
      })),
    });
  } catch (err: any) {
    console.error('[admin-skills] list error:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

export default router;
