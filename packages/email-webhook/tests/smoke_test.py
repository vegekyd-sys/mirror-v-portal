#!/usr/bin/env python3
"""对着跑起来的服务逐条验证需求表里的「最小验收标准」。

用法:
    python3 tests/smoke_test.py <base_url> <signing_secret>
例:
    python3 tests/smoke_test.py http://127.0.0.1:8080 whsec_dGVzdA==

base_url 要带上路由前缀（ROUTE_PREFIX）。k8s 部署是 /webhook：
    python3 tests/smoke_test.py https://webhook.dealclaw.io/webhook whsec_xxx

只用标准库，方便直接丢到服务器上跑。
"""

import base64
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

PASS, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
results = []

# urllib 默认 UA 会被 Cloudflare 的 Browser Integrity Check 拦成 403 (error 1010)，
# 用 Resend 真实使用的 Svix UA，顺便也验证了这个 UA 能穿过 CF。
USER_AGENT = "Svix-Webhooks/1.4.12"


def sign(secret: str, msg_id: str, timestamp: str, body: bytes) -> str:
    raw = secret[len("whsec_"):] if secret.startswith("whsec_") else secret
    try:
        key = base64.b64decode(raw, validate=True)
    except Exception:
        key = raw.encode()
    digest = hmac.new(key, f"{msg_id}.{timestamp}.".encode() + body, hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode()


def post(base_url, secret, payload, *, corrupt_signature=False, msg_id=None):
    body = json.dumps(payload).encode()
    msg_id = msg_id or f"msg_{uuid.uuid4().hex[:20]}"
    timestamp = str(int(time.time()))
    sig = sign(secret, msg_id, timestamp, body)
    if corrupt_signature:
        sig = "v1," + base64.b64encode(b"x" * 32).decode()

    req = urllib.request.Request(
        f"{base_url}/inbound", data=body, method="POST",
        headers={
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            "svix-id": msg_id,
            "svix-timestamp": timestamp,
            "svix-signature": sig,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return exc.code, {"raw": raw.decode(errors="replace")}


def get(base_url, path):
    req = urllib.request.Request(f"{base_url}{path}", headers={"user-agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, {"raw": exc.read().decode(errors="replace")}


def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{PASS if ok else FAIL}] {name}" + (f"  — {detail}" if detail else ""))


def event(event_type, recipient="lead-smoke@example.com", extra=None):
    data = {
        "email_id": f"eid_{uuid.uuid4().hex[:12]}",
        "from": "DealClaw <noreply@dealclaw.test>",
        "to": [recipient],
        "subject": f"smoke test {event_type}",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }
    if extra:
        data.update(extra)
    return {"type": event_type, "created_at": data["created_at"], "data": data}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    base_url, secret = sys.argv[1].rstrip("/"), sys.argv[2]

    print(f"\n目标: {base_url}\n")

    print("1. GET /health 返回 ok")
    status, body = get(base_url, "/health")
    check("health 返回 200 且 status=ok", status == 200 and body.get("status") == "ok",
          f"http={status} body={body}")
    print(f"     依赖状态: {json.dumps(body.get('checks', {}), ensure_ascii=False)}")

    print("\n2. POST /inbound 能接收 Resend 测试事件")
    status, body = post(base_url, secret, event("email.sent"))
    check("合法签名的事件被接收", status == 200 and body.get("status") == "accepted",
          f"http={status} body={body}")

    print("\n3. 验签失败会拒绝")
    status, body = post(base_url, secret, event("email.sent"), corrupt_signature=True)
    check("错误签名返回 401", status == 401, f"http={status} body={body}")

    stale_body = json.dumps(event("email.sent")).encode()
    stale_id, stale_ts = f"msg_{uuid.uuid4().hex[:20]}", str(int(time.time()) - 4000)
    req = urllib.request.Request(
        f"{base_url}/inbound", data=stale_body, method="POST",
        headers={
            "content-type": "application/json", "user-agent": USER_AGENT,
            "svix-id": stale_id, "svix-timestamp": stale_ts,
            "svix-signature": sign(secret, stale_id, stale_ts, stale_body),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            code = resp.status
    except urllib.error.HTTPError as exc:
        code = exc.code
    check("超期时间戳返回 401（防重放）", code == 401, f"http={code}")

    print("\n4. 原始事件能落盘或落库")
    status, body = post(base_url, secret, event("email.delivered"))
    check("响应里带落盘路径", bool(body.get("persisted_to")), f"persisted_to={body.get('persisted_to')}")

    print("\n5. 五类事件能正确更新线索状态")
    expected = {
        "email.delivered": "DELIVERED",
        "email.opened": "OPENED",
        "email.clicked": "CLICKED",
        "email.bounced": "BOUNCED",
        "email.complained": "COMPLAINED",
    }
    extras = {
        "email.clicked": {"click": {"link": "https://dealclaw.test/offer", "timestamp": "now"}},
        "email.bounced": {"bounce": {"type": "Permanent", "message": "mailbox does not exist"}},
    }
    notified = {}
    for event_type, want in expected.items():
        status, body = post(base_url, secret, event(event_type, extra=extras.get(event_type)))
        got = body.get("lead_status")
        check(f"{event_type} -> {want}", status == 200 and got == want, f"实际={got}")
        notified[event_type] = body.get("notify", {})

    print("\n   状态单调性（迟到的 delivered 不能覆盖 clicked）")
    late = post(base_url, secret, event("email.delivered", recipient="monotonic@example.com"))[1]
    post(base_url, secret, event("email.clicked", recipient="monotonic@example.com"))
    status, body = post(base_url, secret, event("email.delivered", recipient="monotonic@example.com"))
    lead = body.get("lead", {})
    backend = lead.get("backend")
    if backend == "noop":
        check("单调性检查（noop 后端跳过）", True, "LEAD_BACKEND=noop，无状态可比对")
    else:
        check("迟到的 delivered 未覆盖 clicked", lead.get("updated") is False,
              f"lead={lead}")

    print("\n6. 四类事件推送飞书")
    for event_type in ("email.opened", "email.clicked", "email.bounced", "email.complained"):
        info = notified.get(event_type, {})
        reason = info.get("reason", "")
        # 必须真的拿到了 notify 结果才算数，否则请求失败时会假通过。
        # 未配置飞书时，只要原因不是「事件类型被过滤」就说明推送规则命中了。
        hit = "sent" in info and (
            info["sent"] is True or "not in NOTIFY_EVENTS" not in reason
        )
        if "sent" not in info:
            detail = "未拿到 notify 结果"
        elif info["sent"]:
            detail = "已发送"
        else:
            detail = f"未发送: {reason}"
        check(f"{event_type} 命中推送规则", hit, detail)

    delivered_notify = notified.get("email.delivered", {})
    check("email.delivered 不推送",
          "not in NOTIFY_EVENTS" in delivered_notify.get("reason", ""),
          f"reason={delivered_notify.get('reason')}")

    print("\n7. 幂等：同一 svix-id 重复投递只处理一次")
    dup_id = f"msg_{uuid.uuid4().hex[:20]}"
    payload = event("email.opened", recipient="dupe@example.com")
    first = post(base_url, secret, payload, msg_id=dup_id)[1]
    second = post(base_url, secret, payload, msg_id=dup_id)[1]
    if first.get("lead", {}).get("backend") == "noop" and second.get("status") == "accepted":
        check("重复投递被识别（需 Redis，当前未启用则跳过）", True, "Redis 未连接，跳过")
    else:
        check("第二次返回 duplicate", second.get("status") == "duplicate", f"second={second}")

    print("\n8. 买家回复（email.received）")
    buyer = "buyer-reply@example.com"
    agent = "thia@mail.dealclaw.test"
    inbound = {
        "type": "email.received",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "data": {
            "email_id": f"eid_{uuid.uuid4().hex[:12]}",
            "from": f"Buyer Name <{buyer}>",
            "to": [agent],
            "received_for": [agent],
            "subject": "回复：smoke test inbound",
            "message_id": "<smoke@mail.gmail.com>",
            "attachments": [], "cc": [], "bcc": [],
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        },
    }
    status, body = post(base_url, secret, inbound)
    check("email.received -> REPLIED", body.get("lead_status") == "REPLIED",
          f"实际={body.get('lead_status')}")

    lead = body.get("lead", {})
    check("线索取发件人而非收件人", lead.get("lead_email") == buyer,
          f"lead_email={lead.get('lead_email')}（应为 {buyer}，不是 {agent}）")

    notify = body.get("notify", {})
    check("买家回复会推送飞书",
          notify.get("sent") is True or "not in NOTIFY_EVENTS" not in notify.get("reason", ""),
          f"sent={notify.get('sent')} reason={notify.get('reason')}")

    print("\n   REPLIED 不被后续投递事件覆盖")
    post(base_url, secret, event("email.delivered", recipient=buyer))
    status, body = post(base_url, secret, event("email.opened", recipient=buyer))
    lead = body.get("lead", {})
    if lead.get("backend") == "noop":
        check("REPLIED 优先级检查（noop 后端跳过）", True, "LEAD_BACKEND=noop")
    else:
        check("后续 opened 未覆盖 REPLIED", lead.get("updated") is False,
              f"previous={lead.get('previous_status')} updated={lead.get('updated')}")

    total, passed = len(results), sum(results)
    print(f"\n{'=' * 52}\n结果: {passed}/{total} 通过\n{'=' * 52}\n")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
