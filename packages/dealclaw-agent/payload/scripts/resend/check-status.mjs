#!/usr/bin/env node
/**
 * DC-GS: Resend 邮件状态查询
 * 用法:
 *   node scripts/resend/check-status.mjs <email_id>
 *   node scripts/resend/check-status.mjs --list (最近发送)
 *
 * 环境变量:
 *   RESEND_API_KEY — 从 .env 加载
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(__dirname, '..', '..');

function loadEnv() {
  try {
    const envFile = join(workspaceRoot, 'work', 'mio-api', '.env');
    const content = readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...rest] = trimmed.split('=');
        if (!process.env[k]) process.env[k] = rest.join('=');
      }
    }
  } catch (e) {}
}
loadEnv();

const API_KEY = process.env.RESEND_API_KEY;
const LOG_DIR = join(workspaceRoot, 'work', 'mio-api', 'data');
const SENT_LOG = join(LOG_DIR, 'sent_log.jsonl');

if (!API_KEY) {
  console.error('❌ RESEND_API_KEY 未设置');
  process.exit(1);
}

async function checkEmail(id) {
  const res = await fetch(`https://api.resend.com/emails/${id}`, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'User-Agent': 'DealClaw-DC-GS/1.0',
    },
  });
  return res.json();
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    // Read recent from sent log
    if (!existsSync(SENT_LOG)) {
      console.log('📭 无发送记录');
      return;
    }
    const lines = readFileSync(SENT_LOG, 'utf-8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-10).reverse();
    console.log(`📊 最近 ${recent.length} 封邮件:`);
    for (const line of recent) {
      try {
        const entry = JSON.parse(line);
        console.log(`  ${entry.id} | ${entry.to} | ${entry.subject?.substring(0,40)} | ${entry.created_at}`);
      } catch {
        console.log(`  ${line.substring(0,80)}`);
      }
    }
    return;
  }

  if (args[0]) {
    const data = await checkEmail(args[0]);
    console.log(JSON.stringify({
      id: data.id,
      from: data.from,
      to: data.to,
      subject: data.subject,
      created_at: data.created_at,
      last_event: data.last_event,
    }, null, 2));
    return;
  }

  console.log('用法: node check-status.mjs <email_id> | --list');
}

main().catch(e => console.error(e.message));
