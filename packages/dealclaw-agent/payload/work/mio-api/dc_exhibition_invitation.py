#!/usr/bin/env python3
# -- coding: UTF-8 --
"""dc_exhibition_invitation.py — 展会邀约名单（回传 tradechina + check-in 比对的唯一基准）

背景：
  用户在展前通过「展会邀约模板」给一批买家发邀约。发出去的这些买家需要单独记一张
  名单，供两件事用：
    1. 回传 tradechina（把「我邀约了谁」写回 CDP，inviationType=4 展商自邀）
    2. 展会现场 check-in 比对（谁到展了 → 是不是我邀约的 → 飞书提醒）

  名单跟线索池解耦，不污染线索池口径；联系人字段对齐线索池「联系人」字段（解锁才有，
  未解锁留空）。

存储：
  data/memory/<supplier_id>/exhibition-invitations.json
  supplier_id 用 enterprise_ids.canonical_company_id 归一，跟 memory 目录命名一致。

动作：
  record —— 发送成功后写入/更新一条邀约记录（幂等键 = companyCdpId，兜底 公司名+国家）
  list   —— 列名单
  export —— 导出名单（回传 tradechina 直接读这个输出）

字段命名走 camelCase，跟 searchAIV2 / tradechina CDP 对齐。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _tenant_env import load_tenant_env

load_tenant_env()

try:
    from enterprise_ids import canonical_company_id
except ImportError:  # 兜底：直接读环境
    def canonical_company_id(cid: str) -> str:
        return (cid or "").strip() or os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()


SCHEMA_VERSION = 1


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_company_id(explicit: str | None) -> str:
    cid = canonical_company_id(explicit or "")
    if not cid:
        raise SystemExit("[dc_exhibition_invitation] 无法确定企业 ID：请 --company-id 指定，或确保 MIO_CDP_SUPPLIER_ID 已配置")
    return cid


def _list_path(company_id: str) -> Path:
    return _workspace_root() / "data" / "memory" / company_id / "exhibition-invitations.json"


def _load(company_id: str) -> dict:
    p = _list_path(company_id)
    if not p.exists():
        return {
            "schema_version": SCHEMA_VERSION,
            "company_id": company_id,
            "updated_at": None,
            "invitations": [],
        }
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("schema_version", SCHEMA_VERSION)
    data.setdefault("company_id", company_id)
    data.setdefault("updated_at", None)
    data.setdefault("invitations", [])
    return data


def _save(company_id: str, data: dict) -> Path:
    p = _list_path(company_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = _now()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return p


def _key_of(rec: dict) -> str:
    cdp = (rec.get("companyCdpId") or "").strip()
    if cdp:
        return "cdp:" + cdp
    name = (rec.get("companyName") or "").strip().lower()
    country = (rec.get("country") or "").strip().lower()
    return f"name:{name}|{country}"


def _merge(old: dict, new: dict) -> dict:
    """幂等合并：新值非空覆盖，空值保留旧；contact 逐字段合并；sendTime 保留首次。"""
    merged = dict(old)
    for k, v in new.items():
        if k == "contact":
            if isinstance(v, dict) and v:
                c = dict(merged.get("contact") or {})
                for ck, cv in v.items():
                    if cv:
                        c[ck] = cv
                merged["contact"] = c
            # v 为空/None → 保留旧 contact
            continue
        if v:
            merged[k] = v
    return merged


def run_record(args) -> dict:
    company_id = _resolve_company_id(args.company_id)
    if not (args.company_cdp_id or args.company_name):
        raise SystemExit("[record] 至少需要 --company-cdp-id 或 --company-name")

    contact = {
        "name": args.contact_name or "",
        "title": args.job_title or "",
        "email": args.email or "",
        "phone": args.phone or "",
        "whatsapp": args.whatsapp or "",
    }
    # 联系人全空 → 置 None（未解锁，回传时留空）
    if not any(contact.values()):
        contact = None

    rec = {
        "companyCdpId": args.company_cdp_id or "",
        "companyName": args.company_name or "",
        "website": args.website or "",
        "country": args.country or "",
        "buyerType": args.buyer_type or "",
        "product": args.product or "",
        "contact": contact,
        "exhibitionId": args.exhibition_id or "",
        "exhibitionName": args.exhibition_name or "",
        "template": args.template or "",
        "sendChannel": args.send_channel or "",
        "sendTime": args.send_time or _now(),
        "messageId": args.message_id or "",
        "invitationType": 4,  # 展商自邀
    }

    data = _load(company_id)
    key = _key_of(rec)
    for i, existing in enumerate(data["invitations"]):
        if _key_of(existing) == key:
            first_send = existing.get("sendTime") or rec.get("sendTime") or _now()
            merged = _merge(existing, rec)
            merged["sendTime"] = first_send  # 保留首次发送时间
            data["invitations"][i] = merged
            p = _save(company_id, data)
            return {"action": "record", "updated": True, "key": key, "path": str(p), "record": merged}
    rec["sendTime"] = rec.get("sendTime") or _now()
    data["invitations"].append(rec)
    p = _save(company_id, data)
    return {"action": "record", "updated": False, "key": key, "path": str(p), "record": rec}


def run_list(args) -> dict:
    company_id = _resolve_company_id(args.company_id)
    data = _load(company_id)
    invs = data["invitations"]
    if args.exhibition_id:
        invs = [r for r in invs if (r.get("exhibitionId") or "") == args.exhibition_id]
    return {
        "action": "list",
        "company_id": company_id,
        "count": len(invs),
        "invitations": invs,
    }


def run_export(args) -> dict:
    company_id = _resolve_company_id(args.company_id)
    data = _load(company_id)
    invs = data["invitations"]
    if args.exhibition_id:
        invs = [r for r in invs if (r.get("exhibitionId") or "") == args.exhibition_id]
    return {
        "action": "export",
        "company_id": company_id,
        "count": len(invs),
        "invitations": invs,
    }


def main() -> None:
    p = argparse.ArgumentParser(description="小元-展会邀约名单（record/list/export）")
    p.add_argument("action", choices=["record", "list", "export"], help="动作")
    p.add_argument("--company-id", default=None, help="企业 ID（supplier_id，缺省读 MIO_CDP_SUPPLIER_ID）")

    # record 买家字段（camelCase，对齐 searchAIV2/tradechina）
    p.add_argument("--company-cdp-id", default="", help="[record] 买家 CDP ID（幂等键）")
    p.add_argument("--company-name", default="", help="[record] 公司名")
    p.add_argument("--website", default="", help="[record] 官网")
    p.add_argument("--country", default="", help="[record] 国家")
    p.add_argument("--buyer-type", default="", help="[record] 买家类型")
    p.add_argument("--product", default="", help="[record] 邀约关联产品")
    p.add_argument("--contact-name", default="", help="[record] 联系人姓名")
    p.add_argument("--job-title", default="", help="[record] 职位")
    p.add_argument("--email", default="", help="[record] 邮箱")
    p.add_argument("--phone", default="", help="[record] 电话")
    p.add_argument("--whatsapp", default="", help="[record] WhatsApp")
    # 邀约元数据
    p.add_argument("--exhibition-id", default="", help="展会 ID")
    p.add_argument("--exhibition-name", default="", help="展会名")
    p.add_argument("--template", default="", help="邀约模板名")
    p.add_argument("--send-channel", default="", help="发送渠道 email/whatsapp")
    p.add_argument("--send-time", default="", help="发送时间（ISO，缺省当前）")
    p.add_argument("--message-id", default="", help="发送返回 message id")
    args = p.parse_args()

    if args.action == "record":
        result = run_record(args)
    elif args.action == "list":
        result = run_list(args)
    else:
        result = run_export(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
