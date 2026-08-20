#!/usr/bin/env node
// send_texstead_batch2.mjs — 中/低匹配 + 官网邮箱批次：Resend 发送
import { readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env['RESEND_' + 'API_KEY'];
if (!API_KEY) { console.error('RESEND_API_KEY required'); process.exit(1); }

const RECIPIENTS = JSON.parse(readFileSync('/tmp/texstead_recipients_batch2.json', 'utf8'));
const BASE = JSON.parse(readFileSync(join(__dirname, 'texstead_base_write.json'), 'utf8'));
const F = BASE.fields;
const rowsByCdp = Object.fromEntries(BASE.rows.map(r => {
  const d = Object.fromEntries(F.map((k, i) => [k, r[i]]));
  return [d['买家CDPID'], d];
}));

const IMAGES = {
  img_headboard: { path: join(__dirname, 'texstead_img_headboard.png') },
  img_reading: { path: join(__dirname, 'texstead_img_reading.png') },
  img_yoga: { path: join(__dirname, 'texstead_img_yogabolster.png') },
  img_knee: { path: join(__dirname, 'texstead_img_kneepillow.png') },
  img_decor: { path: join(__dirname, 'texstead_img_seatcushion.png') },
  img_bedding: { path: join(__dirname, 'texstead_img_quilt.png') },
  img_rug: null,
};

const SKUS = {
  headboard: [['Quilted Stretch Velvet Headboard Protector','EXW $7.0','suggested retail $27.9','img_headboard'],['Canvas Headboard Protector with Tie Straps','EXW $10.2','suggested retail $40.8','img_headboard']],
  reading: [['Air Mesh Wedge Reading Pillow with Neck Support','EXW $11.3','suggested retail $45.1','img_reading'],['Air Mesh Ear Support Memory Foam Pillow','EXW $3.4','suggested retail $13.6','img_reading']],
  yoga: [['Corduroy Rectangular Yoga Bolster','EXW $8.6','suggested retail $34.4','img_yoga'],['3D Air Mesh Knee Pillow','EXW $2.7','suggested retail $10.7','img_knee']],
  decor: [['Printed Plush Round Seat Cushion','EXW $4.5','suggested retail $17.9','img_decor'],['Sherpa Seat Cushion','EXW $6.6','suggested retail $26.5','img_decor']],
  bedding: [['Solid Brushed Microfiber Quilt','EXW $7.5','suggested retail $30.1','img_bedding'],['Vintage Floral Plaid Bedspread Set','EXW $16.7','suggested retail $66.6','img_bedding']],
  rug: [['Home Rugs Collection (modern & classic series)','wholesale on request','',null],['Custom rug programs (size / color / weave)','OEM pricing','',null]],
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

function segment(d) {
  const nat = (d['买家特征'] || '').toLowerCase();
  if (nat.includes('brand')) return 'brand';
  if (nat.includes('distributor') || nat.includes('dealer') || nat.includes('wholesaler') || nat.includes('importer') || nat.includes('分销商')) return 'distributor';
  if (nat.includes('retailer') || nat.includes('supermarket') || nat.includes('零售商')) return 'retailer';
  if (nat.includes('online')) return 'online';
  if (nat.includes('oem') || nat.includes('factory') || nat.includes('生产商') || nat.includes('制造商')) return 'factory';
  return 'generic';
}

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

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function firstToken(name) {
  const t = String(name || '').trim().split(/\s+/)[0];
  if (!t || t.length < 2) return '';
  return t.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join('-');
}

function build(d, rc) {
  const name = d['买家公司名称'];
  const seg = segment(d);
  const skus = pickSkus(d['关注产品']);
  const prods = (d['关注产品'] || '').split(';').map(x => x.trim()).filter(Boolean).join(', ') || 'home textiles';
  const hi = firstToken(rc.contactName);
  const greeting = hi ? `Hi ${hi},` : 'Hello,';
  const atts = [];
  let imgsHtml = '';
  let n = 0;
  for (const [nm, price, srp, imgKey] of skus) {
    if (imgKey && IMAGES[imgKey]) {
      n += 1;
      const cid = `${imgKey}_${n}`;
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
  const subj = SUBJ[seg] + (name.length <= 30 ? ` — for ${name}` : '');
  return { html, text, atts, seg, subj };
}

const UNSUB = 'https://send.mail.dogarm.top/unsub';
const FOOTER_HTML = `<p style="font-size:11px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">If you'd rather not receive emails like this, you can <a href="${UNSUB}" style="color:#888;">unsubscribe</a>.</p>`;
const FOOTER_TEXT = `\n\n--\nIf you'd rather not receive emails like this, unsubscribe here: ${UNSUB}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sentLog = join(__dirname, '..', '..', '..', 'scripts', 'resend', 'sent-log.jsonl');

const summary = { total: RECIPIENTS.length, sent: 0, failed: [], quota_hit: false };
for (const rc of RECIPIENTS) {
  const d = rowsByCdp[rc.cdp];
  if (!d) { summary.failed.push({ email: rc.email, error: 'row not found: ' + rc.cdp }); continue; }
  const { html, text, atts, seg, subj } = build(d, rc);
  const attachments = atts.map(a => ({ filename: a.filename, content_id: a.content_id, content: readFileSync(a.path).toString('base64') }));
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
    if (res.status === 429) { summary.quota_hit = true; console.log('QUOTA/429 at', rc.email); break; }
    if (res.ok && data.id) {
      summary.sent += 1;
      appendFileSync(sentLog, JSON.stringify({
        ts: new Date().toISOString(), to: rc.email, company: d['买家公司名称'], cdp: d['买家CDPID'],
        country: d['买家国家'], segment: seg, resend_id: data.id, subject: subj, campaign: 'texstead-batch2',
      }) + '\n');
      if (summary.sent % 25 === 0) console.log('sent so far:', summary.sent);
    } else {
      summary.failed.push({ email: rc.email, company: d['买家公司名称'], error: JSON.stringify(data).slice(0, 200) });
      console.log('FAIL', rc.email, '|', JSON.stringify(data).slice(0, 150));
    }
  } catch (e) {
    summary.failed.push({ email: rc.email, company: d['买家公司名称'], error: String(e) });
  }
  await sleep(1200);
}

appendFileSync(sentLog, JSON.stringify({ ts: new Date().toISOString(), event: 'batch2_summary', campaign: 'texstead-batch2', summary }) + '\n');
console.log('SUMMARY:', JSON.stringify(summary));
