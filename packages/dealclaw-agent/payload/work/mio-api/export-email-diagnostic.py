#!/usr/bin/env python3
"""export-email-diagnostic.py — 租户侧**只读**邮件诊断：身份发现 + 脱敏导出。

两个子命令：

    discover   只读列出当前 workspace 的 tenant / company / account、各流量计数与
               最后事件时间。**先确认身份，再导出。**不写任何文件。
    export     生成可对账、但不泄密的脱敏诊断包（旧式纯 flag 调用仍可用，走 export）。

只读保证：不写存储、不改状态、不发邮件；只有 --out 指定的路径会被写入。

导出包明确不含：正文 / HTML / 主题 / 收件人 / 发件人 / 附件 / 账号邮箱 /
电话 / 联系人 / 密钥。所有消息 / 线程 / 买家 / 所有者 ID 走稳定假名。

自动守卫（export）：
  1. PII 扫描：邮箱、电话、敏感字段名。命中即失败（除非 --allow-pii-hits）。
  2. 完整性：SHA256（对不含 integrity 的规范化 JSON 计算）+ 字节数。
  3. 数据水位：各流量计数 + 最大事件时间 + facts_root。

用法：
    # 1) 发现身份（只读）
    python3 export-email-diagnostic.py discover --data-dir <DC_DATA_DIR> [--json]

    # 2) 确认 company-id 后导出
    python3 export-email-diagnostic.py export --data-dir <DC_DATA_DIR> \\
        --company-id <id> --out /tmp/dc-email-diagnostic-<id>.json \\
        [--since 2026-09-01 --until 2026-09-12] [--report-timezone Asia/Shanghai]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from email_metrics.adapter import load_legacy_from_dir  # noqa: E402
from email_metrics.facts import replay  # noqa: E402
from email_metrics.pseudonym import pseudonym  # noqa: E402
from email_metrics.reconcile import reconcile, render_markdown  # noqa: E402
from email_metrics.views import DEFAULT_REPORT_TZ, activity_view, metrics_view  # noqa: E402

DISCOVER_SCHEMA_VERSION = 1
EXPORT_SCHEMA_VERSION = 1

# 时间戳候选字段（按优先级取第一个非空）
_TS_FIELDS = ("occurred_at_utc", "occurred_at", "sent_at", "received_at",
              "delivered_at", "created_at", "updated_at", "timestamp")

# 出现在导出包里的字段名一律禁止（原始邮件/账号/密钥）
_FORBIDDEN_KEYS = {
    "text", "html", "subject", "sender", "recipients", "attachments",
    "secret", "secret_ref", "password", "token", "api_key",
    "email_address", "owner_open_id", "display_name", "chat_id",
    "webhook_url", "webhook_secret", "phone", "contact", "full_name",
}

# 电话只认「国际区号」或「带分隔符」的形态：避免把 company_id / 事件 id 这类
# 纯数字串误判为 PII（纯数字号码由 _FORBIDDEN_KEYS 的字段名守卫兜底）。
_PII_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PII_PHONE = re.compile(
    r"(?<![\w.])(?:\+\d[\d\-\s().]{6,18}\d|\d{3,4}[\-\s]\d{3,4}[\-\s]\d{3,4})(?![\w.])")


# ── 只读读取 ────────────────────────────────────────────

def _read_record(path: Path) -> dict | None:
    """快照格式：`# 头` + 一行 JSON。取第一个可解析的 JSON 对象行。"""
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


def _ts_of(rec: dict) -> str:
    for k in _TS_FIELDS:
        v = rec.get(k)
        if v:
            return str(v)
    return ""


def _iter_files(root: Path):
    if not root.exists():
        return []
    return sorted(p for p in root.rglob("*.md") if p.is_file())


def _scan_records(root: Path) -> tuple[int, str]:
    """文件数 + 最大事件时间（每个文件一条记录）。"""
    count, last = 0, ""
    for p in _iter_files(root):
        rec = _read_record(p)
        if rec is None:
            continue
        count += 1
        ts = _ts_of(rec)
        if ts > last:
            last = ts
    return count, last


def _scan_jsonl(root: Path) -> tuple[int, str]:
    """JSONL 事件数（一个文件多行）+ 最大事件时间。"""
    count, last = 0, ""
    for p in _iter_files(root):
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            recs = obj if isinstance(obj, list) else [obj]
            for rec in recs:
                if not isinstance(rec, dict):
                    continue
                count += 1
                ts = _ts_of(rec)
                if ts > last:
                    last = ts
    return count, last


def _facts_root(data_dir: str | Path) -> Path:
    root = Path(data_dir)
    nested = root / "email-facts"
    return nested if nested.exists() else root


# ── discover ────────────────────────────────────────────

def discover(data_dir: str) -> dict:
    """只读列出 tenant / company / account 与流量计数、最后事件时间。"""
    facts = _facts_root(data_dir)
    accounts: list[dict] = []
    by_account: dict[str, dict] = {}
    for p in _iter_files(facts / "accounts"):
        rec = _read_record(p)
        if not rec:
            continue
        aid = str(rec.get("account_id") or p.stem)
        tenant = str(rec.get("enterprise_id") or "")
        by_account[aid] = {
            "account_id": aid,
            "tenant": tenant,
            "provider": rec.get("provider", ""),
            "mailbox_kind": rec.get("mailbox_kind", ""),
            "enabled": rec.get("enabled", ""),
            "daily_send_limit": rec.get("daily_send_limit", ""),
            # 只出稳定假名，不出真实 open_id / 邮箱 / 姓名
            "owner_key": pseudonym("owner", str(rec.get("owner_open_id") or "")),
        }
        accounts.append(by_account[aid])

    # 账号 → 绑定群数量
    bindings: dict[str, int] = {}
    for p in _iter_files(facts / "bindings"):
        rec = _read_record(p)
        if not rec:
            continue
        aid = str(rec.get("account_id") or "")
        if aid:
            bindings[aid] = bindings.get(aid, 0) + 1
    for aid, acc in by_account.items():
        acc["bound_chats"] = bindings.get(aid, 0)

    companies: dict[str, dict] = {}

    def _company(cid: str) -> dict:
        return companies.setdefault(cid, {
            "company_id": cid, "tenants": [], "accounts": [],
            "outbound": 0, "inbound": 0, "last_event_at_utc": "",
        })

    for stream, counter in (("outbound", "outbound"), ("inbound", "inbound")):
        for p in _iter_files(facts / stream):
            rec = _read_record(p)
            if not rec:
                continue
            cid = str(rec.get("company_id") or "")
            if not cid:  # 目录名兜底：<stream>/<company_id>/<YYYY-MM>/<hash>.md
                try:
                    cid = p.relative_to(facts / stream).parts[0]
                except (ValueError, IndexError):
                    cid = ""
            if not cid:
                continue
            c = _company(cid)
            c[counter] += 1
            ts = _ts_of(rec)
            if ts > c["last_event_at_utc"]:
                c["last_event_at_utc"] = ts
            aid = str(rec.get("account_id") or "")
            if aid and aid not in c["accounts"]:
                c["accounts"].append(aid)
            tenant = by_account.get(aid, {}).get("tenant", "")
            if tenant and tenant not in c["tenants"]:
                c["tenants"].append(tenant)

    streams: dict[str, dict] = {}
    for name, mode in (("outbound", "record"), ("inbound", "record"),
                       ("delivery-events", "jsonl"), ("reply-events", "jsonl"),
                       ("webhook-events", "jsonl"), ("canonical-facts", "record"),
                       ("sync-state", "record")):
        root = facts / name
        n, last = _scan_jsonl(root) if mode == "jsonl" else _scan_records(root)
        streams[name] = {"count": n, "last_event_at_utc": last, "present": root.exists()}

    out = {
        "discover_schema_version": DISCOVER_SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data_dir": str(data_dir),
        "facts_root": str(facts),
        "mode": "read_only",
        "pseudonymized": True,
        "tenants": sorted({a["tenant"] for a in accounts if a["tenant"]}),
        "accounts": sorted(accounts, key=lambda a: a["account_id"]),
        "companies": sorted(companies.values(), key=lambda c: c["company_id"]),
        "streams": streams,
        "totals": {
            "accounts": len(accounts),
            "bindings": sum(bindings.values()),
            "companies": len(companies),
            "outbound": sum(c["outbound"] for c in companies.values()),
            "inbound": sum(c["inbound"] for c in companies.values()),
        },
    }
    return out


def render_discover(d: dict) -> str:
    """人读版摘要（不含任何 PII）。"""
    lines = [f"data_dir: {d['data_dir']}",
             f"facts_root: {d['facts_root']}  (只读)",
             f"tenants: {', '.join(d['tenants']) or '(none)'}"]
    lines.append(f"accounts: {d['totals']['accounts']} · bindings: {d['totals']['bindings']}"
                 f" · companies: {d['totals']['companies']}")
    lines.append("")
    lines.append("companies:")
    if not d["companies"]:
        lines.append("  (none)")
    for c in d["companies"]:
        lines.append(
            f"  - {c['company_id']}  tenant={','.join(c['tenants']) or '?'}"
            f"  outbound={c['outbound']} inbound={c['inbound']}"
            f"  last={c['last_event_at_utc'] or '-'}")
    lines.append("")
    lines.append("accounts:")
    for a in d["accounts"]:
        lines.append(
            f"  - {a['account_id']}  tenant={a['tenant'] or '?'}"
            f"  {a['provider'] or '-'}/{a['mailbox_kind'] or '-'}"
            f"  enabled={a['enabled']}  owner={a['owner_key']}"
            f"  bound_chats={a['bound_chats']}")
    lines.append("")
    lines.append("streams:")
    for name, s in d["streams"].items():
        flag = "" if s["present"] else "  (absent)"
        lines.append(f"  - {name}: {s['count']}  last={s['last_event_at_utc'] or '-'}{flag}")
    return "\n".join(lines)


# ── PII / 完整性 / 水位 ─────────────────────────────────

def pii_scan(obj, path: str = "$") -> list[dict]:
    """结构化扫描：敏感字段名 + 邮箱 + 电话。返回命中清单。"""
    hits: list[dict] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            kp = f"{path}.{k}"
            if str(k) in _FORBIDDEN_KEYS:
                hits.append({"path": kp, "kind": "forbidden_key", "sample": ""})
            hits.extend(pii_scan(v, kp))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            hits.extend(pii_scan(v, f"{path}[{i}]"))
    elif isinstance(obj, str):
        for kind, rx in (("email", _PII_EMAIL), ("phone", _PII_PHONE)):
            m = rx.search(obj)
            if m:
                raw = m.group(0)
                hits.append({"path": path, "kind": kind,
                             "sample": raw[:3] + "***" if len(raw) > 3 else "***"})
    return hits


def _sha256(payload: dict) -> tuple[str, int]:
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest(), len(blob)


def build_watermark(data_dir: str, company_id: str | None, streams: dict) -> dict:
    last = ""
    for s in streams.values():
        ts = s.get("last_event_at_utc") or ""
        if ts > last:
            last = ts
    return {
        "facts_root": str(_facts_root(data_dir)),
        "company_id": company_id or "",
        "streams": {k: v["count"] for k, v in streams.items()},
        "max_event_at_utc": last or "",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


# ── export ──────────────────────────────────────────────

def build_export(data_dir: str, company_id: str | None = None,
                 since: str | None = None, until: str | None = None,
                 report_timezone: str = DEFAULT_REPORT_TZ,
                 include_markdown: bool = True) -> dict:
    facts_root = _facts_root(data_dir)

    adapted = load_legacy_from_dir(facts_root)
    result = replay(adapted["events"], watermark_utc=None)
    date_range = (since, until) if (since or until) else None

    metrics = metrics_view(result, company_id=company_id, date_range=date_range,
                           report_timezone=report_timezone,
                           legacy_unverified=adapted["stats"]["legacy_unverified"])
    activity = activity_view(result, company_id=company_id, date_range=date_range,
                             report_timezone=report_timezone,
                             legacy_unverified=adapted["stats"]["legacy_unverified"])
    report = reconcile(result, company_id=company_id, date_range=date_range,
                       report_timezone=report_timezone,
                       legacy_unverified=adapted["stats"]["legacy_unverified"])

    disc = discover(data_dir)
    out = {
        "export_schema_version": EXPORT_SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "facts_root": str(facts_root),
            "mode": "read_only",
            "pseudonymized": True,
            "excluded_fields": ["text", "html", "subject", "sender", "recipients",
                                "attachments", "accounts", "config", "secrets"],
        },
        "company_id": company_id or "",
        "report_timezone": report_timezone,
        "adapted_stats": adapted["stats"],
        "metrics": metrics,
        "activity": activity,
        "reconcile": report,
        "watermark": build_watermark(data_dir, company_id, disc["streams"]),
    }
    if include_markdown:
        out["reconcile_markdown"] = render_markdown(report)
    return out


def finalize_export(payload: dict, allow_pii: bool = False) -> dict:
    """PII 守卫 + SHA256 + 水位，返回可落盘的 payload（不改入参）。"""
    hits = pii_scan(payload)
    status = "fail" if hits else "pass"
    payload = dict(payload)
    if status == "fail" and not allow_pii:
        raise SystemExit(
            f"❌ PII 检查未通过（{len(hits)} 处命中），已中止导出：\n"
            + "\n".join(f"  - {h['path']} {h['kind']} {h['sample']}" for h in hits[:10]))
    payload["pii_check"] = {"status": status, "hits": hits,
                            "scanned": ["forbidden_key", "email", "phone"]}
    sha, size = _sha256({k: v for k, v in payload.items() if k != "integrity"})
    payload["integrity"] = {"sha256": sha, "canonical_bytes": size,
                            "algorithm": "sha256(canonical-json)"}
    return payload


# ── CLI ─────────────────────────────────────────────────

def cmd_discover(args) -> int:
    d = discover(args.data_dir)
    if args.json:
        print(json.dumps(d, ensure_ascii=False, indent=2))
    else:
        print(render_discover(d))
        print("\n确认某个 company_id 后执行：")
        print(f"  python3 export-email-diagnostic.py export --data-dir {args.data_dir} "
              f"--company-id <id> --out /tmp/dc-email-diagnostic-<id>.json")
    return 0


def cmd_export(args) -> int:
    payload = build_export(args.data_dir, company_id=args.company_id,
                           since=args.since, until=args.until,
                           report_timezone=args.report_timezone,
                           include_markdown=not args.no_markdown)
    payload = finalize_export(payload, allow_pii=args.allow_pii_hits)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(out_path)

    m = payload["metrics"]
    w = payload["watermark"]
    print(f"已导出（只读·脱敏）：{out_path}")
    print(f"  PII {payload['pii_check']['status']} · sha256 {payload['integrity']['sha256'][:16]}…"
          f" · {payload['integrity']['canonical_bytes']} bytes")
    print(f"  水位：max_event_at {w['max_event_at_utc'] or '-'}"
          f" · streams {w['streams']}")
    print(f"  发送 {m['sent']} · 送达(final) {m['delivered_final']}"
          f" · 送达(ever) {m['delivered_ever']} · 退信 {m['bounced']}"
          f" · pending {m['pending']} · legacy_unverified {m['legacy_unverified']}")
    print(f"  回复：inbound {m['inbound_messages']} · 唯一买家 {m['unique_repliers']}"
          f" · 线程 {m['replied_threads']} · 商机 {m['confirmed_opportunity_repliers']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="只读邮件诊断：discover + 脱敏 export")
    sub = ap.add_subparsers(dest="cmd")

    d = sub.add_parser("discover", help="只读列出 tenant/company/account（不写文件）")
    d.add_argument("--data-dir", required=True, help="DC_DATA_DIR（含 email-facts/）")
    d.add_argument("--json", action="store_true", help="输出完整 JSON")
    d.set_defaults(func=cmd_discover)

    e = sub.add_parser("export", help="导出脱敏诊断包")
    e.add_argument("--data-dir", required=True)
    e.add_argument("--company-id", default=None, help="discover 确认后的 company id")
    e.add_argument("--since", default=None, help="业务日 YYYY-MM-DD")
    e.add_argument("--until", default=None, help="业务日 YYYY-MM-DD")
    e.add_argument("--report-timezone", default=DEFAULT_REPORT_TZ)
    e.add_argument("--out", required=True)
    e.add_argument("--no-markdown", action="store_true")
    e.add_argument("--allow-pii-hits", action="store_true",
                   help="PII 命中仍导出（只在排查导出器本身时用）")
    e.set_defaults(func=cmd_export)
    return ap


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    # 兼容旧式纯 flag 调用：没有子命令时按 export 处理
    if argv and argv[0] not in ("discover", "export") and not argv[0].startswith("-h"):
        argv = ["export"] + argv
    elif not argv:
        argv = ["export"]
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "func", None):  # 无参数
        ap.print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
