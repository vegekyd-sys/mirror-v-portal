#!/usr/bin/env node
// scripts/resend/pull-replies.mjs — 拉取所有 Resend 入站回复
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(__dirname, '.env');
const envContent = readFileSync(envFile, 'utf8');
const API_KEY = envContent.split('\n')[0].split('=', 2)[1].trim();

const BASE = 'https://api.resend.com';

async function fetchAll() {
  const r = await fetch(`${BASE}/emails/receiving?limit=50`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  return (await r.json()).data || [];
}

async function fetchFull(id) {
  const r = await fetch(`${BASE}/emails/receiving/${id}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  return await r.json();
}

const emails = await fetchAll();
console.log(`📬 Resend 入站邮件 — 共 ${emails.length} 封\n`);

for (const e of emails) {
  const full = await fetchFull(e.id);
  const ts = new Date(e.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log('━'.repeat(50));
  console.log(`发件人: ${e.from}`);
  console.log(`时间:   ${ts}`);
  console.log(`主题:   ${e.subject}`);
  console.log('内容:');
  const body = (full.text || '').trim();
  const cleanBody = body.split('\n>')[0].trim();
  console.log(cleanBody);
  console.log();
}
