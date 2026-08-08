#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Imap from 'imap';

const HERE = dirname(fileURLToPath(import.meta.url));
const CP = resolve(HERE, '.imap-cp.json');

let known = [];
if (existsSync(CP)) {
  try { known = JSON.parse(readFileSync(CP,'utf8')).uids || []; } catch(_) {}
}

const imap = new Imap({
  user: 'tiangengjun@meorient.com', password: 'qnVNXRrnbwUPeqZL',
  host: 'imap.exmail.qq.com', port: 993, tls: true,
  tlsOptions: { rejectUnauthorized: false },
  connTimeout: 15000, authTimeout: 15000,
});

const out = [];
let settled = false;
let newUids = [];

function finish() {
  if (settled) return; settled = true;
  for (const u of newUids) { if (u && !known.includes(u)) known.push(u); }
  known = [...new Set(known)].slice(-500);
  try { writeFileSync(CP, JSON.stringify({ uids: known, checked: new Date().toISOString() })); } catch(_) {}
  console.log(JSON.stringify(out));
  process.exit(0);
}

imap.once('ready', () => {
  imap.openBox('INBOX', false, (err) => {
    if (err) { imap.end(); return finish(); }
    const since = new Date(Date.now() - 7*86400000).toISOString();
    imap.search([['SINCE', since]], (err, uids) => {
      if (err || !uids?.length) { imap.end(); return finish(); }
      newUids = uids.filter(u => !known.includes(u));
      if (!newUids.length) { imap.end(); return finish(); }

      let pending = newUids.length;
      const f = imap.fetch(newUids, { bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)' });
      f.on('message', (msg) => {
        let raw = '';
        msg.on('body', (s) => { s?.on?.('data', (c) => { raw += c.toString('utf8'); }); });
        msg.once('end', () => {
          pending--;
          const decode = (s) => String(s||'').replace(/=\?[^?]+\?[BbQq]\?([^?]*)\?=/g, (_, e) => {
            try { return Buffer.from(e,'base64').toString('utf8'); } catch(_) { return e; }
          });
          const h = {};
          raw.split('\r\n').filter(l=>l).forEach(l => {
            const m = l.match(/^([A-Za-z-]+):\s*(.+)/);
            if (m) h[m[1].toLowerCase()] = m[2].trim();
          });
          out.push({
            source: 'imap', account: 'tiangengjun@meorient.com',
            from: decode(h.from||''), subject: decode(h.subject||''), date: h.date||'',
          });
          if (pending <= 0) imap.end();
        });
      });
    });
  });
});

imap.once('error', () => { try { imap.end(); } catch(_) {} finish(); });
imap.once('end', () => finish());
setTimeout(() => finish(), 20000); // safety timeout
imap.connect();
