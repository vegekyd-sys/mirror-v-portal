#!/usr/bin/env python3
"""
dc_webhook_handler.py — 本地邮件事实链业务处理（P0-E3C）

职责：把远端 webhook 事件落地成 outbound 状态更新 / sendlog / 七信号 /
push 候选。事件本身由服务端 FastAPI（`dealclaw.datathink.com/webhook` 的 /inbound）收 + 验签 +
暂存，经 dc_email_ingest canonical claim 去重后，进到本模块：

  handle_status_event(event_type, data)  → 投递状态（delivered/bounced/complained/failed）
  handle_inbound_event(data)             → 买家回信（绑定 outbound → log_reply → 七信号 + push）

已拆走的部分（历史遗留，本模块不再承担）：
  - Flask 接收服务（/inbound、/health 路由、app.run）—— 接收 webhook 已由服务端 FastAPI 负责；
  - 旧飞书通知旁路（_legacy_inbound_notify / _iq_decide / _send_auto_reply / _send_feishu_notify）。

保留但标注：Svix 验签函数（signature_check / verify_signature / _svix_signature / ...）与
binding 解析（resolve_binding / load_dynamic_bindings / PROXY_MAP）是纯逻辑函数，历史测试
（email_gateway/tests/test_p0e1_facts.py）仍覆盖它们；生产上验签由服务端 FastAPI 完成、
入站绑定由 _account_for_to + store.find_outbound_by_* 完成，这里保留仅为兼容与单元测试。
"""

import base64
import hashlib
import hmac
import json
import os
import re
import time
from urllib.request import Request, urlopen

# 配置（运行时读取）
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")

STATUS_EVENT_TYPES = {
    "email.delivered": "delivered",
    "email.bounced": "bounced",
    "email.complained": "complained",
    "email.failed": "failed",
}
INBOUND_EVENT_TYPES = ("email.received", "inbound", "email.inbound")

# 本 handler 所属飞书应用（open_id 是 app 级，路由键需含 app_id）
HANDLER_APP_ID = os.getenv("DEALCLAW_FEISHU_APP_ID", "cli_a9365919fc3a1bd6")

# 代理邮箱 → 企业映射（legacy 硬编码，仅入站通知路由 fallback；不得覆盖动态绑定）
PROXY_MAP = {
    "thia@mail.dealclaw.io": {"enterprise": "meorient.com", "owner": "田耕郡",
                               "open_id": "ou_3fe4922d138f37c5a9fbd6ce7aa89570",
                               "app_id": "cli_a9365919fc3a1bd6"},
}


# ── 依赖（懒加载，便于测试注入）──────────────────────────────
_store = None
_store_db_path = None


def get_store():
    """返回 EmailStore 单例。数据目录由 DC_DATA_DIR 控制。"""
    global _store, _store_db_path
    from email_gateway.store import EmailStore
    data_dir = os.getenv("DC_DATA_DIR", "")
    if _store is None or _store_db_path != data_dir:
        _store = EmailStore(data_dir or None)
        _store_db_path = data_dir
    return _store




# ── Svix 验签（官方算法；生产由服务端 FastAPI 负责，这里保留供单元测试）──
def _decode_webhook_secret(secret: str) -> bytes:
    """whsec_... → base64(url-safe) 解码出 HMAC key bytes。"""
    if secret.startswith("whsec_"):
        secret = secret[len("whsec_"):]
    secret = secret.replace("-", "+").replace("_", "/")
    padding = "=" * (-len(secret) % 4)
    return base64.b64decode(secret + padding)


def _svix_signature(secret: str, svix_id: str, svix_timestamp: str, payload: str) -> str:
    secret_bytes = _decode_webhook_secret(secret)
    signed = f"{svix_id}.{svix_timestamp}.{payload}".encode("utf-8")
    digest = hmac.new(secret_bytes, signed, hashlib.sha256).digest()
    return base64.b64encode(digest).decode("utf-8")


