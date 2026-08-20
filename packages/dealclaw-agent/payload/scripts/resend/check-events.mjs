#!/usr/bin/env node
// scripts/resend/check-events.mjs — 查询 Resend Events API 并报告打开/点击/投递状态
// Usage:
//   node scripts/resend/check-events.mjs                    # 查最近 100 条事件
//   node scripts/resend/check-events.mjs --email-id xxx     # 查某封邮件的所有事件
//   node scripts/resend/check-events.mjs --since 24h        # 过去 24h 的事件摘要
//   node scripts/resend/check-events.mjs --human            # 人类可读输出

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadApiKey() {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  const envFile = resolve(__dirname, '.env');
  if (!existsSync(envFile)) return null;
  const lines = readFileSync(envFile, 'utf8').split('\n');
  for (const l of lines) {
    if (l.startsWith('RESEND_API_KEY=')) return l.substring('RESEND_API_KEY='.length).trim();
  }
  return null;
}

const API_KEY = loadApiKey();
if (!API_KEY) {
  console.error('❌ RESEND_API_KEY not set');
  process.exit(1);
}

const BASE = 'https://api.resend.com';

const args = process.argv.slice(2);
const human = args.includes('--human');
const emailId = (() => {
  const i = args.indexOf('--email-id');
  return i >= 0 ? args[i + 1] : null;
})();
const since = (() => {
  const i = args.indexOf('--since');
  return i >= 0 ? args[i + 1] : null;
})();

function parseSince(s) {
  if (!s) return null;
  const match = s.match(/^(\d+)\s*(h|d|m)$/);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2];
  const ms = unit === 'h' ? val * 3600000 : unit === 'd' ? val * 86400000 : val * 60000;
  return new Date(Date.now() - ms);
}

const sinceDate = parseSince(since);

// ── Event type labels ──────────────────────────────────────────
const EVENT_LABELS = {
  'email.sent':        '📤 已发送',
  'email.delivered':   '✅ 已投递',
  'email.opened':      '👁 已打开',
  'email.clicked':     '🔗 已点击',
  'email.bounced':     '💥 退信',
  'email.complained':  '🚫 投诉/举报',
  'email.delivery_delayed': '⏳ 延迟投递',
  'contact.created':   '👤 联系人创建',
  'contact.updated':   '👤 联系人更新',
  'contact.deleted':   '👤 联系人删除',
};

async function fetchAllEvents(limit = 100) {
  const events = [];
  let url = `${BASE}/events?limit=${limit}`;

  while (url) {
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(`Events API error ${r.status}: ${JSON.stringify(err)}`);
    }
    const body = await r.json();
    const page = body.data || [];
    events.push(...page);

    // Check for next page
    if (page.length === limit && page.length > 0) {
      const lastId = page[page.length - 1].id;
      url = `${BASE}/events?limit=${limit}&after=${lastId}`;
    } else {
      url = null;
    }
  }
  return events;
}

async function main() {
  let events = await fetchAllEvents(emailId ? 100 : 100);

  // Filter by email_id if requested
  if (emailId) {
    events = events.filter(e => {
      const data = e.data || {};
      return data.email_id === emailId;
    });
  }

  // Filter by time if --since
  if (sinceDate) {
    const cutoff = sinceDate.toISOString();
    events = events.filter(e => e.created_at >= cutoff);
  }

  // Categorize
  const byType = {};
  const byEmail = {};
  for (const e of events) {
    const type = e.type || 'unknown';
    if (!byType[type]) byType[type] = [];
    byType[type].push(e);

    const eid = e.data?.email_id || 'unknown';
    if (!byEmail[eid]) byEmail[eid] = [];
    byEmail[eid].push(e);
  }

  if (human) {
    console.log(`\n📊 Resend Events 摘要 (共 ${events.length} 条)\n`);
    console.log('━'.repeat(60));

    // Summary by type
    for (const [type, evts] of Object.entries(byType)) {
      console.log(`  ${EVENT_LABELS[type] || type}: ${evts.length} 条`);
    }
    console.log('━'.repeat(60));

    // Per-email breakdown
    for (const [eid, evts] of Object.entries(byEmail)) {
      const subject = evts[0]?.data?.subject || '(无主题)';
      const from = evts[0]?.data?.from || '';
      const to = (evts[0]?.data?.to || []).join(', ');
      const types = [...new Set(evts.map(e => e.type))];
      const statusIcons = types.map(t => EVENT_LABELS[t] || t).join(' ');

      console.log(`\n📧 ${subject}`);
      console.log(`   发件: ${from} → ${to}`);
      console.log(`   状态: ${statusIcons}`);

      for (const e of evts) {
        const ts = new Date(e.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const label = EVENT_LABELS[e.type] || e.type;
        let extra = '';
        if (e.type === 'email.clicked' && e.data?.click?.link) {
          extra = ` → ${e.data.click.link}`;
        }
        if (e.type === 'email.opened') {
          const ip = e.data?.open?.ip_address || '';
          const ua = (e.data?.open?.user_agent || '').substring(0, 60);
          extra = ip ? ` IP: ${ip}` : '';
          if (ua) extra += ` | ${ua}`;
        }
        console.log(`     ${ts} ${label}${extra}`);
      }
    }

    if (events.length === 0) {
      console.log('\n  (暂无事件)\n');
    }
  } else {
    console.log(JSON.stringify({
      total: events.length,
      summary: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])),
      emails: Object.fromEntries(Object.entries(byEmail).map(([eid, evts]) => {
        const types = [...new Set(evts.map(e => e.type))];
        const latest = evts.reduce((a, b) => a.created_at > b.created_at ? a : b);
        return [eid, {
          subject: evts[0]?.data?.subject,
          from: evts[0]?.data?.from,
          to: evts[0]?.data?.to,
          status: types,
          latest_event: latest.type,
          latest_at: latest.created_at,
        }];
      })),
    }, null, 2));
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
