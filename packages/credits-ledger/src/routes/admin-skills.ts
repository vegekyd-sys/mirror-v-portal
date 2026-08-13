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
  const raw = catMatch ? catMatch[1].toLowerCase() : (skillId.split('-')[0] || 'other');
  return canonicalizeCategory(skillId, raw);
}

// 分类收敛：只允许 4 业务类 + other。业务 skill 按 skill_id 精确映射，其余一律 other。
const CANONICAL_CATEGORIES = new Set(['buyer', 'insight', 'outreach', 'exhibition', 'other']);
const SKILL_CATEGORY_MAP: Record<string, string> = {
  // buyer — 买家开发
  'dealclaw-find-buyers': 'buyer', 'dealclaw-lead-import': 'buyer', 'dealclaw-buyer-leads-push': 'buyer',
  'overseas-buyer-lead-search': 'buyer', 'overseas-buyer-search': 'buyer', 'overseas-textile-buyer-search': 'buyer',
  'lead-customer-profile': 'buyer', 'data-selection': 'buyer', 'mio-data-selection-api': 'buyer',
  'aochuang-leads': 'buyer', 'qcc-company-lookup': 'buyer', 'qiancean-factory': 'buyer',
  // insight — 市场洞察
  'dealclaw-analyze-company': 'insight', 'dealclaw-market-insight': 'insight', 'dealclaw-market-report': 'insight',
  'mio-customer-visit-analysis': 'insight', 'customer-health-score': 'insight', 's2-win-analysis': 'insight',
  // outreach — 营销触达
  'dealclaw-email-founder-direct': 'outreach', 'dealclaw-email-growth-send': 'outreach', 'dealclaw-email-bindings': 'outreach',
  'dealclaw-smart-reply': 'outreach', 'dealclaw-review': 'outreach',
  // exhibition — 展会获客
  'dealclaw-exhibition-leads': 'exhibition', 'dealclaw-exhibition-invitation': 'exhibition',
  'aochuang-metro': 'exhibition', 'aochuang-review-report': 'exhibition', 'aochuang-standard-solution': 'exhibition',
  'miao-b2b-exhibition-planning-doc': 'exhibition',
};
function canonicalizeCategory(skillId: string, raw: string): string {
  const c = raw.toLowerCase().trim();
  if (SKILL_CATEGORY_MAP[skillId]) return SKILL_CATEGORY_MAP[skillId];
  if (CANONICAL_CATEGORIES.has(c)) return c;
  return 'other';
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
  // Person marks: 作者 / author / Owner / 负责人 / responsible — stop at pipe or newline.
  let m = content.match(/(?:作者|负责人|responsible|owner|author)[：:]\s*([^|\n]+)/i);
  // 来源 is ambiguous (usually a data-source list). Only treat as author when it looks
  // like a person, i.e. contains "@" (e.g. 来源：田耕郡@格格).
  if (!m) m = content.match(/来源[：:]\s*([^\s|，,\n]*@[^\s|，,\n]+)/i);
  if (!m) return null;
  const v = m[1].trim().replace(/[|,，].*$/, '').trim();
  if (!v || v === '...' || v === '…') return null;
  return v.slice(0, 64);
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

router.post('/skills/sync', requireAdmin, requireRole('admin'), async (_req: Request, res: Response) => {
  // Default to dealclaw-agent skills in the monorepo
  const defaultSkillsDir = join(process.cwd(), '..', '..', 'dealclaw-agent', 'payload', 'skills');
  const skillsDir = _req.body?.skillsDir || defaultSkillsDir;
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

router.post('/skills/:skillId/activate', requireAdmin, requireRole('admin'), async (req: Request, res: Response) => {
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
    // 审核通过 → 影子计费（记录不扣费）。正式上线（launch）才转 live。
    updates.push(`status = 'shadow'`);

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

// ── Launch: 正式上线 — shadow → live（正式计费）──
// 只有 Tianyi 明确指示「上线」时才调用。上线 = 审核通过 + 正式扣费。

router.post('/skills/:skillId/launch', requireAdmin, requireRole('admin'), async (req: Request, res: Response) => {
  const { skillId } = req.params;
  const approvedBy = (req as any).adminUser.username;

  try {
    const { rowCount } = await query(
      `UPDATE skill_prices
       SET activation_status = 'approved', status = 'live',
           approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE skill_id = $2`,
      [approvedBy, skillId]
    );

    if ((rowCount ?? 0) === 0) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Skill 不存在' });
      return;
    }

    res.json({ ok: true, skillId, status: 'launched' });
  } catch (err: any) {
    console.error('[admin-skills] launch error:', err);
    res.status(500).json({ code: 'INTERNAL', message: err.message });
  }
});

// ── Reject: set activation_status = 'rejected' ──

router.post('/skills/:skillId/reject', requireAdmin, requireRole('admin'), async (req: Request, res: Response) => {
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

router.get('/skills/pending', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT skill_id, skill_name, description, category, credit_per_unit, cost,
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
        cost: r.cost != null ? Number(r.cost) : null,
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

router.get('/skills', requireAdmin, async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    let where = '';
    const params: unknown[] = [];

    if (status) {
      where = 'WHERE activation_status = $1';
      params.push(status);
    }

    const { rows } = await query(
      `SELECT skill_id, skill_name, description, category, credit_per_unit, cost,
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
        cost: r.cost != null ? Number(r.cost) : null,
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
