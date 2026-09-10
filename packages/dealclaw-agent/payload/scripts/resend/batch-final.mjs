import fs from 'node:fs';

const API_KEY = process.env.RESEND_API_KEY;
if (!API_KEY) { console.error('RESEND_API_KEY required'); process.exit(1); }

const emails = [
  {
    name: 'Castore', to: 'adrian.harris@castore.co.uk',
    subject: "Performance Sportswear OEM — Scalable Nylon Activewear for Castore",
    html: `<p>Hi Adrian,</p><p>Castore's F1 and Premier League teamwear caught my attention. You joined as CSCO recently — this is typically when supply chain evaluation happens.</p><p>Aarkissu is a BSCI-certified nylon activewear factory. 800 units/day. 4-way stretch nylon — compression, anti-pill. MOQ 500. 25-day lead.</p><p>I can ship 3 sample pieces in 7 days. Would you be open to a brief call?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: 'Adanola', to: 'niran@adanola.com',
    subject: "Activewear OEM — Incremental Capacity for Adanola Growth",
    html: `<p>Hi Niran,</p><p>Adanola's trajectory over the past 18 months is impressive — and from your Gymshark days you know the China activewear supply chain well.</p><p>Aarkissu is a nylon activewear factory. 20,000+ units/month. MOQ 500. 25-day turnaround. BSCI-certified.</p><p>When your growth outpaces current bandwidth, we're the capacity that kicks in. Would you be open to a brief call?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: "DICK'S-Ali", to: 'arushmore@dcsg.com',
    subject: "Nylon Activewear OEM — Factory for DICK'S Private Label",
    html: `<p>Hi Ali,</p><p>DICK'S CALIA and DSG lines compete directly with Lululemon. Your team is likely evaluating new nylon capacity.</p><p>Aarkissu: 800 units/day. MOQ 500. 25-day turn. BSCI-certified.</p><p>I can prepare a capability deck and 3 samples within 48 hours. Would your team be open to reviewing?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: "DICK'S-Jenna", to: 'jenna.skellie@dcsg.com',
    subject: "Nylon Activewear OEM — Factory for DICK'S Private Label",
    html: `<p>Hi Jenna,</p><p>DICK'S CALIA and DSG lines compete directly with Lululemon. Your team is likely evaluating new nylon capacity.</p><p>Aarkissu: 800 units/day. MOQ 500. 25-day turn. BSCI-certified.</p><p>I can prepare a capability deck and 3 samples within 48 hours. Would your team be open to reviewing?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: 'Oner Active', to: 'domenico.prestia@oneractive.com',
    subject: "Nylon Activewear Capacity — Seamless & Compression for Oner Active",
    html: `<p>Hi Domenico,</p><p>Oner Active's US expansion means your supply chain needs to scale without quality erosion.</p><p>Aarkissu: seamless knitting + flatlock stitching — relevant to Timeless and Amplify. 800 units/day. MOQ 500. BSCI-certified.</p><p>I can ship 3 sample pieces within a week. Would you be open to reviewing?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: 'Varley', to: 'frances@varley.com',
    subject: "Premium Nylon Activewear — Studio-to-Street Capsule",
    html: `<p>Hi Frances,</p><p>Varley's knitwear-meets-activewear aesthetic demands manufacturing precision — the fabric hand, drape, and structure all need to feel effortless.</p><p>Aarkissu: matte-finish nylon, seamless knitting, 4-way stretch. MOQ 500. BSCI-certified.</p><p>I'd love to send a fabric card and 3 sample constructions. Would you be open to that?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: 'LSKD', to: 'loganm@lskd.co',
    subject: "Nylon Activewear OEM — Raw Materials & Supply Chain Partnership",
    html: `<p>Hi Logan,</p><p>LSKD's sustainability push with Samsara Eco signals where your supply chain is heading.</p><p>Aarkissu: 4-way stretch, compression, anti-pill nylon. 800 units/day. MOQ 500. BSCI-certified, capability to pursue GRS.</p><p>I can send fabric samples and spec sheets. Would you be open to a brief call?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: 'LNDR', to: 'joanna.turner@lndr.com',
    subject: "BSCI-audited nylon production — your compression line",
    html: `<p>Hi Joanna,</p><p>Your compression leggings and support tops require a supplier that passes the paperwork and the product.</p><p>Aarkissu: BSCI-audited, nylon-only line. 4-way stretch with documented recovery. MOQ 500. 25 days.</p><p>I can send three technical samples and compliance dossier in seven days. What spec would you test first?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: 'NAGNATA', to: 'helena@nagnata.com',
    subject: "Seamless circular knit nylon — a factory that thinks in knitting parameters",
    html: `<p>Hi Helena,</p><p>NAGNATA's seamless knit textures are doing the design work. That kind of production requires a factory that thinks in knitting parameters, not just cutting and sewing.</p><p>Aarkissu: seamless circular knit nylon, soft-hand matte finish. MOQ 500. 25 days. BSCI-certified.</p><p>I can send fabric development swatches in 10 days. What gauge are you running?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: 'GMG/SSS', to: 'himani.sharma@gmg.com',
    subject: "Nylon modest activewear — engineered to your range plan, hot-climate tested",
    html: `<p>Dear Himani,</p><p>Gulf retailers don't buy off-the-shelf activewear. You spec the coverage, fabric weight, cut — and need a supplier who builds to your brief.</p><p>Aarkissu: long-sleeve tops, wide-leg pants, hijab-compatible. UPF 40+ nylon, tested above 35°C. 800 units/day. BSCI-certified.</p><p>I can prepare fabric swatches against your specification. Who owns the modest activewear development brief?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: 'Rebel Sport', to: 'rebecca.sargeant@rebelsport.com.au',
    subject: "Your activewear supplier list is missing a nylon specialist",
    html: `<p>Rebecca,</p><p>Multi-brand retail means your supplier roster has to cover every fabric category. Who's covering nylon? Every legging and crop on your women's wall relies on it.</p><p>Aarkissu: nylon-only, BSCI-certified. 800 units/day. 25-day turnaround. MOQ 500.</p><p>I can send a capability pack with fabric swatches and three samples. Would you be open to an introduction?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
  {
    name: 'Korea', to: 'aarkissu@gmail.com',
    subject: "Korean activewear market — nylon OEM partner from China",
    html: `<p>Hello,</p><p>Korea's yoga and Pilates market is one of Asia's most trend-sensitive. Coupang, Musinsa, and Zigzag demand fast turnaround and precise, narrow fit.</p><p>Aarkissu: soft matte nylon, Korean-spec sizing, 25-day turnaround. 800 units/day. MOQ 500. BSCI-certified.</p><p>I can ship sample pieces with Korean sizing within a week. Would you be open to reviewing?</p><p>Best,<br>Emma<br>Aarkissu</p>`,
  },
];

console.log(`Sending ${emails.length} emails...\n`);

for (const e of emails) {
  const body = {
    from: 'Emma / Aarkissu <V@mail.dealclaw.io>',
    to: [e.to],
    reply_to: ['aarkissu@163.com'],
    subject: e.subject,
    html: e.html,
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.ok) {
    console.log(`✅ ${e.name.padEnd(14)} ${e.to.padEnd(40)} ${data.id}`);
  } else {
    console.log(`❌ ${e.name.padEnd(14)} ${e.to.padEnd(40)} ${JSON.stringify(data)}`);
  }
  await new Promise(r => setTimeout(r, 800)); // Rate limit
}

console.log('\nDone.');
