#!/usr/bin/env python3
"""Internal email: CAFE CALUPOH meeting decision → Lucky (main) + waimao + maxiaodong (cc)."""
import os, json, datetime, requests

WORKSPACE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw"
ENV = os.path.join(WORKSPACE, "work/mio-api/.env")

def load_key():
    for line in open(ENV):
        line = line.strip()
        if line.startswith("RESEND_API_KEY="):
            return line.split("=", 1)[1]
    return ""

FROM = "thia@mail.dealclaw.io"
TO = ["lucky@stelang.com"]
CC = ["waimao@stelang.com", "maxiaodong@meorient.com"]
SUBJECT = "CAFÉ CALUPOH 客户约见面 — 请决策跟进（墨西哥咖啡买家）"

BODY = """Lucky，你好，

墨西哥买家 CAFÉ CALUPOH（咖啡行业专业买家，Luis）已回复，表达了面谈意向，需要你决策如何跟进。背景如下：

客户情况：
- CAFÉ CALUPOH 是墨西哥咖啡行业专业买家（Wega 咖啡机官方分销），品类与雪特朗咖啡机高度对口。
- Luis 8/21 首询「更新目录+价格表+商业条件」；8/25 我方 follow-up 后，8/30 回复「同意面谈，那几天会住在酒店，希望约在酒店附近见面」。

时间/地点冲突（关键）：
- 客户参加的是 Expo Café（9/3-5，WTC + Pepsi Center，CDMX），住 WTC 附近酒店；
- 我方展会是 China Homelife（9/8-10，Citibanamex，CDMX）；
- 两个展时间不重叠、场馆不同（WTC vs Citibanamex），客户无法直接来我方 9/8-10 展位。

需你决策的几点：
1. 约见方案选哪个：
   A. 约客户 9/3-5 期间、在 Expo Café（WTC）或其酒店附近面谈（客户最方便，但我方参展人员需 9 月初已在墨）；
   B. 约客户 9/8-10 来我方 Citibanamex 展位看样品（有样品/展位，但客户 Expo Café 后可能已离开墨城）；
   C. 折中：两种都提，让客户选（推荐）。
2. 我方参展人员 9 月初的在墨具体时间？（决定 A 是否可行）

后续由你回复并跟进客户，客户邮箱和往来记录附下。

客户邮箱：arthur.242@gmail.com（Luis）

（此邮件为内部沟通，不发给客户。）
"""

def main():
    api_key = load_key()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"from": FROM, "to": TO, "cc": CC, "subject": SUBJECT, "text": BODY}
    r = requests.post("https://api.resend.com/emails", headers=headers, json=payload, timeout=30)
    res = r.json()
    rid = res.get("id", "?")
    status = "OK" if r.status_code == 200 else f"FAIL {r.status_code}"
    print(f"{status} | 主收={TO} CC={CC} | {rid} | {r.status_code}")
    if r.status_code != 200:
        print(json.dumps(res, ensure_ascii=False)[:400])
    else:
        log = os.path.join(WORKSPACE, "scripts/founder-direct/sent-log.jsonl")
        with open(log, "a") as f:
            f.write(json.dumps({"ts": datetime.datetime.now().isoformat(), "from": FROM, "to": TO, "cc": CC, "subject": SUBJECT, "resend_id": rid, "status": status, "type": "internal"}, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()
