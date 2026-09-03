#!/usr/bin/env python3
# -- coding: UTF-8 --
"""dc_customer_sync.py — 展会邀约买家回传 tradechina（add-invitation-batch）

最终口径（2026-09-03 田耕郡定稿）：
  回传 = 批量邀约，只传「公司 CDP ID」。命令 `xiaoyuan company add-invitation-batch
  --company-cdp-ids <id1,id2,...>`，类型固定「小元」（invitation-type=41），不校验权益。

流程：
  1. 读邀约名单 data/memory/<supplier_id>/exhibition-invitations.json
  2. 收集所有 companyCdpId（去重）
  3. 调 add-invitation-batch 批量回传
  4. 结果写回名单

用法：
  python3 dc_customer_sync.py sync [--company-id <sid>] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _tenant_env import load_tenant_env

load_tenant_env()

try:
    from enterprise_ids import canonical_company_id
except ImportError:  # 兜底
    def canonical_company_id(cid: str) -> str:
        return (cid or "").strip() or os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _invitation_path(company_id: str) -> Path:
    return _workspace_root() / "data" / "memory" / company_id / "exhibition-invitations.json"


def _load_invitations(company_id: str) -> list[dict]:
    p = _invitation_path(company_id)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []
    return data.get("invitations", []) if isinstance(data, dict) else []


def _save_invitations(company_id: str, data: dict) -> Path:
    p = _invitation_path(company_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = _now()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return p


def add_invitation_batch(cdp_ids: list[str], dry_run: bool = False) -> dict:
    """调 add-invitation-batch 批量邀约（只传公司 CDP ID，类型固定小元）。"""
    cmd = [
        "xiaoyuan",
        "--open-id", os.environ.get("MIO_V_OPEN_ID", ""),
        "--supplier-id", os.environ.get("MIO_CDP_SUPPLIER_ID", ""),
        "company", "add-invitation-batch",
        "--company-cdp-ids", ",".join(cdp_ids),
    ]
    if dry_run:
        return {"dry_run": True, "cmd": cmd, "count": len(cdp_ids)}

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    try:
        parsed = json.loads(proc.stdout or proc.stderr)
        resp = parsed.get("response", {})
        return {
            "success": bool(resp.get("success")),
            "code": resp.get("code"),
            "msg": resp.get("msg", ""),
            "data": resp.get("data"),
        }
    except Exception as e:
        return {"success": False, "msg": f"解析失败: {e}",
                "raw": (proc.stdout or proc.stderr)[:500]}


def run_sync(args) -> dict:
    company_id = canonical_company_id(args.company_id)
    if not company_id:
        raise SystemExit("[dc_customer_sync] 无法确定企业 ID：--company-id 或 MIO_CDP_SUPPLIER_ID")

    invs = _load_invitations(company_id)
    cdp_ids: list[str] = []
    for r in invs:
        cid = (r.get("companyCdpId") or "").strip()
        if cid:
            cdp_ids.append(cid)
    cdp_ids = list(dict.fromkeys(cdp_ids))  # 去重保序

    if not cdp_ids:
        return {"action": "sync", "company_id": company_id, "total": 0,
                "skipped": len(invs), "reason": "名单里无 companyCdpId", "results": []}

    res = add_invitation_batch(cdp_ids, dry_run=args.dry_run)
    return {"action": "sync", "company_id": company_id, "total": len(cdp_ids),
            "cdp_ids": cdp_ids, "result": res}


def main() -> None:
    p = argparse.ArgumentParser(description="小元-展会邀约买家回传 tradechina（add-invitation-batch）")
    p.add_argument("action", choices=["sync"], help="回传动作")
    p.add_argument("--company-id", default=None, help="企业 ID（supplier_id，缺省读 MIO_CDP_SUPPLIER_ID）")
    p.add_argument("--dry-run", action="store_true", help="只打印命令不执行")
    args = p.parse_args()

    result = run_sync(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