def verify_signature(secret: str, svix_id: str, svix_timestamp: str, payload: str,
                     signature_header: str) -> bool:
    """Svix: signature_header 形如 `v1,<base64>`（可多个空格分隔）。恒定时间比较。"""
    if not secret or not signature_header:
        return False
    expected = _svix_signature(secret, svix_id, svix_timestamp, payload)
    for part in signature_header.split(" "):
        part = part.strip()
        if "," not in part:
            continue
        version, sig = part.split(",", 1)
        if version == "v1" and hmac.compare_digest(sig, expected):
            return True
    return False


def _timestamp_in_window(svix_timestamp: str, tolerance: int = 300) -> bool:
    try:
        ts = int(svix_timestamp)
    except (ValueError, TypeError):
        return False
    return abs(int(time.time()) - ts) <= tolerance


def signature_check(payload: str, svix_id: str, svix_timestamp: str,
                    svix_signature: str) -> tuple[bool, str, int]:
    """返回 (ok, error_message, status_code)。"""
    secret = os.getenv("RESEND_WEBHOOK_SECRET", "")
    dev_mode = os.getenv("RESEND_WEBHOOK_DEV_MODE", "").strip().lower() in ("1", "true", "yes", "on")

    if not secret:
        if dev_mode:
            print("[SECURITY WARNING] RESEND_WEBHOOK_SECRET missing — dev mode enabled, signature verification SKIPPED")
            return True, "", 200
        return False, "RESEND_WEBHOOK_SECRET not configured", 503

    # 缺任一 Svix header → 400
    if not svix_id or not svix_timestamp or not svix_signature:
        return False, "missing svix headers", 400

    tolerance = int(os.getenv("RESEND_WEBHOOK_TOLERANCE_SECONDS", "300") or "300")
    if not _timestamp_in_window(svix_timestamp, tolerance):
        return False, "timestamp outside tolerance window", 400

    if not verify_signature(secret, svix_id, svix_timestamp, payload, svix_signature):
        return False, "invalid signature", 400
    return True, "", 200


