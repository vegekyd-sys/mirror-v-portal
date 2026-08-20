#!/usr/bin/env python3
"""光大普特 沙特买家开发信发送（Resend via lurong@mail.dealclaw.io）"""
import json, subprocess, sys, os

LEADS = "/tmp/saudi_leads_to_send.json"
FROM = "lurong@mail.dealclaw.io"
FROM_DISPLAY = "lurong@mail.dealclaw.io"
SUBJECT = "Meet Guangda Technology at our Saudi exhibition, Dec 9\u201311"

FREE_DOMAINS = {"gmail.com", "hotmail.com", "live.com", "outlook.com", "yahoo.com"}

def email_domain(em):
    return em.split("@")[-1].lower() if "@" in em else ""

def build_html(firstname, company, email):
    # 公司句：免费邮箱去公司名，避免张冠李戴
    if email_domain(email) in FREE_DOMAINS or not company:
        company_line = ""
    else:
        company_line = f" and your team at {company}"
    html = f"""<p>Hi {firstname},</p>
<p>I'm Aimee from Guangda Technology \u2014 a cable manufacturer based in Hangzhou, China, operating since 2006. We specialize in coaxial, fiber optic, and power cables for telecom, broadcast, and utility networks, and we've been deepening our presence in the Saudi market.</p>
<p>I'm reaching out because we'll be exhibiting in Riyadh this December, December 9\u201311, and I'd love to connect while we're there.</p>
<p><strong>What we'll be showcasing:</strong></p>
<ul>
<li>Coaxial cable: RG6 / RG11, for CATV, satellite and CCTV</li>
<li>Fiber optic cable: indoor/outdoor, FTTH drop cable, and patch cords</li>
<li>Power &amp; control cables: LV/MV, plus solar cables for PV projects</li>
<li>Custom OEM runs, with UL / CE / RoHS support as needed</li>
</ul>
<p><strong>A few reasons buyers choose us:</strong></p>
<ul>
<li>In-house production (201\u2013300 staff), full QC from raw material to finished cable</li>
<li>Consistent lead times and established export experience in the Middle East</li>
<li>Competitive pricing without compromising on copper and fiber quality</li>
</ul>
<p>If any of this fits what you source, I'd be glad to send a catalog in advance and arrange a meeting at the show. Would you be open to a short conversation in Riyadh, or are there specific cable types you're currently focused on?</p>
<p>Best regards,<br>Aimee<br>Guangda Technology<br>lurong@mail.dealclaw.io</p>"""
    return html

def send_one(email, firstname, company, dry_run=False):
    html = build_html(firstname, company, email)
    # 用 resend/send.mjs；no tracking/unsubscribe；reply-to 本人
    args = [
        "node", "scripts/founder-direct/send-direct.mjs",
        "--from", FROM_DISPLAY,
        "--to", email,
        "--subject", SUBJECT,
    ]
    if dry_run:
        args += ["--dry-run"]
    # 写 html 到临时文件避免 shell 转义
    tmp = "/tmp/_dev_letter.html"
    with open(tmp, "w") as f:
        f.write(html)
    args += ["--html-file", tmp]
    out = subprocess.run(args, cwd="/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw",
                         capture_output=True, text=True, timeout=60)
    return out.stdout.strip() + out.stderr.strip()

def main():
    leads = json.load(open(LEADS))
    mode = sys.argv[1] if len(sys.argv) > 1 else "dry"
    if mode == "test":
        # 只发第一封（企业邮箱），dry-run
        r = leads[0]
        print(f"[TEST] dry-run to {r['to']}")
        print(send_one(r["to"], r["firstname"], r["company"], dry_run=True))
        return
    if mode == "real":
        done, fail = 0, 0
        for i, r in enumerate(leads):
            res = send_one(r["to"], r["firstname"], r["company"], dry_run=False)
            if "Error" in res or "error" in res.lower():
                fail += 1
                print(f"[FAIL] {i+1} {r['to']}: {res}")
            else:
                done += 1
                print(f"[OK] {i+1} {r['to']}")
        print(f"\n完成: 成功 {done}, 失败 {fail}, 共 {len(leads)}")
        return
    print("usage: python send_saudi_dev_letters.py [test|real]")

if __name__ == "__main__":
    main()
