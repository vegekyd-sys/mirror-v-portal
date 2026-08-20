#!/usr/bin/env node
// send_texstead_batch1.mjs — 高匹配30家：Resend 发送（内嵌产品图 cid + 退订 footer + 追踪）
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..'); // 到 dealclaw workspace
const API_KEY = process.env.RESEND_API_KEY;
if (!API_KEY) { console.error('RESEND_API_KEY required'); process.exit(1); }

const CONTACTS = JSON.parse(readFileSync('/tmp/texstead_high_contacts.json', 'utf8'));
const BASE = JSON.parse(readFileSync(join(__dirname, 'texstead_base_write.json'), 'utf8'));
const F = BASE.fields;
const rowDict = (r) => Object.fromEntries(F.map((k, i) => [k, r[i]]));
const highRows = BASE.rows.filter(r => rowDict(r)['AI匹配等级'] === '高')
  .sort((a, b) => (parseFloat(rowDict(b)['AI匹配分']) || 0) - (parseFloat(rowDict(a)['AI匹配分']) || 0));

const IMAGES = {
  img_headboard: { path: join(__dirname, 'texstead_img_headboard.png'), cid: 'img_headboard' },
  img_reading: { path: join(__dirname, 'texstead_img_reading.png'), cid: 'img_reading' },
  img_yoga: { path: join(__dirname, 'texstead_img_yogabolster.png'), cid: 'img_yoga' },
  img_knee: { path: join(__dirname, 'texstead_img_kneepillow.png'), cid: 'img_knee' },
  img_decor: { path: join(__dirname, 'texstead_img_seatcushion.png'), cid: 'img_decor' },
  img_bedding: { path: join(__dirname, 'texstead_img_quilt.png'), cid: 'img_bedding' },
  img_rug: null,
};

const SKUS = {
  headboard: [
    ['Quilted Stretch Velvet Headboard Protector', 'EXW $7.0', 'suggested retail $27.9', 'img_headboard'],
    ['Canvas Headboard Protector with Tie Straps', 'EXW $10.2', 'suggested retail $40.8', 'img_headboard'],
  ],
  reading: [
    ['Air Mesh Wedge Reading Pillow with Neck Support', 'EXW $11.3', 'suggested retail $45.1', 'img_reading'],
    ['Air Mesh Ear Support Memory Foam Pillow', 'EXW $3.4', 'suggested retail $13.6', 'img_reading'],
  ],
  yoga: [
    ['Corduroy Rectangular Yoga Bolster', 'EXW $8.6', 'suggested retail $34.4', 'img_yoga'],
    ['3D Air Mesh Knee Pillow', 'EXW $2.7', 'suggested retail $10.7', 'img_knee'],
  ],
  decor: [
    ['Printed Plush Round Seat Cushion', 'EXW $4.5', 'suggested retail $17.9', 'img_decor'],
    ['Sherpa Seat Cushion', 'EXW $6.6', 'suggested retail $26.5', 'img_decor'],
  ],
  bedding: [
    ['Solid Brushed Microfiber Quilt', 'EXW $7.5', 'suggested retail $30.1', 'img_bedding'],
    ['Vintage Floral Plaid Bedspread Set', 'EXW $16.7', 'suggested retail $66.6', 'img_bedding'],
  ],
  rug: [
    ['Home Rugs Collection (modern & classic series)', 'wholesale on request', '', null],
    ['Custom rug programs (size / color / weave)', 'OEM pricing', '', null],
  ],
};
const FALLBACK = [...SKUS.reading, SKUS.bedding[0]];

function pickSkus(prods) {
  const p = (prods || '').toLowerCase();
  if (p.includes('headboard')) return SKUS.headboard;
  if (p.includes('yoga') || p.includes('bolster') || p.includes('knee')) return SKUS.yoga;
  if (p.includes('bedding') || p.includes('quilt') || p.includes('bedspread') || p.includes('mattress') || p.includes('duvet') || p.includes('linen')) return SKUS.bedding;
  if (p.includes('rug') || p.includes('carpet')) return SKUS.rug;
  if (p.includes('cushion') && !p.includes('headboard') && !p.includes('reading')) return SKUS.decor;
  if (p.includes('pillow') || p.includes('reading')) return SKUS.reading;
  return FALLBACK;
}

function segment(r) {
  const nat = (rowDict(r)['买家特征'] || '').toLowerCase();
  if (nat.includes('brand')) return 'brand';
  if (nat.includes('distributor') || nat.includes('dealer') || nat.includes('wholesaler') || nat.includes('importer') || nat.includes('分销商')) return 'distributor';
  if (nat.includes('retailer') || nat.includes('supermarket') || nat.includes('零售商')) return 'retailer';
  if (nat.includes('online')) return 'online';
  if (nat.includes('oem') || nat.includes('factory') || nat.includes('生产商') || nat.includes('制造商')) return 'factory';
  return 'generic';
}

function segOf(r) { return segment(r); }

