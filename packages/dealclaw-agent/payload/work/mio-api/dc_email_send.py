#!/usr/bin/env python3
"""DC-EmailSend — 邮件发送统一入口（发送 + 批次回执 + 落库 + 窗口路由）

职责：
  1. 跑底层 node 发送脚本（GS: scripts/resend/send.mjs；FD: scripts/founder-direct/send-direct.mjs）
  2. 发送成功/失败后，推「批次回执」到 receipt_target（一次动作一条汇总，不逐封）
  3. best-effort 落 dc_send_log（enterprise 提供时）
  4. 带 --country 时做窗口路由：不在买家工作日 8-18 窗口 → 转待发队列（除非 --now 强发）

用法：
  python3 dc_email_send.py send --channel GS --from 'V <v@mail.dealclaw.io>' \
      --to a@x.com,b@y.com --subject '...' [--html ...] [--text ...] \
      [--country BR --city 'Sao Paulo'] --receipt-target oc_xxx [--now]
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
        if not account_id:
            # 匹配不到发件账号 → 不落事实。account_id 是回复挂回原发件的唯一依据，
            # 兜底取 accounts[0] 会串账号，比漏写更糟。
            return
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


_MANAGED_DOMAIN = "mail.dealclaw.io"


def _is_managed_address(address: str) -> bool:
    """是否 DealClaw 托管邮箱（@mail.dealclaw.io）。闸门异常时决定 fail-closed 还是放行。"""
    try:
        from email_gateway.provision import canonical_address
        return canonical_address(address).endswith("@" + _MANAGED_DOMAIN)
    except Exception:  # noqa: BLE001
        # 连规范化都不可用：退回字符串判定，宁可保守
        return _MANAGED_DOMAIN in str(address or "").lower()


def _switch_blocked(enterprise: str) -> dict | None:
    """发信刹车开关（T8）：``None`` = 放行；dict = 拒绝（平台级 / 租户级）。

    平台级总开关与租户级隔离开关对**自有邮箱和托管邮箱都生效**——额度按租户切，
    但所有租户共用同一个 ``mail.dealclaw.io`` + 同一个 Provider 账号，坏租户能拖垮
    整个域，所以这里不按邮箱类型豁免（在发信闸门的 applicable 判定之前）。

    开关读取失败：不阻断 + stderr 响亮告警（有意取舍，见 send_control.blocked_result）。
    """
    try:
        from email_gateway.send_control import blocked_result
        blocked = blocked_result(enterprise)
        if blocked is not None:
            print(f"[dc_email_send] 发信被刹车开关拒绝（{blocked['code']}）：{blocked['reason']}",
                  file=sys.stderr)
        return blocked
    except Exception as e:  # noqa: BLE001 — 开关自身不可用时不得误伤全部发信
        print("[dc_email_send] 发信刹车开关不可用 → 不阻断发信（保可用性）："
              f"{type(e).__name__}: {e}", file=sys.stderr)
        return None


def _preflight_gate(enterprise: str, from_addr: str) -> tuple[dict | None, dict | None]:
    """发信前置闸门。返回 ``(gate, blocked)``；``blocked`` 非空即拒绝发送。

    - 先判刹车开关（T8，平台级 / 租户级，自有邮箱与托管邮箱都判）；
    - 正常路径：交给 ``email_gateway.provision.check_send_ready``；自有邮箱
      ``applicable=False`` → 放行，既有发信行为不变；
    - 闸门自身异常：**托管邮箱 fail-closed**（拒绝发送，避免回信进黑洞），
      **自有邮箱不受影响**（放行）。
    """
    blocked_switch = _switch_blocked(enterprise)
    if blocked_switch is not None:
        return None, blocked_switch

    try:
        from email_gateway.provision import check_send_ready, gate_blocked_result
        gate = check_send_ready(enterprise_id=enterprise, from_address=from_addr)
        if not gate.get("allowed"):
            return gate, gate_blocked_result(gate)
        return gate, None
    except Exception as e:  # noqa: BLE001
        if _is_managed_address(from_addr):
            print("[dc_email_send] 发信闸门异常 → 托管邮箱拒绝发送（fail-closed）："
                  f"{type(e).__name__}: {e}", file=sys.stderr)
            return None, {
                "success": False,
                "sent": False,
                "count": 0,
                "error": ("默认邮箱就绪检查异常，已拒绝发送（托管邮箱 fail-closed）："
                          f"{type(e).__name__}"),
                "code": "send_gate_error",
                "blockers": [f"gate_error:{type(e).__name__}"],
                "gate": None,
            }
        print("[dc_email_send] 发信闸门异常 → 自有邮箱放行（不受影响）："
              f"{type(e).__name__}: {e}", file=sys.stderr)
        return None, None


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

    # ── 发信前置闸门（触发 B）：进入发信流程之前 ──────────────
    # 只对 DealClaw 托管默认邮箱（mail.dealclaw.io）判定；自有邮箱 applicable=False，
    # 行为与改动前完全一致。默认 enforce：未就绪拒绝发送，绝不产生「邮件已发出」的假成功。
    # 托管邮箱 fail-closed、自有邮箱不受影响（2026-09-15 定）
    gate, blocked = _preflight_gate(enterprise, from_addr)
    if blocked is not None:
        if receipt_target:
            try:
                from dc_send_receipt import push_receipt
                push_receipt(receipt_target, f"❌ 邮件未发送（{n} 封）：{blocked['error']}")
            except Exception:  # noqa: BLE001
                pass
        return blocked

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
    if receipt_target:
        if success:
            msg = f"✅ 邮件已发出：本轮 {n} 封"
        else:
            msg = f"❌ 邮件发送失败：本轮 {n} 封" + (f"（{err[:120]}）" if err else "")
        try:
            from dc_send_receipt import push_receipt
            push_receipt(receipt_target, msg)
        except Exception:  # noqa: BLE001
            pass

    # best-effort 落库
    if enterprise:
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

    # 只有 FD 通道才补落：GS 通道 send.mjs 已通过 dc_record_outbound.py 落过，再落会重复
    if success and resend_id and enterprise and channel.upper() == "FD":
        _land_outbound_fact(from_addr=from_addr, to_list=to_list, subject=subject,
                            resend_id=resend_id, enterprise=enterprise)

    return {"success": success, "count": n, "error": err, "resend_id": resend_id,
            "sent": bool(success), "gate": gate}


def _cli() -> int:
    ap = argparse.ArgumentParser(description="邮件发送统一入口")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send", help="发送（带 --country 时按窗口路由）")
    s.add_argument("--channel", required=True, choices=["GS", "FD"])
    s.add_argument("--from", dest="from_addr", required=True)
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

        # 窗口路由：有 country 且不在窗口且未 --now → 转待发队列
        if args.country and not args.now and not in_window(args.country, args.city):
            from dc_pending_send import enqueue
            tw = compute_target_window_utc(args.country, args.city)
            rec = enqueue(channel=args.channel, from_addr=args.from_addr, to_list=to_list,
                          subject=args.subject, html=args.html, text=args.text,
                          cc=cc or [], bcc=bcc or [], country=args.country, city=args.city,
                          receipt_target=args.receipt_target, enterprise=args.enterprise,
                          target_window=tw)
            rec["queued"] = True
            rec["target_window"] = tw
            print(json.dumps(rec, ensure_ascii=False))
            return 0

        r = send_batch(channel=args.channel, from_addr=args.from_addr, to_list=to_list,
                       subject=args.subject, html=args.html, text=args.text, cc=cc, bcc=bcc,
                       receipt_target=args.receipt_target, enterprise=args.enterprise)
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("success") else 1
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
