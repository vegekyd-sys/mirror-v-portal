#!/usr/bin/env node
// scripts/resend/reply-watch.mjs
// 每 N 小时检查 Resend 收件箱，发现新回复 → 飞书通知
// checkpoint 存在 scripts/resend/.reply-checkpoint.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load API key ────────────────────────────────────────────────
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
  console.error('❌ RESEND_API_KEY 未设置');
  process.exit(1);
}

const BASE = 'https://api.resend.com';
const CHECKPOINT_FILE = resolve(__dirname, '.reply-checkpoint.json');

// ── Checkpoint ───────────────────────────────────────────────────
function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return { last_check_at: null, known_ids: new Set() };
  const raw = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf8'));
  return { last_check_at: raw.last_check_at, known_ids: new Set(raw.known_ids || []) };
}

function saveCheckpoint(checkAt, knownIds) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify({
    last_check_at: checkAt,
    known_ids: [...knownIds],
  }, null, 2));
}

// ── Fetch received emails ────────────────────────────────────────
async function fetchReceived(limit = 50) {
  const r = await fetch(`${BASE}/emails/receiving?limit=${limit}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`Resend API error ${r.status}: ${JSON.stringify(err)}`);
  }
  return (await r.json()).data || [];
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const cp = loadCheckpoint();
  const emails = await fetchReceived(50);
  const now = new Date().toISOString();

  // Find new emails (not in checkpoint)
  const newEmails = [];
  for (const e of emails) {
    if (!cp.known_ids.has(e.id)) {
      newEmails.push(e);
    }
  }

  if (newEmails.length === 0) {
    console.log(JSON.stringify({ checked_at: now, new_count: 0, status: 'no_new' }));
    saveCheckpoint(now, cp.known_ids);
    return { new_count: 0, emails: [] };
  }

  // Fetch full content for new emails
  const enriched = [];
  for (const e of newEmails) {
    try {
      const r = await fetch(`${BASE}/emails/receiving/${e.id}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
      });
      const full = await r.json();
      enriched.push({
        id: e.id,
        from: e.from,
        to: e.to,
        subject: e.subject,
        created_at: e.created_at,
        text: (full.text || '').substring(0, 500).trim(),
        html_preview: (full.text || '').substring(0, 500).trim(),
      });
    } catch (err) {
      enriched.push({ ...e, preview: `[无法获取内容: ${err.message}]` });
    }
  }

  // Update checkpoint
  const allIds = new Set(cp.known_ids);
  for (const e of newEmails) allIds.add(e.id);
  saveCheckpoint(now, allIds);

  const output = {
    checked_at: now,
    new_count: enriched.length,
    status: 'new_replies',
    emails: enriched,
  };

  console.log(JSON.stringify(output, null, 2));
  return output;
}

// Run
main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