const SUBJ = {
  distributor: 'Proven home-textile sellers for your distribution network',
  brand: 'OEM/ODM home textile partner for your brand',
  retailer: 'Ready-stock home textiles for your stores',
  online: 'Ready-stock home textiles for your online assortment',
  factory: 'OEM supply partner for cushions & home textiles',
  generic: 'Home textile factory partner — ready stock & OEM/ODM',
};

const SEG_PARA = {
  distributor: 'Several of these lines are not yet widely available in your market, but are already proven best-sellers in other markets\u2019 retail and e-commerce channels. The margins leave room for a solid resale story: e.g. our velvet headboard protector carries an EXW of $7.0 against a suggested retail of $27.9, and the wedge reading pillow $11.3 vs $45.1 \u2014 healthy distributor economics, ready stock, MOQ from 50 pcs per SKU, 30-day lead.',
  brand: 'We run OEM, ODM and private-label programs: custom fabrics, fillings, colors and packaging under your own brand, MOQ from 50 pcs for test orders and 30-day lead time. You can validate new SKUs quickly without tooling risk, and scale later with dedicated production runs.',
  retailer: 'All lines are in ready stock with wholesale pricing from $2.7 EXW and MOQ of just 50 pcs per SKU \u2014 easy to test new home-textile SKUs on your shelf without deep inventory. Private-label options are available as you scale.',
  online: 'All lines are in ready stock with wholesale pricing from $2.7 EXW and MOQ of just 50 pcs per SKU \u2014 fast SKU testing, photo-ready products, and private-label options as you scale your store brand.',
  factory: 'We can be your stable OEM supply partner for the categories you do not produce in-house \u2014 cushions, reading pillows, yoga & floor cushions, bedding and rugs \u2014 or co-develop new lines for your market. MOQ from 50 pcs, 30-day lead, factory-direct pricing.',
  generic: 'We offer ready-stock wholesale plus OEM/ODM/private-label programs, MOQ from 50 pcs per SKU, 30-day lead time, and factory-direct pricing from $2.7 EXW.',
};

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function firstToken(name) {
  const t = String(name || '').trim().split(/\s+/)[0];
  if (!t || t.length < 2) return '';
  return t.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join('-');
}

function pickContacts(cdpId) {
  const cs = CONTACTS.filter(c => c.companyCdpId === cdpId && c.emailsValid);
  const order = (t) => {
    const s = String(t || '').toLowerCase();
    if (/(procure|purchas|buyer|sourcing)/.test(s)) return 0;
    if (/(ceo|president|chairman|owner|director|manager)/.test(s)) return 1;
    return 2;
  };
  cs.sort((a, b) => order(a.jobTitle) - order(b.jobTitle));
  return cs;
}

function buildEmail(r, contact) {
  const d = rowDict(r);
  const name = d['买家公司名称'];
  const seg = segment(r);
  const skus = pickSkus(d['关注产品']);
  const prods = (d['关注产品'] || '').split(';').map(x => x.trim()).filter(Boolean).join(', ') || 'home textiles';
  const hi = firstToken(contact.contactName);
  const greeting = hi ? `Hi ${hi},` : 'Hello,';
  const atts = [];
  let imgsHtml = '';
  let cidN = 0;
  for (const [nm, price, srp, imgKey] of skus) {
    if (imgKey && IMAGES[imgKey]) {
      cidN += 1;
      const cid = `${imgKey}_${cidN}`;
      atts.push({ filename: `${imgKey}.png`, content_id: cid, path: IMAGES[imgKey].path });
      imgsHtml += `<tr><td style="padding:6px 12px 6px 0;vertical-align:top;"><img src="cid:${cid}" width="160" style="border-radius:6px;"/></td><td style="padding:6px 0;vertical-align:top;"><b>${esc(nm)}</b><br/><span style="color:#333;">${esc(price)}${srp ? ' / ' + esc(srp) : ''}</span></td></tr>`;
    } else {
      imgsHtml += `<tr><td style="padding:6px 0;" colspan="2"><b>${esc(nm)}</b> — ${esc(price)}${srp ? ' / ' + esc(srp) : ''}</td></tr>`;
    }
  }
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222;max-width:620px;">
<p>${esc(greeting)}</p>
<p>We are TexStead, a home textile factory serving retailers, distributors and brands worldwide. Our 2026 collection covers six categories \u2014 headboard cushions, reading &amp; support pillows, yoga &amp; floor cushions, decorative cushions, bedding and home rugs \u2014 all in ready stock, with OEM, ODM and private-label programs available. Key terms: MOQ from 50 pcs per SKU, 30-day lead time, factory-direct EXW pricing from $2.7.</p>
<p>Given your focus on ${esc(prods)}, these two lines may be of interest:</p>
<table style="border-collapse:collapse;">${imgsHtml}</table>
<p>${esc(SEG_PARA[seg])}</p>
<p>I\u2019d be glad to send our full 2026 catalog with photos and a quote sheet \u2014 just reply and I will share it right away.</p>
<p>Best regards,<br/>Cecilia Xu<br/>Sales Director, TexStead</p>
</div>`;
  const text = `${greeting}\n\nWe are TexStead, a home textile factory serving retailers, distributors and brands worldwide. Our 2026 collection covers six categories — headboard cushions, reading & support pillows, yoga & floor cushions, decorative cushions, bedding and home rugs — all in ready stock, with OEM, ODM and private-label programs available. Key terms: MOQ from 50 pcs per SKU, 30-day lead time, factory-direct EXW pricing from $2.7.\n\nGiven your focus on ${prods}, these two lines may be of interest:\n${skus.map(s => '- ' + s[0] + ' — ' + s[1] + (s[2] ? ' / ' + s[2] : '')).join('\n')}\n\n${SEG_PARA[seg]}\n\nI'd be glad to send our full 2026 catalog with photos and a quote sheet — just reply and I will share it right away.\n\nBest regards,\nCecilia Xu\nSales Director, TexStead`;
  return { greeting, html, text, atts, seg, subj: SUBJ[seg] + (name.length <= 30 ? ` — for ${name}` : '') };
}

