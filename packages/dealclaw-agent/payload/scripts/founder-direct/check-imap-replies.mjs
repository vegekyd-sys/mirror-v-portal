#!/usr/bin/env node
// scripts/founder-direct/check-imap-replies.mjs
// 检查指定邮箱的 IMAP 收件箱，返回未读/新回复
// Usage:
//   node check-imap-replies.mjs --email gengjuntian@meorient.com --password *** [--all]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { simpleParser } from 'mailparser';
import Imap from 'imap';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_DIR = resolve(__dirname, 'accounts');
const CHECKPOINT_DIR = resolve(__dirname, '.imap-checkpoints');
if (!existsSync(CHECKPOINT_DIR)) mkdirSync(CHECKPOINT_DIR, { recursive: true });

async function main() {
  const args = process.argv.slice(2);
  const parseArg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const email = parseArg('--email');
  let password = parseArg('--password');
  const showAll = args.includes('--all');

  if (!email) { console.error('Usage: node check-imap-replies.mjs --email xxx@company.com [--password ***] [--all]'); process.exit(2); }

  // Load IMAP config from bound account
  const accountFile = resolve(ACCOUNTS_DIR, `${email.replace(/[@.]/g, '_')}.json`);
  const account = existsSync(accountFile) ? JSON.parse(readFileSync(accountFile, 'utf8')) : null;
  const imapCfg = account?.imap || { host: 'imap.exmail.qq.com', port: 993, tls: true };

  // Load checkpoint
  const checkpointFile = resolve(CHECKPOINT_DIR, `${email.replace(/[@.]/g, '_')}.json`);
  let checkpoint = existsSync(checkpointFile) ? JSON.parse(readFileSync(checkpointFile, 'utf8')) : { known_uids: [], last_check: null };

  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await new Promise(resolve => {
      rl.question(`Password for ${email}: `, (pw) => { rl.close(); resolve(pw.trim()); });
    });
  }

  const results = [];

  await new Promise((resolve, reject) => {
    const imap = new Imap({
      user: email, password,
      host: imapCfg.host || 'imap.exmail.qq.com',
      port: imapCfg.port || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 15000,
    });

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) { imap.end(); return reject(err); }

        const since = new Date(Date.now() - 7 * 86400000);
        const criteria = showAll ? [['SINCE', since.toISOString()]] : [['SINCE', since.toISOString()]];

        imap.search(criteria, (err, uids) => {
          if (err || !uids.length) { imap.end(); return resolve(); }

          const newUids = showAll ? uids : uids.filter(u => !checkpoint.known_uids.includes(u));
          if (!newUids.length) { imap.end(); return resolve(); }

          const fetch = imap.fetch(newUids, { bodies: '', struct: true });
          let pending = newUids.length;

          fetch.on('message', (msg) => {
            let body = '';
            let attrs;
            msg.on('body', (stream) => { stream.on('data', (chunk) => { body += chunk.toString('utf8'); }); });
            msg.once('attributes', (a) => { attrs = a; });
            msg.once('end', async () => {
              pending--;
              try {
                const parsed = await simpleParser(body);
                results.push({
                  uid: attrs?.uid,
                  from: parsed.from?.text || '',
                  subject: parsed.subject || '',
                  date: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
                  text: (parsed.text || '').substring(0, 500).trim(),
                });
                if (attrs?.uid) checkpoint.known_uids.push(attrs.uid);
              } catch (_) { /* skip */ }
              if (pending <= 0) { imap.end(); }
            });
          });
        });
      });
    });

    imap.once('error', (e) => reject(e));
    imap.once('end', () => resolve());
    imap.connect();
  });

  // Save checkpoint
  checkpoint.known_uids = [...new Set(checkpoint.known_uids)].slice(-500);
  checkpoint.last_check = new Date().toISOString();
  writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2));

  console.log(`📬 ${email} — ${results.length} new`);
  for (const r of results) {
    const ts = new Date(r.date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log('━'.repeat(40));
    console.log(`From: ${r.from}`);
    console.log(`Date: ${ts}`);
    console.log(`Subject: ${r.subject}`);
    console.log(r.text);
    console.log();
  }
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
