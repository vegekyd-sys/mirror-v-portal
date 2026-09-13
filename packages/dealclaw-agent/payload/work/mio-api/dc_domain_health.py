#!/usr/bin/env python3
"""dc_domain_health.py — 域名收发体检（只读）

一次跑完回答三个问题：

  1. **能不能收信**：MX 记录是否存在、收信入口指向哪里
     （MX 在 ≠ 能收进系统——它只解决"信到了服务商"）
  2. **发出去会不会被降权**：SPF / DKIM / DMARC
  3. **收信有没有接进系统**：账户收信通道（mailbox_kind）、binding 的
     inbound_filter/notify_enabled、最近一条 inbound 事实时间

为什么要它：09-12 那次「send.dealclaw.io 收不到回复」，根因被写成"没配 MX"，
实测 MX 是有的——真正的问题在收信链路后面的环节。靠人工去后台比对，
下一次还是会把三环里断的那一环猜错。**让系统先发现，而不是客户先发现。**

只读保证：只做 DNS 查询（dig）与本地文件读取；不发信、不改配置、不写任何存储。
`--webhook-url` 只做一次 GET /health（确认入站端点活着），不带任何凭据。

用法：
    python3 dc_domain_health.py --domains send.dealclaw.io,mail.dealclaw.io
    python3 dc_domain_health.py --domains ... --data-dir "$DC_DATA_DIR" --json
    python3 dc_domain_health.py --domains ... --webhook-url "$DC_WEBHOOK_URL"
    （--webhook-url 默认读 DC_WEBHOOK_URL；**不写死域名**——写死历史地址就是被过期文档误导）

退出码：0 = 全部 ok / 只有 warning；1 = 有域「不能收信」；2 = 入参错误
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

# 收信入口特征：MX 指向这里说明接进了服务商的入站收信
RECEIVING_MX_HINTS = ("inbound-smtp", "inbound.", "mx.")
DEFAULT_DOMAINS = ("mail.dealclaw.io", "send.dealclaw.io")

STATUS_OK = "ok"
STATUS_WARN = "warning"
STATUS_BROKEN = "broken"


# ── DNS（只读）────────────────────────────────────────────

def _dig(domain: str, rrtype: str, runner=None) -> list[str]:
    """返回 dig +short 的结果行（去空）。runner 供测试注入，默认调真 dig。"""
    if runner is not None:
        return [x for x in runner(domain, rrtype) if x]
    try:
        p = subprocess.run(["dig", "+short", rrtype, domain],
                           capture_output=True, text=True, timeout=15)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    if p.returncode != 0:
        return []
    return [ln.strip().strip('"') for ln in p.stdout.splitlines() if ln.strip()]


def _txt_values(rows: list[str]) -> str:
    return " ".join(rows)


def check_domain(domain: str, runner=None) -> dict:
    """单域体检：MX / SPF / DKIM / DMARC + 判定。"""
    mx = _dig(domain, "MX", runner)
    txt = _txt_values(_dig(domain, "TXT", runner))
    spf = next((t for t in txt.split() if t.lower().startswith("v=spf1")), "")
    dkim = bool(_dig(f"resend._domainkey.{domain}", "TXT", runner))
    dmarc = _txt_values(_dig(f"_dmarc.{domain}", "TXT", runner))

    reasons: list[str] = []
    if mx:
        receiving = STATUS_OK
        if not any(h in " ".join(mx).lower() for h in RECEIVING_MX_HINTS):
            reasons.append(f"MX 指向非典型收信入口：{mx[0]}（确认服务商是否支持收信）")
            receiving = STATUS_WARN
    else:
        receiving = STATUS_BROKEN
        reasons.append("无 MX 记录：外部邮件无法投递到这个域（收信从第 1 环就断了）")

    if not spf:
        reasons.append("apex 无 SPF（若 MAIL FROM 用子域，请确认子域有 SPF，否则送达降权）")
    if not dkim:
        reasons.append("无 DKIM（resend._domainkey 查不到）：发信验签缺失，易进垃圾箱")
    if not dmarc:
        reasons.append("无 DMARC（_dmarc 查不到）：伪造防护为零，部分收件方直接降权")

    if receiving == STATUS_BROKEN:
        verdict = STATUS_BROKEN
    elif not (spf and dkim and dmarc) or receiving == STATUS_WARN:
        verdict = STATUS_WARN
    else:
        verdict = STATUS_OK

    return {
        "domain": domain,
        "receiving": receiving,
        "sending": STATUS_OK if dkim else STATUS_BROKEN,
        "verdict": verdict,
        "mx": mx,
        "spf": spf,
        "dkim": dkim,
        "dmarc": dmarc,
        "reasons": reasons,
    }


# ── 系统侧：收信通道（只读本地事实）──────────────────────

def load_accounts(data_dir: str | Path) -> list[dict]:
    """读 email-facts 的 accounts + bindings（只读）。"""
    root = Path(data_dir)
    facts = root / "email-facts" if (root / "email-facts").exists() else root
    accounts: dict[str, dict] = {}
    for p in sorted((facts / "accounts").rglob("*.md")) if (facts / "accounts").exists() else []:
        rec = _read_record(p)
        if not rec:
            continue
        aid = str(rec.get("account_id") or p.stem)
        accounts[aid] = {
            "account_id": aid,
            "enterprise": rec.get("enterprise_id", ""),
            "provider": rec.get("provider", ""),
            "mailbox_kind": rec.get("mailbox_kind", ""),
            "enabled": rec.get("enabled", ""),
            # 收信通道由 mailbox_kind 决定：proxy 走入站 webhook，personal 走 IMAP 拉取
            "inbound_channel": "webhook" if rec.get("mailbox_kind") == "dealclaw_proxy" else "imap",
            "bindings": [],
        }
    for p in sorted((facts / "bindings").rglob("*.md")) if (facts / "bindings").exists() else []:
        rec = _read_record(p)
        if not rec:
            continue
        acc = accounts.get(str(rec.get("account_id") or ""))
        if acc is None:
            continue
        acc["bindings"].append({
            "binding_id": rec.get("binding_id", ""),
            "inbound_filter": rec.get("inbound_filter", ""),
            "notify_enabled": rec.get("notify_enabled", ""),
        })
    return list(accounts.values())


def _read_record(path: Path) -> dict | None:
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                return obj
    except OSError:
        return None
    return None


def last_inbound_at(data_dir: str | Path, enterprise: str = "") -> str:
    """最近一条 inbound 事实时间（判断收信链路是否真的在工作）。"""
    root = Path(data_dir)
    facts = root / "email-facts" if (root / "email-facts").exists() else root
    last = ""
    for p in sorted((facts / "inbound").rglob("*.md")) if (facts / "inbound").exists() else []:
        rec = _read_record(p)
        if not rec:
            continue
        if enterprise and str(rec.get("company_id", "")) != enterprise:
            continue
        ts = str(rec.get("received_at") or rec.get("created_at") or "")
        if ts > last:
            last = ts
    return last


def check_track_endpoint(webhook_url: str | None) -> dict:
    """打开追踪像素端点体检：GET `<webhook>/px/<probe>`。

    404 = 服务端没有该路由 → 像素永远加载失败、而且不报错（邮件里带一张死图）。
    只有 200 且 content-type 是图片才算真通。
    """
    if not webhook_url:
        return {"checked": False, "status": "skipped", "note": "未提供 webhook 地址"}
    target = webhook_url.rstrip("/") + "/px/dc-health-probe"
    try:
        with urllib.request.urlopen(target, timeout=10) as resp:  # noqa: S310
            ctype = resp.headers.get("Content-Type", "")
            ok = resp.status < 400 and "image" in ctype
            return {"checked": True, "url": target, "http_status": resp.status,
                    "content_type": ctype, "status": "ok" if ok else "error"}
    except urllib.error.HTTPError as e:
        return {"checked": True, "url": target, "http_status": e.code,
                "status": "missing_route" if e.code == 404 else "error"}
    except Exception as e:  # noqa: BLE001
        return {"checked": True, "url": target, "status": "error",
                "error": f"{type(e).__name__}: {e}"}


def check_webhook(url: str | None) -> dict:
    """入站端点体检：一次 GET /health（只读，不带凭据）。"""
    if not url:
        return {"checked": False, "status": "skipped", "note": "未提供 --webhook-url"}
    target = url.rstrip("/") + "/health"
    try:
        with urllib.request.urlopen(target, timeout=10) as resp:  # noqa: S310
            return {"checked": True, "status": "ok" if resp.status < 400 else "error",
                    "http_status": resp.status, "url": target}
    except Exception as e:  # noqa: BLE001
        return {"checked": True, "status": "error", "url": target,
                "error": f"{type(e).__name__}: {e}"}


# ── 汇总 ─────────────────────────────────────────────────

def run_checks(domains, *, data_dir=None, webhook_url=None, runner=None) -> dict:
    domain_reports = [check_domain(d, runner=runner) for d in domains]
    out = {
        "object": "domain_health",
        "read_only": True,
        "sends_mail": False,
        "domains": domain_reports,
        "webhook": check_webhook(webhook_url),
        "track_endpoint": check_track_endpoint(webhook_url),
        "summary": {
            "domains": len(domain_reports),
            "broken": sum(1 for d in domain_reports if d["verdict"] == STATUS_BROKEN),
            "warning": sum(1 for d in domain_reports if d["verdict"] == STATUS_WARN),
            "ok": sum(1 for d in domain_reports if d["verdict"] == STATUS_OK),
        },
    }
    if data_dir:
        accounts = load_accounts(data_dir)
        out["accounts"] = accounts
        out["last_inbound_at"] = last_inbound_at(data_dir)
    return out


def render_text(report: dict) -> str:
    lines = ["【域名收发体检】（只读 · 不发信 · 不改配置）"]
    for d in report["domains"]:
        mark = {STATUS_OK: "✅", STATUS_WARN: "⚠️", STATUS_BROKEN: "❌"}[d["verdict"]]
        lines.append(f"{mark} {d['domain']}  收信={d['receiving']} 发信={d['sending']}")
        lines.append(f"     MX={d['mx'] or '（无）'}")
        lines.append(f"     SPF={'有' if d['spf'] else '无'} · DKIM={'有' if d['dkim'] else '无'}"
                     f" · DMARC={'有' if d['dmarc'] else '无'}")
        for r in d["reasons"]:
            lines.append(f"     - {r}")
    w = report["webhook"]
    if w.get("checked"):
        lines.append(f"入站端点 /health：{w.get('status')}（{w.get('url')}）")
    else:
        lines.append(f"入站端点：未检查（{w.get('note', '')}）")
    t = report.get("track_endpoint") or {}
    if t.get("checked"):
        extra = (" ← 服务端没有 /px 路由，像素永远加载失败"
                 if t.get("status") == "missing_route" else "")
        lines.append(f"追踪像素端点：{t.get('status')}（http={t.get('http_status')}）{extra}")
    else:
        lines.append(f"追踪像素端点：未检查（{t.get('note', '')}）")
    if "accounts" in report:
        lines.append("账户收信通道：")
        for a in report["accounts"]:
            binds = "、".join(f"{b['inbound_filter']}/notify={b['notify_enabled']}"
                              for b in a["bindings"]) or "（无绑定）"
            lines.append(f"  · {a['account_id']} kind={a['mailbox_kind']}"
                         f" → 通道={a['inbound_channel']} · {binds}")
        lines.append(f"最近 inbound 事实：{report.get('last_inbound_at') or '（无）'}")
    s = report["summary"]
    lines.append(f"汇总：ok {s['ok']} · warning {s['warning']} · broken {s['broken']}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="域名收发体检（只读）")
    ap.add_argument("--domains", default=",".join(DEFAULT_DOMAINS),
                    help="逗号分隔的域名列表")
    ap.add_argument("--data-dir", default=None, help="DC_DATA_DIR（读账户/收信通道）")
    ap.add_argument("--webhook-url", default=os.environ.get("DC_WEBHOOK_URL") or None,
                    help="入站端点（只 GET /health 与 /px 探活）；默认读 DC_WEBHOOK_URL")
    ap.add_argument("--json", action="store_true")
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    domains = [d.strip() for d in (args.domains or "").split(",") if d.strip()]
    if not domains:
        print("--domains 不能为空", file=sys.stderr)
        return 2
    report = run_checks(domains, data_dir=args.data_dir,
                        webhook_url=args.webhook_url)
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json
          else render_text(report))
    return 1 if report["summary"]["broken"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