# ── 绑定解析（app 级语义；保留供单元测试，生产走 _account_for_to）──
def load_dynamic_bindings() -> dict:
    """加载 dc_email_bindings.json（P0-E1 唯一动态绑定源）。"""
    path = os.path.join(os.path.dirname(__file__), "dc_email_bindings.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def resolve_binding(to_email: str):
    """解析代理邮箱 → owner。返回 (binding_dict, conflict_dict)。

    只有「同一 app_id 下 open_id 不一致」才算 binding_conflict。
    不同 app_id（或 app 未知）下的 open_id 不做同命名空间冲突判定，仅标 cross_app。
    """
    key = (to_email or "").strip().lower()
    dyn = load_dynamic_bindings().get(key) or {}
    proxy = PROXY_MAP.get(key) or {}
    dyn_open = dyn.get("open_id", "")
    proxy_open = proxy.get("open_id", "")
    if dyn and proxy and dyn_open and proxy_open and dyn_open != proxy_open:
        dyn_app = dyn.get("app_id", "")
        proxy_app = proxy.get("app_id", "") or HANDLER_APP_ID
        if dyn_app and proxy_app and dyn_app == proxy_app:
            return None, {"binding_conflict": True, "same_app": True, "dynamic": dyn, "legacy_proxy_map": proxy}
        return None, {"binding_conflict": False, "cross_app": True,
                      "dynamic_app": dyn_app, "proxy_app": proxy_app,
                      "dynamic": dyn, "legacy_proxy_map": proxy}
    if dyn:
        return dyn, None
    if proxy:
        return proxy, None
    return None, None


# ── 数据提取 ──────────────────────────────────────────────
def extract_resend_id(data: dict) -> str:
    if not isinstance(data, dict):
        return ""
    return data.get("email_id") or data.get("id") or ""


def _parse_email_headers(headers, full: dict = None) -> tuple[str, str, list[str]]:
    """从 Receiving API 返回的 headers 数组解析 Message-ID / In-Reply-To / References。"""
    full = full or {}
    message_id = full.get("message_id") or ""
    in_reply_to = full.get("in_reply_to") or ""
    references = full.get("references") or []
    for h in headers or []:
        if not isinstance(h, dict):
            continue
        name = (h.get("name") or h.get("key") or "").lower()
        value = h.get("value", "")
        if name == "message-id" and not message_id:
            message_id = value
        elif name == "in-reply-to" and not in_reply_to:
            in_reply_to = value
        elif name == "references":
            references = re.findall(r"<[^>]+>", value)
    if isinstance(references, str):
        references = re.findall(r"<[^>]+>", references) or [references]
    return message_id, in_reply_to, [r for r in references if r]


def _record_delivery_signal(signal_type, resend_id, outbound, detail="", buyer_email=""):
    """把 delivered/bounced 事实写入七信号（best-effort，失败不阻断）。"""
    try:
        from .dc_email_signals import record_delivery_signal
        record_delivery_signal(
            signal_type, resend_id, resend_id,
            company_id=outbound.get("company_id", ""),
            campaign_id=outbound.get("campaign_id", ""),
            lead_id=outbound.get("lead_id", ""),
            contact_id=outbound.get("contact_id", ""),
            thread_id=outbound.get("thread_id", ""),
            detail=detail, buyer_email=buyer_email)
    except Exception:
        pass


def _outbound_recipients(outbound: dict) -> list[str]:
    return [r for r in (outbound.get("recipients") or []) if r]


def fetch_received_email(email_id: str, *, api_key: str = None, opener=None):
    """Resend Receiving API：GET /emails/receiving/{email_id} 返回完整邮件（含 headers）。"""
    api_key = api_key or os.getenv("RESEND_API_KEY", "")
    if not api_key:
        raise RuntimeError("RESEND_API_KEY not set")
    if not email_id:
        raise RuntimeError("missing email_id")
    opener = opener or urlopen
    req = Request(
        f"https://api.resend.com/emails/receiving/{email_id}",
        headers={"Authorization": f"Bearer {api_key}", "User-Agent": "DealClaw/1.0"},
    )
    with opener(req, timeout=15) as resp:
        return json.loads(resp.read())


# ── 状态事件处理 ───────────────────────────────────────────
def handle_status_event(event_type: str, data: dict) -> dict:
    status = STATUS_EVENT_TYPES[event_type]
    resend_id = extract_resend_id(data)
    result = {"status": status, "resend_id": resend_id, "matched": False}

    if not resend_id:
        return {**result, "error": "missing resend_id", "handled": False}

    store = get_store()
    outbound = store.find_outbound_by_resend_id(resend_id)
    if outbound is None:
        return {**result, "error": "no matching outbound", "handled": False}

    result["matched"] = True
    result["company_id"] = outbound.get("company_id", "")
    result["campaign_id"] = outbound.get("campaign_id", "")
    result["lead_id"] = outbound.get("lead_id", "")
    result["contact_id"] = outbound.get("contact_id", "")

    recipients = _outbound_recipients(outbound)
    buyer_email = recipients[0] if recipients else ""
    buyer_domain = buyer_email.split("@")[-1].lower() if "@" in buyer_email else ""

    failure_reason = ""
    bounce_category = ""
    if status == "bounced":
        bounce = data.get("bounce") or {}
        if isinstance(bounce, dict) and bounce:
            cls = classify_bounce(bounce)
            bounce_category = cls["category"]
            btype = (bounce.get("type") or "").strip()
            bsub = (bounce.get("subType") or "").strip()
            bmsg = (bounce.get("message") or "").strip()
            parts = [p for p in (btype, bsub, bmsg) if p]
            failure_reason = (f"[{bounce_category}] " + " | ".join(parts)) if parts else f"[{bounce_category}] bounced"
        else:
            failure_reason = "bounced"
            bounce_category = "unknown"
    elif status == "failed":
        failure_reason = (data.get("error") or data.get("reason") or "provider failure")
    failure_reason = (failure_reason or "")[:500]

    changed = store.update_provider_status(resend_id, status, failure_reason)
    result["changed"] = changed

    if status == "delivered":
        # 回填真实 Message-ID（SES/SMTP 分配，买家 In-Reply-To 引用它，不是本地 make_msgid）
        smtp_mid = (data.get("message_id") or "").strip()
        if smtp_mid:
            try:
                store.backfill_smtp_message_id(resend_id, smtp_mid)
            except Exception:
                pass
        if changed:
            _record_delivery_signal("delivered", resend_id, outbound)
        # 不 Push

    elif status == "bounced":
        if changed:
            _record_delivery_signal("bounced", resend_id, outbound, failure_reason,
                                   buyer_email=buyer_email)
        # 硬退才标无效邮箱；软退/内容拒收可重发，不标无效
        result["bounce_category"] = bounce_category
        result["retryable"] = bounce_category in ("soft", "content")
        result["contact_invalid"] = bounce_category == "hard"

    elif status == "complained":
        # 投诉/退订由 EmailStore.provider_status="complained" 记录，不再写旧 send_log。
        result["suppressed"] = True

    elif status == "failed":
        result["retryable"] = _is_retryable(failure_reason)

    result["handled"] = True
    return result


def classify_bounce(bounce: dict) -> dict:
    """退信分类。返回 {category, retryable}。

    category:
      hard    —— 永久性（邮箱不存在/域名无效/永久拒绝），不重发，标无效邮箱
      soft    —— 临时性（邮箱满/服务器临时故障/灰名单），可稍后重发
      content —— 内容触发（反垃圾拦截），改内容后可重发
      unknown —— 无类型信息，默认不重发、需人工判断
    """
    btype = (bounce.get("type") or "").strip().lower()
    bsub = (bounce.get("subType") or "").strip().lower()
    msg = (bounce.get("message") or "").lower()
    diag = " ".join(bounce.get("diagnosticCode") or []).lower()
    blob = f"{msg} {diag}"

    # 内容拒收（ContentRejected / spam 关键词）→ 改内容可重发
    if "contentrejected" in bsub or "content rejected" in blob or "spam" in blob:
        return {"category": "content", "retryable": True}
    # Resend 明确 Transient → 软退
    if btype == "transient":
        return {"category": "soft", "retryable": True}
    # Resend 明确 Permanent → 硬退
    if btype == "permanent":
        return {"category": "hard", "retryable": False}
    # 无 type 时按关键词兜底
    if any(k in blob for k in ("full", "quota", "temporar", "try again", "later", "expired", "greylist")):
        return {"category": "soft", "retryable": True}
    if any(k in blob for k in ("not exist", "does not exist", "invalid", "unavailable", "access denied", "remove")):
        return {"category": "hard", "retryable": False}
    return {"category": "unknown", "retryable": False}


def _is_retryable(reason: str) -> bool:
    r = (reason or "").lower()
    permanent = ("permanent", "suppressed", "invalid", "not found", "does not exist", "blocked")
    return not any(p in r for p in permanent)


# ── 入站回复处理 ───────────────────────────────────────────
def handle_inbound_event(data: dict, fetch=None) -> dict:
    fetch = fetch or fetch_received_email
    email_id = data.get("email_id") or data.get("id") or ""
    from_email = data.get("from", "")
    to_raw = data.get("to", "")
    to_email = to_raw[0] if isinstance(to_raw, list) and to_raw else to_raw
    subject = data.get("subject", "")
    result = {"from": from_email, "to": to_email, "subject": subject, "matched": False}

    # 1) 调 Receiving API 拉完整邮件 + headers（不得假设 webhook payload 含完整头）
    try:
        full = fetch(email_id)
    except Exception as e:
        return {**result, "status": "retryable", "failure_reason": "receiving_api_failed",
                "error": str(e)[:200], "matched": False}

    message_id, in_reply_to, references = _parse_email_headers(full.get("headers") or [], full)
    text = full.get("text") or data.get("text") or ""
    from_email = full.get("from") or from_email
    to_raw = full.get("to") or data.get("to") or to_raw
    to_email = to_raw[0] if isinstance(to_raw, list) and to_raw else to_raw
    subject = full.get("subject") or subject

    result.update({"message_id": message_id, "in_reply_to": in_reply_to})

    store = get_store()
    account = _account_for_to(to_email)
    if account is None:
        return {**result, "status": "unmatched", "failure_reason": "no_matching_outbound"}
    account_id = account["account_id"]

    reference_candidates = [m for m in [in_reply_to, *references] if m]
    outbound = store.find_outbound_by_reference(account_id, reference_candidates)
    if outbound is None and message_id:
        outbound = store.find_outbound_by_reference(account_id, [message_id])
    if outbound is None:
        fb = _fallback_match_by_contact(store, account_id, from_email, to_email)
        if fb.get("status") == "matched":
            outbound = fb["outbound"]
            result["binding_method"] = fb.get("binding_method", "")
            result["binding_confidence"] = fb.get("binding_confidence", "")
        elif fb.get("status") == "ambiguous":
            # company 级降级：候选 outbound 都属同一企业时，按企业绑定产生回复信号
            # （漏斗/早晚报只需企业级事实）；lead 级精确归属仍 need_user，留给人工。
            cands = fb.get("candidate_outbound_ids", [])
            cids = set()
            latest = None
            for cid_rid in cands:
                o = store.find_outbound_by_resend_id(cid_rid)
                if o:
                    cids.add(o.get("company_id", ""))
                    if latest is None or (o.get("sent_at") or "") > (latest.get("sent_at") or ""):
                        latest = o
            if len(cids) == 1 and next(iter(cids)) and latest is not None:
                outbound = latest
                result["binding_method"] = "company_fallback"
                result["binding_confidence"] = "low"
                result["need_user"] = True
                result["candidate_outbound_ids"] = cands
            else:
                return {**result, "status": "unmatched", "failure_reason": "ambiguous_contact_match",
                        "binding_status": "ambiguous", "auto_fixed": False, "need_user": True,
                        "candidate_outbound_ids": cands}

    if outbound is None:
        return {**result, "status": "unmatched", "failure_reason": "no_matching_outbound"}

    # 落库：把入站邮件本体写进事实层（字段与 imap_sync.py 的 inbound 记录对齐）。
    # 修复点：此前 handle_inbound_event 只做「信号 / 通知 / 草稿」，不写事实层 →
    # Resend 邮箱的回复进不了 EmailStore：早晚报「实际回复」数不到、买家案卷查不到原文。
    # 幂等：store 按 message_id 取键（同 message_id 只落一份）；失败 best-effort，不影响信号与通知。
    try:
        from email_gateway.store import utc_now
        store.insert_message({
            "account_id": account_id,
            "direction": "inbound",
            "message_id": message_id,
            "resend_received_id": email_id,
            "in_reply_to": in_reply_to,
            "references": reference_candidates,
            "sender": from_email,
            "recipients": [to_email] if to_email else [],
            "subject": subject,
            "text_preview": (text or "")[:1200],
            "received_at": utc_now(),
            "created_at": utc_now(),
            "related": True,
            "company_id": outbound.get("company_id", "") or account.get("enterprise_id", ""),
            "campaign_id": outbound.get("campaign_id", ""),
            "lead_id": outbound.get("lead_id", ""),
            "contact_id": outbound.get("contact_id", ""),
            "thread_id": outbound.get("thread_id") or outbound.get("local_message_id", ""),
        })
    except Exception:
        pass

    # 生成七信号 + 自动触发 Push 决策（shadow/live）；best-effort
    try:
        from .dc_email_signals import analyze_reply, process_reply
        from .dc_signal_push import evaluate_for_push
        from enterprise_ids import canonical_company_id
        _company = canonical_company_id(outbound.get("company_id", "") or account.get("enterprise_id", ""))
        _a = analyze_reply(text, buyer_domain=from_email.split("@")[-1].lower() if "@" in from_email else from_email,
                           enterprise=_company)
        _res = process_reply(
            reply_text=text, message_id=message_id,
            thread_id=outbound.get("thread_id") or outbound.get("local_message_id", ""),
            company_id=_company, campaign_id=outbound.get("campaign_id", ""),
            lead_id=outbound.get("lead_id", ""), contact_id=outbound.get("contact_id", ""),
            iq_intent=_a["intent"], requested_materials=_a["requested_materials"],
            missing_fields=_a["missing_fields"], confidence=_a["confidence"])
        _ev = evaluate_for_push([s["signal_id"] for s in _res.get("signals", [])])
        # P0-E4：机会 candidate 生成后自动生成回复草稿（幂等，不发送）
        try:
            from .dc_reply_draft import generate_draft, record_draft
            for cand in _ev.get("candidates", []):
                if cand.get("category") != "opportunity":
                    continue
                d = generate_draft(
                    company_id=_company,
                    campaign_id=outbound.get("campaign_id", ""),
                    lead_id=outbound.get("lead_id", ""),
                    contact_id=outbound.get("contact_id", ""),
                    account_id=account_id,
                    related_reply_id=message_id,
                    reply_text=text,
                    buyer=from_email.split("@")[0] if "@" in from_email else from_email,
                    buyer_email=from_email,
                    subject=(f"Re: {outbound.get('subject', '')}" if outbound.get("subject") else "Re: your inquiry"),
                    missing_fields=_a.get("missing_fields", []),
                    touch_number=outbound.get("touch_number", 0),
                )
                record_draft(d)
        except Exception:
            pass
    except Exception:
        pass

    return {
        **result,
        "status": "bound",
        "matched": True,
        "company_id": outbound.get("company_id", ""),
        "campaign_id": outbound.get("campaign_id", ""),
        "lead_id": outbound.get("lead_id", ""),
        "contact_id": outbound.get("contact_id", ""),
        "thread_id": outbound.get("thread_id") or outbound.get("local_message_id", ""),
    }


def _account_for_to(to_email: str):
    store = get_store()
    to_email = (to_email or "").strip().lower()
    for acct in store.list_accounts(enabled_only=True):
        if (acct.get("email_address") or "").lower() == to_email:
            return acct
    return None


def _fallback_match_by_contact(store, account_id: str, from_email: str, to_email: str) -> dict:
    """contact fallback 匹配（P0-E4 歧义保护）。返回 {status, outbound?, ...}。

    - 唯一匹配一个 outbound → 自动绑定。
    - 多个匹配 → 只保留「未完成」（无回复信号）的 outbound；仍多个 → ambiguous，不猜测。
    """
    if not from_email or "@" not in from_email:
        return {"status": "no_match"}
    matches = store.find_outbounds_by_contact(account_id, from_email)
    if not matches:
        return {"status": "no_match"}
    if len(matches) == 1:
        return {"status": "matched", "outbound": matches[0],
                "binding_method": "contact_fallback", "binding_confidence": "medium",
                "candidate_outbound_ids": [matches[0].get("resend_id", "")]}
    # 多个相同联系人 outbound：只保留未完成（无 bound reply）的
    try:
        from .dc_email_signals import replied_thread_ids
        replied = replied_thread_ids()
        incomplete = [m for m in matches if (m.get("local_message_id") or "") not in replied]
    except Exception:
        incomplete = matches
    if len(incomplete) == 1:
        return {"status": "matched", "outbound": incomplete[0],
                "binding_method": "contact_fallback", "binding_confidence": "medium",
                "candidate_outbound_ids": [m.get("resend_id", "") for m in matches]}
    return {"status": "ambiguous", "binding_status": "ambiguous", "auto_fixed": False,
            "need_user": True,
            "candidate_outbound_ids": [m.get("resend_id", "") for m in matches]}
