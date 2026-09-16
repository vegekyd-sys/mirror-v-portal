"""入站取信管子：Resend 收信 → 归属匹配 → 通知到用户对话。

用途：把"取回来的管子"接上——托管邮箱（resend 代理）收到的回信，按 In-Reply-To 匹配
到原 outbound，归属成功的回信通过统一投递层（应用机器人，可私聊）通知到用户对话。

投递目标口径（2026-09-15 起）：**默认回发信的那个会话**——outbound 事实上的
``origin_notify_target``（发信时的 ``--receipt-target``，群 ``oc_`` / 私聊 ``ou_``）优先，
旧记录缺该字段时自动回退 account 级人工绑定（见 :func:`resolve_notify_binding`）。

安全设计（宁可漏跑一轮，也不丢信/不扰民）：
  1. **先建游标，不回填历史**：``baseline=True`` 只记录当前最新 id 作为高水位，不 ingest
     任何历史邮件——避免把既有大量真实回信一次性灌进本环境。
  2. **只取"新到"**：以游标高水位为界，处理游标之后的邮件；已处理 id 去重。
  3. **只通知归属成功的**：``matched`` 才通知；未归属进入可观测记录，不打扰用户。
  4. **异常不推进游标**：任何一条处理失败都保持游标不动，下一轮重试，不产生"静默丢信"。
  5. **通知通道走统一投递层**：与去群机器人改造一致（应用机器人优先，失败回退 webhook）。

不在本模块职责内：取信链路的底层实现（``dc_resend_source``）、正文解析与归属算法
（``dc_email_ingest`` / ``dc_webhook_handler``）——本模块只做编排与投递。
"""

from __future__ import annotations

from typing import Any, Callable

STATUS_OK = "ok"
STATUS_RETRYABLE = "retryable"


def _default_deps() -> dict:
    """默认依赖（懒加载，避免导入环与测试污染）。"""
    from dc_email_controller import dc_resend_source as rs  # noqa: PLC0415
    from dc_email_controller.dc_email_ingest import ingest_resend_event  # noqa: PLC0415
    from email_gateway.notify_delivery import deliver  # noqa: PLC0415

    return {
        "list_received": rs.list_received,
        "load_cursor": rs.load_cursor,
        "save_cursor": rs.save_cursor,
        "to_ingest_event": rs.to_ingest_event,
        "ingest": ingest_resend_event,
        "deliver": deliver,
    }


def resolve_notify_binding(*, origin_notify_target: str = "", account_id: str = "",
                           address: str = "", store) -> dict:
    """解析回信通知的投递目标。**优先级：发信会话 > account 级绑定。**

    为什么改：旧实现只认 ``account + chat_id`` 的人工绑定，回信永远投不到
    “发那封信的那个会话”。现在发信时把会话记在 outbound 事实的
    ``origin_notify_target`` 上，这里优先用它；旧记录缺字段或目标非法时自动回退
    account 绑定，行为与改造前一致（向后兼容，不报错）。

    **发信会话形态不再限定飞书**：飞书 ``oc_/ou_`` 与微信 ``<…>@im.wechat`` 都是合法
    发信会话（2026-09-15 接微信通道），判断统一走 ``notify_delivery.im_channel_for``。

    返回可直接交给 ``notify_delivery.deliver`` 的绑定形状（多一个 ``source``）：
    ``origin`` = 发信会话；``binding`` = account 级回退；无目标 → ``{}``。
    """
    from email_gateway.notify_delivery import im_channel_for  # noqa: PLC0415
    target = str(origin_notify_target or "").strip()
    if im_channel_for(target):
        return {"account_id": account_id, "chat_id": target, "notify_enabled": 1,
                "inbound_filter": "dealclaw_replies", "source": "origin"}
    binding = _binding_for_address(address, store=store) if address else {}
    if not binding and account_id:
        try:
            binds = [b for b in (store.list_bindings() or [])
                     if b.get("account_id") == account_id and b.get("notify_enabled")]
        except Exception:  # noqa: BLE001
            binds = []
        binding = binds[0] if binds else {}
    if binding:
        out = dict(binding)
        out["source"] = "binding"
        return out
    return {}


