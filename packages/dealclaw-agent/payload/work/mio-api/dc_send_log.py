#!/usr/bin/env python3
"""DC-SL 发送日志引擎 — 每次GS/FD发送自动写日志，供面板聚合用"""

import json, os, re, time
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
SENDLOG_FILE = DATA_DIR / "send_log.jsonl"

SEND_EVENTS = ["sent", "delivered", "bounced", "opened", "clicked", "replied", "unsubscribed", "complained"]


def _now():
    return datetime.now(timezone.utc).isoformat()


def _today_str(tz_shift_hours=8):
    return (datetime.now(timezone.utc) + timedelta(hours=tz_shift_hours)).strftime("%Y-%m-%d")


class SendLog:
    """发送日志引擎"""

    def __init__(self):
        os.makedirs(str(DATA_DIR), exist_ok=True)
        self._audit = None

    def _audit_log(self, action, user_open_id, enterprise, target, detail):
        if not enterprise:
            return
        try:
            if self._audit is None:
                from dc_audit import AuditLog
                self._audit = AuditLog()
            self._audit.log(action, user_open_id=user_open_id, enterprise=enterprise,
                            target=target, detail=detail)
        except Exception:
            from dc_degrade import degrade
            degrade.decide("audit_write", enterprise=enterprise)

    def _append(self, entry):
        entry["_ts"] = _now()
        with open(SENDLOG_FILE, 'a') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    def _read(self, hours=48):
        """读取最近N小时的日志"""
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        records = []
        if not SENDLOG_FILE.exists():
            return records
        with open(SENDLOG_FILE) as f:
            for line in f:
                try:
                    r = json.loads(line.strip())
                    if r.get("_ts","") >= cutoff:
                        records.append(r)
                except:
                    pass
        return records

    # ── 记录发送 ──

    def log_send(self, buyer_domain, buyer_name, buyer_email, channel, round_num,
                 user_open_id, enterprise, subject, resend_id="", fd_id=""):
        """GS/FD 每次发送时调此方法。resend_id 用于后续 webhook 关联。必须写入企业租户。"""
        if not enterprise:
            raise ValueError("log_send requires enterprise for tenant isolation")
        self._append({
            "type": "sent",
            "buyer_domain": buyer_domain,
            "buyer_name": buyer_name,
            "buyer_email": buyer_email,
            "channel": channel,       # GS / FD
            "round": round_num,        # 1/2/3
            "user_open_id": user_open_id,
            "enterprise": enterprise,
            "subject": subject[:200],
            "resend_id": resend_id or "",
            "fd_id": fd_id or "",
            "status": "sent",
        })

        # 审计：发送记录
        self._audit_log("send.gs" if channel == "GS" else "send.fd",
                        user_open_id, enterprise, buyer_email,
                        f"{channel} R{round_num}: {subject[:60]}")
        # 🔗 Heartbeat: 邮件发送记录
        try:
            from heartbeat_data import append_email_send
            msg_id = resend_id or fd_id or f"{enterprise}_{buyer_domain}_{int(time.time())}"
            append_email_send(
                message_id=msg_id,
                buyer=buyer_name or buyer_domain,
                contact=buyer_email,
                channel=channel,
                status="sent",
            )
        except Exception as _hb_err:
            print(f"[heartbeat] append_email_send failed: {_hb_err}")

    def log_delivery(self, resend_id="", fd_id="", status="delivered", detail=""):
        """投递状态回调：delivered / bounced。Resend webhook 或 FD IMAP 回调。"""
        self._append({
            "type": "delivery",
            "resend_id": resend_id or "",
            "fd_id": fd_id or "",
            "status": status,
            "detail": detail[:500],
        })

    def log_engagement(self, resend_id="", fd_id="", event="opened", detail=""):
        """打开/点击回调。event: opened / clicked。"""
        self._append({
            "type": "engagement",
            "resend_id": resend_id or "",
            "fd_id": fd_id or "",
            "event": event,
            "detail": detail[:500],
        })

    def log_reply(self, buyer_domain, buyer_name, reply_text, channel, iq_intent="", iq_stage=0,
                  user_open_id="", enterprise=""):
        """买家回复日志。由 DC-IQ 处理完调此方法。必须写入企业租户。"""
        if not enterprise:
            raise ValueError("log_reply requires enterprise for tenant isolation")
        self._append({
            "type": "reply",
            "buyer_domain": buyer_domain,
            "buyer_name": buyer_name,
            "channel": channel,
            "reply_text": reply_text[:500],
            "user_open_id": user_open_id,
            "enterprise": enterprise,
            "iq_intent": iq_intent,
            "iq_stage": iq_stage,
            "status": "replied",
        })

    # ── 查询 / 聚合 ──

    def stats_today(self, user_open_id="", enterprise="", tz_hours=8):
        """今日统计：发送/到达/退信/打开/点击/回复。enterprise 必填。"""
        if not enterprise:
            raise ValueError("stats_today requires enterprise for tenant isolation")
        today = _today_str(tz_hours)
        records = self._read(36)
        sent = []; delivered = []; bounced = []; opened = []; clicked = []; replied = []

        for r in records:
            ts = r.get("_ts","")
            if not ts.startswith(today):
                continue
            if user_open_id and r.get("user_open_id") != user_open_id:
                continue
            if enterprise and r.get("enterprise","").lower() != enterprise.lower():
                continue
            t = r.get("type","")
            if t == "sent": sent.append(r)
            elif t == "delivery":
                if r.get("status") == "delivered": delivered.append(r)
                elif r.get("status") == "bounced": bounced.append(r)
            elif t == "engagement":
                if r.get("event") == "opened": opened.append(r)
                elif r.get("event") == "clicked": clicked.append(r)
            elif t == "reply": replied.append(r)

        return {
            "date": today, "sent": len(sent), "delivered": len(delivered),
            "bounced": len(bounced), "opened": len(opened),
            "clicked": len(clicked), "replied": len(replied),
        }

    def stats_yesterday(self, user_open_id="", enterprise="", tz_hours=8):
        """昨日统计（供早间日报用）。enterprise 必填。"""
        if not enterprise:
            raise ValueError("stats_yesterday requires enterprise for tenant isolation")
        yesterday = ((datetime.now(timezone.utc) + timedelta(hours=tz_hours)) - timedelta(days=1)).strftime("%Y-%m-%d")
        records = self._read(48)
        sent = []; delivered = []; bounced = []; opened = []; clicked = []; replied = []
        sent_ids = set()  # resend_ids for this user
        for r in records:
            ts = r.get("_ts","")
            if not ts.startswith(yesterday):
                continue
            t = r.get("type","")
            # user/enterprise filter: strict for sent, loose for delivery/engagement (linked by resend_id)
            match = True
            if t == "sent":
                if user_open_id and r.get("user_open_id") != user_open_id: match = False
                if enterprise and r.get("enterprise","").lower() != enterprise.lower(): match = False
                if match: sent.append(r); sent_ids.add(r.get("resend_id","")); sent_ids.add(r.get("fd_id",""))
            elif t in ("delivery","engagement"):
                rid = r.get("resend_id","") or r.get("fd_id","")
                # Only count if linked to a sent event in this enterprise scope.
                if rid and rid in sent_ids:
                    if t == "delivery":
                        if r.get("status") == "delivered": delivered.append(r)
                        elif r.get("status") == "bounced": bounced.append(r)
                    else:
                        if r.get("event") == "opened": opened.append(r)
                        elif r.get("event") == "clicked": clicked.append(r)
            elif t == "reply":
                if user_open_id and r.get("user_open_id","") != user_open_id: continue
                replied.append(r)
        return {"date":yesterday, "sent":len(sent), "delivered":len(delivered),
                "bounced":len(bounced), "opened":len(opened),
                "clicked":len(clicked), "replied":len(replied)}

    def stats_ndays(self, days, user_open_id="", enterprise=""):
        """最近N天统计。enterprise 必填。"""
        if not enterprise:
            raise ValueError("stats_ndays requires enterprise for tenant isolation")
        records = self._read(days*24 + 4)
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        sent = []; delivered = []; bounced = []; replied = []

        dedup_sent = set()
        for r in records:
            ts = r.get("_ts","")[:10]
            if ts < cutoff: continue
            if user_open_id and r.get("user_open_id") != user_open_id: continue
            if enterprise and r.get("enterprise","").lower() != enterprise.lower(): continue
            t = r.get("type","")
            if t == "sent":
                key = r.get("buyer_domain","") + r.get("channel","")
                if key not in dedup_sent:
                    sent.append(r); dedup_sent.add(key)
            elif t == "delivery":
                if r.get("status") == "delivered": delivered.append(r)
                elif r.get("status") == "bounced": bounced.append(r)
            elif t == "reply": replied.append(r)

        return {"days":days, "sent":len(sent), "delivered":len(delivered),
                "bounced":len(bounced), "replied":len(replied)}

    def recent_activities(self, limit=20, user_open_id="", enterprise=""):
        """最近活动列表。enterprise 必填。"""
        if not enterprise:
            raise ValueError("recent_activities requires enterprise for tenant isolation")
        records = self._read(72)
        if user_open_id:
            records = [r for r in records if r.get("user_open_id","") == user_open_id]
        if enterprise:
            records = [r for r in records if r.get("enterprise","",).lower() == enterprise.lower()]
        records.sort(key=lambda r: r.get("_ts",""), reverse=True)
        return records[:limit]

    def buyer_timeline(self, buyer_domain, enterprise, limit=50):
        """单个买家的完整时间线。enterprise 必填。"""
        if not enterprise:
            raise ValueError("buyer_timeline requires enterprise for tenant isolation")
        records = self._read(720)  # 30 days
        records = [r for r in records if r.get("buyer_domain") == buyer_domain and r.get("enterprise","").lower() == enterprise.lower()]
        records.sort(key=lambda r: r.get("_ts",""))
        return records[-limit:]

    def is_unsubscribed(self, buyer_domain, enterprise):
        """检查买家是否已退订/投诉。退订后禁止一切渠道发送。"""
        if not enterprise:
            raise ValueError("is_unsubscribed requires enterprise")
        ent = enterprise.lower()
        domain = buyer_domain.lower()
        records = self._read(8760)  # 365 天
        for r in records:
            if (r.get("enterprise","").lower() == ent and
                (r.get("buyer_domain","").lower() == domain) and
                r.get("type") in ("unsubscribed", "complained")):
                return True
        return False


