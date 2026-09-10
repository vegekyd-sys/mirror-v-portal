#!/usr/bin/env python3
"""UN Forklift 沙特叉车买家开发信发送（lurong@mail.dealclaw.io，落款 Aimee）"""
import json, subprocess, sys

LEADS = "/tmp/forklift_to_send.json"
FROM = "lurong@mail.dealclaw.io"
SUBJECT = "UN Forklift \u2014 let's meet at the Saudi exhibition this December"

FREE_DOMAINS = {"gmail.com", "hotmail.com", "live.com", "outlook.com", "yahoo.com"}

def email_domain(em):
    return em.split("@")[-1].lower() if "@" in em else ""

def build_html(firstname, company, email):
    if email_domain(email) in FREE_DOMAINS or not company:
        company_line = ""
    else:
        company_line = f" and your team at {company}"
    html = f"""<p>Hi {firstname},</p>
<p>I'm Aimee, representing UN Forklift (Zhejiang UN Forklift Co., Ltd.) \u2014 a material-handling equipment manufacturer based in Hangzhou, China, with roots going back to 1978. We'll be exhibiting in Riyadh this December and would love to connect while we're there.</p>
<p><strong>What we make:</strong></p>
<ul>
<li>Diesel / LPG counterbalance forklifts (1.5\u201310T), incl. rough-terrain</li>
<li>Lithium-ion forklifts \u2014 our NL series pairs a heavy-duty diesel chassis with 5\u201310T electric drive (opportunity charging, no battery swap)</li>
<li>Electric 3-wheel &amp; 4-wheel forklifts (1.3\u20135T)</li>
<li>Reach trucks, VNA, pallet trucks &amp; stackers</li>
</ul>
<p><strong>Why buyers work with us:</strong></p>
<ul>
<li>Full in-house R&amp;D and manufacturing, OEM/ODM welcome</li>
<li>Emission compliance (Euro V / EPA Tier 4) on diesel; ZAPI controllers + BMS on electric</li>
<li>Growing Middle East presence and service support</li>
</ul>
<p>If you handle forklift / material-handling supply, rental, or distribution, I'd be glad to send a catalog and line up a meeting at the show. What categories or tonnages are you currently active in?</p>
<p>Best regards,<br>Aimee<br>UN Forklift<br>lurong@mail.dealclaw.io</p>"""
    return html

def send_one(email, firstname, company, dry_run=False):
    html = build_html(firstname, company, email)
    tmp = "/tmp/_forklift_letter.html"
    with open(tmp, "w") as f:
        f.write(html)
    args = [
        "node", "scripts/founder-direct/send-direct.mjs",
        "--from", FROM,
        "--to", email,
        "--subject", SUBJECT,
        "--html-file", tmp,
    ]
    if dry_run:
        args.append("--dry-run")
    out = subprocess.run(args, cwd="/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw",
                         capture_output=True, text=True, timeout=60)
    return out.stdout.strip() + out.stderr.strip()

if __name__ == "__main__":
    leads = json.load(open(LEADS))
    mode = sys.argv[1] if len(sys.argv) > 1 else "dry"
    if mode == "test":
        r = leads[0]
        print(f"[TEST dry-run] {r['to']}")
        print(send_one(r["to"], r["firstname"], r["company"], dry_run=True))
    elif mode == "real":
        done = fail = 0
        for i, r in enumerate(leads, 1):
            try:
                out = send_one(r["to"], r["firstname"], r["company"], dry_run=False)
                if "resendId" in out:
                    done += 1
                    print(f"[OK] {i} {r['to']}")
                else:
                    fail += 1
                    print(f"[FAIL] {i} {r['to']} -> {out[:120]}")
            except Exception as e:
                fail += 1
                print(f"[ERR] {i} {r['to']} -> {e}")
        print(f"\n完成: 成功 {done}, 失败 {fail}, 共 {len(leads)}")