def _binding_for_address(address: str, *, store) -> dict:
    """按收件地址找到启用通知的绑定（返回 ``{}`` 表示没有可用绑定）。

    遗留语义：account 级人工绑定，2026-09-15 起只作**回退**通道，
    优先取发信会话（见 :func:`resolve_notify_binding`）。
    """
    addr = str(address or "").strip().lower()
    if not addr:
        return {}
    try:
        accounts = store.list_accounts()
    except Exception:  # noqa: BLE001
        return {}
    account_id = ""
    for acc in accounts or []:
        for key in ("email", "address", "from_address", "email_address"):
            if str(acc.get(key, "")).strip().lower() == addr:
                account_id = acc.get("account_id") or ""
                break
        if account_id:
            break
    if not account_id:
        return {}
    try:
        bindings = [b for b in (store.list_bindings() or [])
                    if b.get("account_id") == account_id and b.get("notify_enabled")]
    except Exception:  # noqa: BLE001
        return {}
    return bindings[0] if bindings else {}


def _recipient(event: dict) -> str:
    data = event.get("payload") or {}
    to = data.get("to") or []
    if isinstance(to, str):
        to = [to]
    return str(to[0]) if to else ""


_OOO_PATTERNS = (
    "out of office", "out-of-office", "ooo", "automatic reply", "auto reply", "autoreply",
    "automatic response", "away from my desk", "on vacation", "annual leave", "maternity leave",
    "自动回复", "自动答复", "休假", "外出", "不在办公室", "离职",
)


def _substantive(item: dict, event: dict, ingest_result: dict | None = None) -> tuple[bool, str]:
    """是否“实质回复”：决定要不要唤醒人/agent。

    不是每封回信都值得叫人：**自动回复/休假回复/退信**等应静默处理（不唤醒、不打扰），
    否则每条 OOO 都会消耗一次模型调用并骚扰用户。
    返回 ``(substantive, reason)``。
    """
    data = event.get("payload") or {}
    res = ingest_result or {}
    subject = str(data.get("subject") or item.get("subject") or "").lower()
    body = ""
    for key in ("text_preview", "preview", "excerpt", "snippet"):
        val = res.get(key) or data.get(key)
        if val:
            body = str(val).lower()
            break
    hay = subject + "\n" + body
    for pat in _OOO_PATTERNS:
        if pat in hay:
            return False, f"auto_reply:{pat}"
    kind = str(res.get("signal_type") or "").lower()
    if kind in ("bounced", "failed"):
        return False, f"delivery:{kind}"
    signals = res.get("signals") or []
    if signals:
        return True, "signals"
    # 无信号：正文有实质长度也算（可能是人工写的、分类器没覆盖的写法）
    if len(body.strip()) >= 40:
        return True, "body"
    # **保守取态**：拿不到正文/判不准时一律唤醒。
    # 宁可多叫一次人，也不能把真实买家回复静默丢掉（漏信的代价远大于一次模型调用）。
    return True, "unknown_content"


def _resolve_reply_source(res: dict, data: dict) -> str:
    """解析回信对应的来源（闸门判据）。取不到就返回空串 → 需确认。"""
    for key in ("source", "来源", "来源渠道"):
        for holder in (res, data):
            val = holder.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return ""


def _reply_brief(item: dict, event: dict, ingest_result: dict | None = None,
                 attribution: dict | None = None, *, source_channel: str = "",
                 stage: str = "", in_exhibition: bool | None = None,
                 materials_ready: bool = False) -> dict:
    """给 agent 消费的新回信事实包（不含任何"发给谁"的投递决策）。

    设计意图：邮件直接交给 V（项目 agent）读取，由 V 自己出解读与下一步，
    因此这里只提供**原始事实**（发件人/主题/到达时间/正文摘录/已识别信号），
    不做二次加工，避免模板话术盖住模型判断。

    例外：``reply_policy`` 是**执行闸门结论**（能不能免确认自动回），不是话术模板。
    它来自 ``dc_exhibition_policy.decide_reply`` 这个单一判定源；来源/阶段未知时
    一律回落 ``confirm``，与人工确认铁律一致。
    """
    data = event.get("payload") or {}
    res = ingest_result or {}

    try:
        from dc_exhibition_policy import decide_reply  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        decide_reply = None
    # 来源：显式传入优先，否则从 ingest 结果 / 事件载荷自动解析（取不到 → 需确认）
    if not source_channel:
        source_channel = _resolve_reply_source(res, data)
    # 阶段：没显式给就走展会模式自动判定（展会期内按「展中」）
    if not stage and in_exhibition is None:
        try:
            from dc_exhibition_mode import in_exhibition_mode  # noqa: PLC0415
            in_exhibition = in_exhibition_mode()
        except Exception:  # noqa: BLE001
            in_exhibition = None
    if decide_reply is not None:
        try:
            reply_policy = decide_reply(
                source_channel, stage=stage, in_exhibition=in_exhibition,
                materials_ready=materials_ready,
            )
        except Exception:  # noqa: BLE001
            reply_policy = {"action": "confirm", "auto": False,
                            "reason": "闸门异常 → 按最保守处理", "source_channel": source_channel}
    else:
        reply_policy = {"action": "confirm", "auto": False,
                        "reason": "闸门不可用 → 按最保守处理", "source_channel": source_channel}

    excerpt = ""
    for key in ("text_preview", "preview", "excerpt", "snippet"):
        val = res.get(key) or data.get(key)
        if val:
            excerpt = str(val).strip()[:1200]
            break
    signals = []
    for s in (res.get("signals") or []):
        if isinstance(s, dict):
            signals.append({"type": s.get("signal_type"), "evidence": s.get("evidence")})
    substantive, why = _substantive(item, event, res)
    return {
        "received_id": str(item.get("id") or ""),
        "from": str(data.get("from") or item.get("from") or ""),
        "to": _recipient(event),
        "subject": str(data.get("subject") or item.get("subject") or ""),
        "received_at": str(item.get("created_at") or ""),
        "excerpt": excerpt,
        "signals": signals,
        "thread_matched": bool((attribution or {}).get("attributed", True)),
        "attribution": attribution or {},
        "substantive": substantive,
        "non_substantive_reason": "" if substantive else why,
        # 执行闸门：auto_reply 才允许免确认自动回；confirm 必须人工确认
        "reply_policy": reply_policy,
    }