if __name__ == "__main__":
    import sys
    log = SendLog()
    if len(sys.argv) < 3:
        print("dc_send_log.py stats|activity <enterprise> [user] | timeline <enterprise> <buyer_domain>")
        sys.exit(1)
    cmd = sys.argv[1]
    enterprise = sys.argv[2]
    if cmd == "stats":
        print(json.dumps(log.stats_today(
            enterprise=enterprise, user_open_id=sys.argv[3] if len(sys.argv)>3 else ""), ensure_ascii=False, indent=2))
    elif cmd == "activity":
        for r in log.recent_activities(limit=10,
            enterprise=enterprise, user_open_id=sys.argv[3] if len(sys.argv)>3 else ""):
            print(f"[{r.get('_ts','')[:19]}] {r.get('type','?'):10s} {r.get('buyer_name',''):20s} {r.get('status',''):10s}")
    elif cmd == "timeline":
        if len(sys.argv) < 4:
            print("用法: timeline <enterprise> <buyer_domain>"); sys.exit(1)
        for r in log.buyer_timeline(sys.argv[3], enterprise=enterprise):
            print(json.dumps(r, ensure_ascii=False))
    elif cmd == "can-send":
        # python dc_send_log.py can-send <enterprise> <buyer_domain>
        # 退出码 0 = 可发送, 1 = 已退订/投诉, 2 = 参数不足
        if len(sys.argv) < 4:
            print(json.dumps({"can_send": False, "reason": "参数不足: 需要 enterprise 和 buyer_domain"}))
            sys.exit(2)
        blocked = log.is_unsubscribed(sys.argv[3], enterprise=sys.argv[2])
        if blocked:
            print(json.dumps({"can_send": False, "reason": "买家已退订或投诉，禁止发送"}))
            sys.exit(1)
        else:
            print(json.dumps({"can_send": True}))
            sys.exit(0)
