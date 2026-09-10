import { createTransport } from 'nodemailer';

const transporter = createTransport({
  host: 'smtp.163.com',
  port: 465,
  secure: true,
  auth: {
    user: 'aarkissu@163.com',
    pass: 'ZBS3xXHAFNPAgtyS',
  },
});

const emails = [
  {
    name: 'Castore',
    to: ['adrian.harris@castore.co.uk'],
    subject: 'BSCI-audited nylon production — your compression line, one dedicated factory',
    html: `<p>Hi Adrian,</p>
<p>Castore's F1 and Premier League teamwear caught my attention — the precision in kit construction is exactly our manufacturing profile. You joined as CSCO recently — this is typically when supply chain evaluation happens.</p>
<p>Aarkissu is a BSCI-audited nylon activewear factory.</p>
<p>800 units/day. 4-way stretch nylon — compression, moisture-wicking, anti-pill. MOQ 500. 25-day lead time. BSCI-certified, full compliance on file.</p>
<p>I can ship 3 technical samples in 7 days, replicated to your spec. Would you be open to a brief call?</p>
<p>— Aarkissu</p>`,
  },
  {
    name: 'Adanola',
    to: ['niran@adanola.com'],
    subject: 'Activewear OEM — Incremental Capacity for Adanola Growth Phase',
    html: `<p>Hi Niran,</p>
<p>Adanola's trajectory over the past 18 months is impressive — and from your Gymshark days you know the China activewear supply chain better than most.</p>
<p>Aarkissu is a nylon activewear factory. Not pitching you on switching suppliers — offering incremental capacity as Adanola scales.</p>
<p>20,000+ units/month. Seamless knitting, flatlock stitching, 4-way stretch nylon. MOQ 500. 25-day turnaround. BSCI-certified.</p>
<p>When your growth outpaces current bandwidth, we're the capacity that kicks in without disrupting your core suppliers. Would you be open to a brief call?</p>
<p>— Aarkissu</p>`,
  },
  {
    name: "DICK'S",
    to: ['arushmore@dcsg.com', 'jenna.skellie@dcsg.com'],
    subject: 'Activewear OEM — Nylon-Focused Factory for DICKS Private Label',
    html: `<p>Hi Ali and Jenna,</p>
<p>DICK'S women's activewear private label — CALIA and DSG — now competes directly with Lululemon and Athleta. Your sourcing team is likely evaluating new nylon capacity for upcoming seasons.</p>
<p>Aarkissu is a BSCI-certified nylon activewear factory in China.</p>
<p>800 units/day. MOQ 500. 25-day turn. Core competency: 4-way stretch nylon — compression, sweat-wicking, anti-pill. Full compliance: BSCI audited, testing reports available. FOB pricing.</p>
<p>I can prepare a capability deck and 3 sample pieces within 48 hours. Would your team be open to reviewing?</p>
<p>— Aarkissu</p>`,
  },
  {
    name: 'Oner Active',
    to: ['domenico.prestia@oneractive.com'],
    subject: 'Nylon Activewear Capacity — Seamless & Compression for Oner Active',
    html: `<p>Hi Domenico,</p>
<p>Oner Active's US expansion means your supply chain is under real pressure to scale without quality erosion.</p>
<p>Aarkissu is a nylon activewear factory. Seamless knitting + flatlock stitching — directly relevant to Timeless and Amplify. 800 units/day. MOQ 500. 25-day turnaround. BSCI-certified.</p>
<p>Not proposing you switch — offering backup capacity for when growth outpaces current lines. I can ship 3 sample pieces mirroring your construction within a week.</p>
<p>Would you be open to reviewing?</p>
<p>— Aarkissu</p>`,
  },
  {
    name: 'Varley',
    to: ['frances@varley.com'],
    subject: 'Premium Nylon Activewear — Studio-to-Street Capsule',
    html: `<p>Hi Frances,</p>
<p>Varley's knitwear-meets-activewear aesthetic demands manufacturing precision — the fabric hand, drape, and structure all need to feel effortless.</p>
<p>Aarkissu is a nylon activewear specialist. Matte-finish, soft-hand nylon fabrics — aligned with Varley's studio-to-street DNA. Seamless knitting, 4-way stretch. MOQ 500. 25-day production. BSCI-certified.</p>
<p>I'd love to send a fabric card and 3 sample constructions. Would you be open to that?</p>
<p>— Aarkissu</p>`,
  },
  {
    name: 'LSKD',
    to: ['loganm@lskd.co'],
    subject: 'Nylon Activewear OEM — Raw Materials & Supply Chain Partnership',
    html: `<p>Hi Logan,</p>
<p>LSKD's sustainability push with Samsara Eco signals where your supply chain is heading. As Raw Materials Manager, you're evaluating whether new suppliers can meet both performance and sustainability benchmarks.</p>
<p>Aarkissu is a nylon activewear factory. 4-way stretch, compression, anti-pill. 800 units/day. MOQ 500. 25-day lead. BSCI-certified, capability to pursue GRS for recycled nylon.</p>
<p>I can send fabric samples and spec sheets. Would you be open to a brief call?</p>
<p>— Aarkissu</p>`,
  },
  {
    name: 'LNDR',
    to: ['joanna.turner@lndr.com'],
    subject: 'BSCI-audited nylon production — your compression line, one dedicated factory',
    html: `<p>Hi Joanna,</p>
<p>European retailer compliance isn't a checkbox — it's a supplier filter. Your compression leggings and support tops require a supplier that passes the paperwork and the product. We do both.</p>
<p>Aarkissu is a BSCI-audited nylon activewear factory. Nylon-only line. 4-way stretch with documented recovery. MOQ 500. 25 days. BSCI-certified.</p>
<p>I can send three technical samples and our compliance dossier in seven days. What spec would you test first?</p>
<p>— Aarkissu</p>`,
  },
  {
    name: 'NAGNATA',
    to: ['helena@nagnata.com'],
    subject: 'Seamless circular knit nylon — a factory that thinks in knitting parameters',
    html: `<p>Hi Helena,</p>
<p>Australian activewear buyers don't tolerate generic. Every brand competes on design identity — and production quality is the only thing between a premium price point and a discount rack.</p>
<p>Aarkissu is a nylon-focused BSCI-certified factory. Seamless circular knit nylon with engineered surface texture. MOQ 500. 25 days. Soft-hand, matte finish — no shiny leggings here.</p>
<p>I can send fabric development swatches in 10 days. What gauge are you currently running?</p>
<p>— Aarkissu</p>`,
  },
  {
    name: 'GMG / SSS',
    to: ['himani.sharma@gmg.com'],
    subject: 'Nylon modest activewear — engineered to your range plan, hot-climate tested',
    html: `<p>Dear Himani,</p>
<p>Gulf retailers don't buy off-the-shelf activewear. You spec the coverage, fabric weight, cut, colour palette — and you need a supplier who builds to your brief, not theirs.</p>
<p>Aarkissu is a nylon activewear factory. Full custom development: long-sleeve tops, wide-leg pants, hijab-compatible construction. UPF 40+ nylon, tested above 35°C. 800 units/day. 25-day lead. BSCI-certified.</p>
<p>I can prepare fabric swatches against your specification. Who owns the modest activewear development brief?</p>
<p>— Aarkissu</p>`,
  },
  {
    name: 'Rebel Sport',
    to: ['rebecca.sargeant@rebelsport.com.au'],
    subject: 'Your activewear supplier list is missing a nylon specialist',
    html: `<p>Rebecca,</p>
<p>Multi-brand sport retail means your supplier roster has to cover every fabric category. Who's covering nylon? Every legging, crop, and bra on your women's activewear wall relies on it.</p>
<p>Aarkissu is a nylon-only factory with BSCI certification. 800 units/day. 25-day turnaround. MOQ 500. Full testing documentation. BSCI-certified.</p>
<p>I can send a capability pack with fabric swatches and three sample constructions. Would you be open to a supplier introduction?</p>
<p>— Aarkissu</p>`,
  },
];

console.log(`发送 ${emails.length} 封开发信...\n`);

const results = [];
for (const email of emails) {
  for (const recipient of email.to) {
    try {
      const info = await transporter.sendMail({
        from: '"Aarkissu" <aarkissu@163.com>',
        to: recipient,
        subject: email.subject,
        html: email.html,
      });
      results.push({ buyer: email.name, to: recipient, status: 'OK', msgId: info.messageId });
      console.log(`✅ ${email.name.padEnd(15)} ${recipient.padEnd(40)} ${info.messageId}`);
    } catch (err) {
      results.push({ buyer: email.name, to: recipient, status: 'FAIL', reason: err.message });
      console.log(`❌ ${email.name.padEnd(15)} ${recipient.padEnd(40)} ${err.message}`);
    }
  }
}

await transporter.close();
console.log(`\n完成。成功 ${results.filter(r=>r.status==='OK').length} / 失败 ${results.filter(r=>r.status==='FAIL').length}`);