def _notify_text(item: dict, event: dict, ingest_result: dict | None = None) -> str:
    """组装通知正文：**解读 + 下一步动作**（不再是干巴巴的“有新回信”）。"""
    from email_gateway.reply_brief import compose_brief  # noqa: PLC0415

    data = event.get("payload") or {}
    res = ingest_result or {}
    excerpt = ""
    for key in ("text_preview", "preview", "excerpt", "snippet"):
        val = res.get(key) or data.get(key)
        if val:
            excerpt = str(val).strip()[:300]
            break
    return compose_brief(
        sender=str(data.get("from") or item.get("from") or ""),
        subject=str(data.get("subject") or item.get("subject") or ""),
        received_at=str(item.get("created_at") or ""),
        signals=res.get("signals") or [],
        excerpt=excerpt,
    )


def poll_once(
    *,
    baseline: bool = False,
    dry_run: bool = False,
    limit: int = 50,
    max_pages: int = 2,
    notify: bool = False,
    collect: bool = True,
    deps: dict | None = None,
    store=None,
) -> dict:
    """跑一轮取信。**本函数不抛异常**，所有问题都记录在返回结构里。

    返回
    ----
    ``{"ok", "mode": "baseline"|"poll"|"dry_run", "baseline_id", "pulled", "considered",
       "ingested", "matched", "notified", "unmatched", "skipped", "errors": [...],
       "cursor_advanced", "advanced_to"}``
    """
    d = {**_default_deps(), **(deps or {})}
    out: dict[str, Any] = {
        "ok": True, "mode": "baseline" if baseline else ("dry_run" if dry_run else "poll"),
        "baseline_id": "", "pulled": 0, "considered": 0, "ingested": 0,
        "matched": 0, "notified": 0, "unmatched": 0, "skipped": 0,
        "errors": [], "cursor_advanced": False, "advanced_to": "", "replies": [],
        "unmatched_items": [], "notify_targets": [],
    }

    try:
        cursor = d["load_cursor"]()
    except Exception as exc:  # noqa: BLE001
        cursor = {}
        out["errors"].append(f"load_cursor: {type(exc).__name__}: {exc}")
    high_water = str(cursor.get("high_water_received_id") or "")
    processed = set(cursor.get("recent_processed_ids") or [])

    st, payload = d["list_received"](limit=limit)
    if st != 200:
        out["ok"] = False
        out["errors"].append(f"list_received status={st}")
        return out
    items = (payload or {}).get("data") or []
    out["pulled"] = len(items)
    if not items:
        return out

    newest_id = str(items[0].get("id") or "")
    newest_created = items[0].get("created_at")

    if baseline:
        out["baseline_id"] = newest_id
        if dry_run:
            return out
        try:
            d["save_cursor"](newest_id, newest_created, [])
            out["cursor_advanced"] = True
            out["advanced_to"] = newest_id
        except Exception as exc:  # noqa: BLE001
            out["ok"] = False
            out["errors"].append(f"save_cursor: {type(exc).__name__}: {exc}")
        return out

    stop_at = high_water
    new_ids: list[str] = []
    for item in items:
        rid = str(item.get("id") or "")
        if not rid:
            continue
        if stop_at and rid == stop_at:
            break
        if rid in processed:
            out["skipped"] += 1
            continue
        new_ids.append(rid)
    out["considered"] = len(new_ids)

    saw_error = False
    for item in items:
        rid = str(item.get("id") or "")
        if rid not in new_ids:
            continue
        event = d["to_ingest_event"](item)
        try:
            r = d["ingest"](event) or {}
        except Exception as exc:  # noqa: BLE001
            out["errors"].append(f"{rid}: ingest {type(exc).__name__}: {exc}")
            saw_error = True
            break
        if r.get("duplicate_fact") or r.get("in_progress"):
            out["skipped"] += 1
            new_ids = [x for x in new_ids if x != rid]
            continue
        if not r.get("ok"):
            out["errors"].append(f"{rid}: ingest not ok status={r.get('status') or r.get('error')}")
            saw_error = True
            break
        out["ingested"] += 1
        # 双口径归属：收件箱优先 + In-Reply-To 精修（不依赖头部也能对应到收件箱和人）
        try:
            from email_gateway.reply_attribution import attribute  # noqa: PLC0415

            attribution = attribute(
                recipients=(event.get("payload") or {}).get("to") or [],
                sender=str((event.get("payload") or {}).get("from") or ""),
                store=store or _open_store(),
            )
        except Exception as exc:  # noqa: BLE001
            attribution = {"attributed": False, "method": "none", "error": f"{type(exc).__name__}: {exc}"}
        if r.get("matched") or attribution.get("attributed"):
            out["matched"] += 1
            if collect:
                out["replies"].append(_reply_brief(item, event, r, attribution))
            if notify and not dry_run:
                # 投递目标：发信会话（outbound.origin_notify_target）优先，
                # 没有则回退 account 级绑定（旧行为，保留）。
                binding = resolve_notify_binding(
                    origin_notify_target=str(r.get("origin_notify_target")
                                             or (attribution.get("thread") or {}).get("origin_notify_target")
                                             or ""),
                    account_id=str((attribution or {}).get("account_id") or ""),
                    address=_recipient(event),
                    store=store or _open_store(),
                )
                if binding:
                    res = d["deliver"](binding, text=_notify_text(item, event, r))
                    if res.get("ok"):
                        out["notified"] += 1
                        out["notify_targets"].append({
                            "received_id": rid, "target": str(binding.get("chat_id") or ""),
                            "source": str(binding.get("source") or ""),
                            "channel": str(res.get("channel") or ""),
                        })
                    else:
                        out["errors"].append(f"{rid}: notify {res.get('error')}")
                else:
                    out["errors"].append(f"{rid}: notify skipped（既无发信会话，也无通知绑定）")
        else:
            out["unmatched"] += 1
            # 归属失败的也必须可见：本项目的典型故障模式是「拉到了、认不出、没人知道」。
            out["unmatched_items"].append({
                "received_id": rid,
                "from": str((event.get("payload") or {}).get("from") or ""),
                "subject": str((event.get("payload") or {}).get("subject") or ""),
                "reason": str(r.get("failure_reason") or r.get("status") or "unmatched"),
            })

    if not saw_error and not dry_run:
        advanced = newest_id or high_water
        try:
            d["save_cursor"](advanced, newest_created, sorted(processed | set(new_ids))[-200:])
            out["cursor_advanced"] = True
            out["advanced_to"] = advanced
        except Exception as exc:  # noqa: BLE001
            out["ok"] = False
            out["errors"].append(f"save_cursor: {type(exc).__name__}: {exc}")
    return out


def _open_store():
    from email_gateway.store import EmailStore  # noqa: PLC0415

    return EmailStore()


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    p = argparse.ArgumentParser(description="Resend 取信管子：拉取 → 归属 → 通知")
    p.add_argument("--baseline", action="store_true", help="只建游标高水位，不 ingest 历史邮件")
    p.add_argument("--dry-run", action="store_true", help="只探测，不写游标、不发通知")
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--max-pages", type=int, default=2)
    p.add_argument("--no-notify", action="store_true", help="只 ingest，不发通知（默认即不通知）")
    p.add_argument("--collect", action="store_true", default=True,
                   help="把新回信作为事实包返回，供 agent 读取（默认开启）")
    a = p.parse_args(argv)
    r = poll_once(baseline=a.baseline, dry_run=a.dry_run, limit=a.limit,
                  max_pages=a.max_pages, notify=not a.no_notify, collect=a.collect)
    print(json.dumps(r, ensure_ascii=False))
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
