#!/usr/bin/env python3
"""DC-EmailSend — 邮件发送**唯一入口**（发送 + 批次回执 + 落库 + 窗口路由）

职责：
  1. 按账号解析传输并发送（B 收敛，2026-09-13）：
       provider=resend（dealclaw_proxy）→ Resend API 路径（scripts/resend/send.mjs；
       FD 走 scripts/founder-direct/send-direct.mjs）
       personal（netease_163 / tencent_exmail / aliyun_exmail / gmail）
                                   → email_gateway.SmtpSender（与 email_gateway.cli send 同源）
  2. 发送成功/失败后，推「批次回执」到 receipt_target（一次动作一条汇总，不逐封）
  3. best-effort 落 dc_send_log（enterprise 提供时）
  4. 带 --country 时做窗口路由：不在买家工作日 8-18 窗口 → 转待发队列（除非 --now 强发）

账号解析优先级（选一种）：
  1. --account-id ema_xxx  → 账号权威：provider=resend → Resend API；personal → SMTP
  2. --channel GS/FD       → 向后兼容：沿用 Resend API 路径（不带 --account-id 时）
  3. 只给 --from           → 按发件地址反查邮箱账号；查不到则必须补 --channel

用法：
  python3 dc_email_send.py send --channel GS --from 'V <v@mail.dealclaw.io>' \
      --to a@x.com,b@y.com --subject '...' [--html ...] [--text ...] \
      [--country BR --city 'Sao Paulo'] --receipt-target oc_xxx [--now]
  python3 dc_email_send.py send --account-id ema_xxx --to a@x.com --subject '...' \
      --text '...' --enterprise 100000834234 [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent            # work/mio-api
WORKSPACE = HERE.parents[1]                        # dealclaw 根目录
ENV_FILE = HERE / ".env"

GS_SCRIPT = WORKSPACE / "scripts" / "resend" / "send.mjs"
FD_SCRIPT = WORKSPACE / "scripts" / "founder-direct" / "send-direct.mjs"

# personal（个人邮箱）provider：走 SMTP，不发 Resend API
SMTP_PROVIDERS = {"netease_163", "tencent_exmail", "aliyun_exmail", "gmail"}


def _transport_for_account(account: dict) -> str:
    """账号 → 传输类型：resend / smtp / ""（未知）。

    provider=resend 或 mailbox_kind=dealclaw_proxy → Resend API（现有路径）；
    其余 personal provider（163/腾讯/阿里/gmail）→ SMTP。
    """
    provider = str(account.get("provider", "")).strip().lower()
    if provider == "resend" or str(account.get("mailbox_kind", "")).strip() == "dealclaw_proxy":
        return "resend"
    if provider in SMTP_PROVIDERS:
        return "smtp"
    return ""


def resolve_transport(*, account_id: str = "", from_addr: str = "", channel: str = "",
                      enterprise: str = "") -> dict:
    """解析发信传输。返回 {transport, account, from_addr, channel, provider, error}。

    唯一口径：有 --account-id 时账号权威；无账号但给了 --channel 时保持旧 Resend 路径
    （向后兼容优先）；只给 --from 时反查账号，查不到要求补 --channel。
    """
    channel = (channel or "").strip().upper()
    out = {"transport": "", "account": None, "from_addr": (from_addr or "").strip(),
           "channel": "", "provider": "", "error": ""}

    account = None
    if account_id:
        try:
            from email_gateway.store import EmailStore
            account = EmailStore().get_account(account_id)
        except Exception as exc:  # noqa: BLE001  KeyError / IO
            out["error"] = f"email account not found: {account_id} ({type(exc).__name__})"
            return out
    elif from_addr:
        if channel:
            # 向后兼容：显式 --channel GS/FD → 沿用 Resend API 路径
            out.update({"transport": "resend", "channel": channel, "provider": "resend"})
            return out
        try:
            from email_gateway.send_entry import find_account_by_address
            from email_gateway.store import EmailStore
            account = find_account_by_address(EmailStore(), from_addr, enterprise_id=enterprise)
        except Exception:  # noqa: BLE001  查账号失败不阻断 Resend 兼容路径
            account = None
        if not account:
            out["error"] = ("no email account matches --from and no --channel given; "
                            "pass --account-id or --channel GS/FD")
            return out
    else:
        out["error"] = "either --account-id or --from is required"
        return out

    transport = _transport_for_account(account)
    if not transport:
        out["error"] = (f"account {account.get('account_id', '')} has unsupported provider "
                        f"{account.get('provider', '')!r}")
        return out
    out["account"] = account
    out["transport"] = transport
    out["provider"] = account.get("provider", "")
    if not out["from_addr"]:
        out["from_addr"] = str(account.get("email_address", ""))
    # Resend 路径仍需要 GS/FD 选脚本：account 指定时默认 GS（dealclaw_proxy 直发）
    out["channel"] = channel or ("GS" if transport == "resend" else "")
    return out


def _push_receipt(target: str, success: bool, count: int, err: str = "") -> None:
    """批次回执（一次动作一条，不逐封）。best-effort，不影响发送结果。"""
    if not target:
        return
    if success:
        msg = f"✅ 邮件已发出：本轮 {count} 封"
    else:
        msg = f"❌ 邮件发送失败：本轮 {count} 封" + (f"（{err[:120]}）" if err else "")
    try:
        from dc_send_receipt import push_receipt
        push_receipt(target, msg)
    except Exception:  # noqa: BLE001
        pass


def _log_send(*, channel: str, to_list: list[str], subject: str, resend_id: str,
              enterprise: str) -> None:
    """best-effort 落 dc_send_log（enterprise 提供时）。"""
    if not enterprise:
        return
    try:
        from dc_send_log import SendLog
        slog = SendLog()
        for t in to_list:
            slog.log_send(buyer_domain=t.split("@")[-1], buyer_name="",
                          buyer_email=t, channel=channel.upper(), round_num=1,
                          user_open_id="", enterprise=enterprise, subject=subject[:200],
                          resend_id=resend_id)
    except Exception:  # noqa: BLE001
        pass


def send_personal(*, account: dict, to_list: list[str], subject: str, text: str = "",
                  html: str = "", cc: list[str] | None = None, bcc: list[str] | None = None,
                  receipt_target: str = "", enterprise: str = "", confirmed_by: str = "",
                  dry_run: bool = False) -> dict:
    """personal（SMTP）账号发信：调用 email_gateway.send_entry（与 cli send 同一实现）。

    落 outbound 事实由 SmtpSender 内部完成（provider_status 无投递终态时落 unavailable）。
    异常转成结构化失败结果（success=False + error），与 send_batch 返回口径一致。

    不写 dc_send_log：那份日志的 channel 口径只有 GS/FD（轮次统计按 buyer_domain+channel
    聚合），塞一个新值会污染 GS/FD 轮次；personal 通道的发送台账口径另行收敛。
    """
    if not to_list:
        return {"success": False, "error": "empty recipients", "count": 0, "transport": "smtp"}
    if not text and not html:
        return {"success": False, "error": "provide --text or --html", "count": len(to_list),
                "transport": "smtp"}
    if not dry_run and not enterprise:
        return {"success": False,
                "error": "missing enterprise（发送必须带 --enterprise）", "count": len(to_list),
                "transport": "smtp"}
    try:
        from email_gateway.send_entry import send_for_account
        from email_gateway.store import EmailStore
        res = send_for_account(
            EmailStore(), account=account, to=to_list, cc=cc, bcc=bcc, subject=subject,
            text=text, html=html or None, dry_run=dry_run, confirmed_by=confirmed_by,
        )
        out = {"success": bool(res.get("ok")), "count": len(to_list), "error": "",
               "resend_id": "", "message_id": res.get("message_id", ""),
               "provider": account.get("provider", ""), "transport": "smtp"}
    except Exception as e:  # noqa: BLE001
        out = {"success": False, "count": len(to_list),
               "error": f"{type(e).__name__}: {e}"[:300], "resend_id": "",
               "provider": account.get("provider", ""), "transport": "smtp"}

    _push_receipt(receipt_target, out["success"], len(to_list), out.get("error", ""))
    return out


def load_env() -> None:
    """把 work/mio-api/.env 读入 os.environ（setdefault，不覆盖已设值）。"""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def compute_target_window_utc(country: str, city: str | None = None) -> str:
    """下一个买家当地工作日 8:00，转 UTC ISO。复用 send_window 的时区解析。"""
    from send_window import resolve_timezone, next_window
    import pytz
    tzname = resolve_timezone(country, city)
    tz = pytz.timezone(tzname)
    now = datetime.now(tz)
    nxt = next_window(now)
    return nxt.astimezone(timezone.utc).isoformat()


def in_window(country: str, city: str | None = None) -> bool:
    """当前是否在买家当地工作日 8-18 窗口内。"""
    from send_window import resolve_timezone
    import pytz
    tzname = resolve_timezone(country, city)
    tz = pytz.timezone(tzname)
    now = datetime.now(tz)
    return (now.weekday() < 5) and (8 <= now.hour < 18)


def _land_outbound_fact(*, from_addr: str, to_list: list[str], subject: str,
                        resend_id: str, enterprise: str) -> None:
    """发信成功后 best-effort 落 outbound 事实（收信匹配的唯一依据）。

    为什么必须有：收信侧靠 outbound 事实判断「这封回复回的是哪封邮件」。
    直发通道只写 sent-log 不落事实时，匹配不到（no_matching_outbound），
    信号永远不生成、通知永远不弹——而且不报错。事实层少写一条 → 下游静默失效。
    这里失败只记日志，不影响发送结果本身。
    """
    try:
        from email_gateway.store import EmailStore
        store = EmailStore()
        accounts: list = []
        try:
            accounts = store.list_accounts(enterprise_id=enterprise) or []
        except Exception:  # noqa: BLE001
            accounts = []
        addr = (from_addr or "").split("<")[-1].strip(" <>").lower()
        account_id = ""
        for a in accounts:
            if str(a.get("email_address", "")).lower() == addr:
                account_id = str(a.get("account_id", ""))
                break
        if not account_id and accounts:
            account_id = str(accounts[0].get("account_id", ""))
        now = datetime.now(timezone.utc).isoformat()
        store.insert_message({
            "account_id": account_id,
            "direction": "outbound",
            "message_id": f"local_{uuid.uuid4().hex[:16]}",
            "sender": from_addr,
            "recipients": list(to_list),
            "subject": subject,
            "company_id": enterprise,
            "resend_id": resend_id,
            "local_message_id": resend_id or "",
            "provider_status": "accepted",
            "sent_at": now,
            "created_at": now,
        })
    except Exception as e:  # noqa: BLE001
        print(f"[dc_email_send] 落 outbound 事实失败（不影响发送结果）：{type(e).__name__}: {e}",
              file=sys.stderr)


def send_batch(channel: str, from_addr: str, to_list: list[str], subject: str,
               html: str = "", text: str = "", cc: list[str] | None = None,
               bcc: list[str] | None = None, receipt_target: str = "",
               enterprise: str = "", password: str | None = None) -> dict:
    """跑底层发送脚本，成功/失败后推批次回执，best-effort 落库。返回结构化结果。"""
    load_env()
    to_list = [t for t in to_list if t and t.strip()]
    n = len(to_list)
    if n == 0:
        return {"success": False, "error": "empty recipients", "count": 0}
    if not enterprise:
        # 发送必须带 enterprise，否则不落 send_log、早报查不到发送记录（裸发漏日志根因）
        return {"success": False, "error": "missing enterprise（发送必须带 --enterprise）", "count": 0}

    script = GS_SCRIPT if channel.upper() == "GS" else FD_SCRIPT
    cmd = ["node", str(script), "--from", from_addr, "--to", ",".join(to_list),
           "--subject", subject]
    if html:
        cmd += ["--html", html]
    if text:
        cmd += ["--text", text]
    if cc:
        cmd += ["--cc", ",".join(cc)]
    if bcc:
        cmd += ["--bcc", ",".join(bcc)]
    if password:
        cmd += ["--password", password]
    if channel.upper() == "GS" and enterprise:
        # GS 直发走 send.mjs，把 enterprise 传给 --company-id，
        # 发送成功后 send.mjs 会落 outbound 事实进 email-facts，dc_followup 才能扫到。
        cmd += ["--company-id", enterprise]

    try:
        r = subprocess.run(cmd, cwd=str(WORKSPACE), capture_output=True, text=True,
                           timeout=180, stdin=subprocess.DEVNULL)
        success = r.returncode == 0
        err = (r.stderr or r.stdout or "").strip()[-300:] if not success else ""
    except subprocess.TimeoutExpired:
        success, err = False, "send timeout after 180s"
    except Exception as e:  # noqa: BLE001
        success, err = False, f"{type(e).__name__}: {e}"

    # 解析底层发送脚本返回的 resend_id（GS send.mjs → data.id；FD send-direct.mjs → resendId）
    resend_id = ""
    if success:
        try:
            out = json.loads(r.stdout.strip())
            resend_id = out.get("id") or out.get("resendId") or ""
        except Exception:  # noqa: BLE001
            pass

    # 批次回执（一次动作一条，不逐封）
    _push_receipt(receipt_target, success, n, err)

    # best-effort 落库
    _log_send(channel=channel, to_list=to_list, subject=subject, resend_id=resend_id,
              enterprise=enterprise)

    # best-effort 落 outbound 事实（收信侧靠它把回复挂回原发件）
    if success and resend_id and enterprise:
        _land_outbound_fact(from_addr=from_addr, to_list=to_list, subject=subject,
                            resend_id=resend_id, enterprise=enterprise)

    return {"success": success, "count": n, "error": err, "resend_id": resend_id,
            "transport": "resend", "provider": "resend"}


def _cli() -> int:
    ap = argparse.ArgumentParser(description="邮件发送统一入口")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send", help="发送（带 --country 时按窗口路由）")
    s.add_argument("--channel", default=None, choices=["GS", "FD"],
                   help="向后兼容：Resend API 通道（GS: send.mjs / FD: send-direct.mjs）")
    s.add_argument("--account-id", default="", help="邮箱账号 id（ema_xxx）：按 provider 分派传输")
    s.add_argument("--from", dest="from_addr", default="", help="发件地址（可反查账号）")
    s.add_argument("--confirmed-by", default="", help="确认发送的 user open_id（默认账号 owner）")
    s.add_argument("--dry-run", action="store_true", help="只校验不真实发送（仅 personal 账号路径）")
    s.add_argument("--to", required=True)
    s.add_argument("--subject", required=True)
    s.add_argument("--html", default="")
    s.add_argument("--text", default="")
    s.add_argument("--cc", default="")
    s.add_argument("--bcc", default="")
    s.add_argument("--country", default="")
    s.add_argument("--city", default="")
    s.add_argument("--receipt-target", default="")
    s.add_argument("--enterprise", required=True, help="企业 key（必填，用于落 send_log）")
    s.add_argument("--now", action="store_true", help="跳过窗口检查，当场发")

    args = ap.parse_args()
    if args.cmd == "send":
        to_list = [x.strip() for x in args.to.split(",") if x.strip()]
        cc = [x.strip() for x in args.cc.split(",") if x.strip()] if args.cc else None
        bcc = [x.strip() for x in args.bcc.split(",") if x.strip()] if args.bcc else None

        # 发信入口收敛：先按账号解析传输（resend / smtp），再决定走向
        tr = resolve_transport(account_id=args.account_id, from_addr=args.from_addr,
                               channel=args.channel or "", enterprise=args.enterprise)
        if tr.get("error"):
            print(json.dumps({"success": False, "count": 0, "error": tr["error"]},
                             ensure_ascii=False))
            return 1
        channel = tr.get("channel") or "GS"
        from_addr = tr.get("from_addr") or args.from_addr

        # 窗口路由：有 country 且不在窗口且未 --now → 转待发队列
        if args.country and not args.now and not in_window(args.country, args.city):
            if tr["transport"] != "resend":
                # 待发队列只存 GS/FD 通道（重放走 send_batch），personal 账号不在队列口径内
                print(json.dumps({
                    "success": False, "count": len(to_list),
                    "error": "pending queue supports GS/FD (Resend) only; "
                             "pass --now to send personal account immediately",
                }, ensure_ascii=False))
                return 1
            from dc_pending_send import enqueue
            tw = compute_target_window_utc(args.country, args.city)
            rec = enqueue(channel=channel, from_addr=from_addr, to_list=to_list,
                          subject=args.subject, html=args.html, text=args.text,
                          cc=cc or [], bcc=bcc or [], country=args.country, city=args.city,
                          receipt_target=args.receipt_target, enterprise=args.enterprise,
                          target_window=tw)
            rec["queued"] = True
            rec["target_window"] = tw
            print(json.dumps(rec, ensure_ascii=False))
            return 0

        if tr["transport"] == "smtp":
            r = send_personal(account=tr["account"], to_list=to_list, subject=args.subject,
                              text=args.text, html=args.html, cc=cc, bcc=bcc,
                              receipt_target=args.receipt_target, enterprise=args.enterprise,
                              confirmed_by=args.confirmed_by, dry_run=args.dry_run)
        else:
            if args.dry_run:
                print(json.dumps({"success": False, "count": len(to_list),
                                  "error": "--dry-run is only supported on the personal(SMTP) path"},
                                 ensure_ascii=False))
                return 1
            r = send_batch(channel=channel, from_addr=from_addr, to_list=to_list,
                           subject=args.subject, html=args.html, text=args.text, cc=cc, bcc=bcc,
                           receipt_target=args.receipt_target, enterprise=args.enterprise)
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("success") else 1
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