const UNSUB = 'https://send.mail.dogarm.top/unsub';
const FOOTER_HTML = `<p style="font-size:11px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">If you'd rather not receive emails like this, you can <a href="${UNSUB}" style="color:#888;">unsubscribe</a>.</p>`;
const FOOTER_TEXT = `\n\n--\nIf you'd rather not receive emails like this, unsubscribe here: ${UNSUB}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sentLog = join(__dirname, '..', '..', '..', 'scripts', 'resend', 'sent-log.jsonl');

// ── 组装收件人 ──
const recipients = [];
const usedEmails = new Set();
const usedEmailsByCompany = new Map();
for (const r of highRows) {
  const d = rowDict(r);
  const cdp = d['买家CDPID'];
  const cs = pickContacts(cdp);
  let picked = [];
  for (const c of cs) {
    const emails = c.emailsValid.split(/[;,]/).map(e => e.trim()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    for (const e of emails) {
      const key = e.toLowerCase();
      if (usedEmails.has(key)) continue;
      if ((usedEmailsByCompany.get(cdp) || 0) >= 2) break;
      picked.push({ contact: c, email: e });
      usedEmails.add(key);
      usedEmailsByCompany.set(cdp, (usedEmailsByCompany.get(cdp) || 0) + 1);
    }
    if ((usedEmailsByCompany.get(cdp) || 0) >= 2) break;
  }
  for (const p of picked) recipients.push({ row: r, seg: segOf(r), ...p });
}

console.log('recipients:', recipients.length);

if (process.env.DRY_RUN === '1') {
  for (const rc of recipients.slice(0, 3)) {
    const d = rowDict(rc.row);
    const { html, text, atts, subj } = buildEmail(rc.row, rc.contact);
    console.log('=== DRY ===');
    console.log('TO:', rc.email, '| COMPANY:', d['买家公司名称'], '| SEG:', rc.seg, '| SUBJ:', subj);
    console.log('ATTACHMENTS:', atts.map(a => a.content_id).join(','));
    console.log(html.slice(0, 1200));
  }
  process.exit(0);
}

const summary = { total: recipients.length, sent: 0, failed: [], skipped_no_contact: highRows.length - usedEmailsByCompany.size };
for (const rc of recipients) {
  const d = rowDict(rc.row);
  const { html, text, atts, subj } = buildEmail(rc.row, rc.contact);
  const attachments = atts.map(a => ({
    filename: a.filename,
    content_id: a.content_id,
    content: readFileSync(a.path).toString('base64'),
  }));
  const body = {
    from: 'Cecilia Xu <xuyang@mail.dealclaw.io>',
    to: [rc.email],
    reply_to: ['xuyang@mail.dealclaw.io'],
    subject: subj,
    html: html + FOOTER_HTML,
    text: text + FOOTER_TEXT,
    track_opens: true,
    track_clicks: true,
    headers: {
      'List-Unsubscribe': `<${UNSUB}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
  if (attachments.length) body.attachments = attachments;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok && data.id) {
      summary.sent += 1;
      appendFileSync(sentLog, JSON.stringify({
        ts: new Date().toISOString(), to: rc.email, company: d['买家公司名称'], cdp: d['买家CDPID'],
        country: d['买家国家'], segment: rc.seg, resend_id: data.id, subject: subj,
      }) + '\n');
      console.log('SENT', rc.email, '|', d['买家公司名称'], '|', data.id);
    } else {
      summary.failed.push({ email: rc.email, company: d['买家公司名称'], error: data });
      console.log('FAIL', rc.email, '|', JSON.stringify(data).slice(0, 200));
    }
  } catch (e) {
    summary.failed.push({ email: rc.email, company: d['买家公司名称'], error: String(e) });
  }
  await sleep(1200);
}

writeFileSync('/tmp/texstead_send_summary.json', JSON.stringify(summary, null, 2));
console.log('SUMMARY:', JSON.stringify(summary));
