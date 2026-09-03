#!/usr/bin/env python3
# -- coding: UTF-8 --
"""monitor_buyer_onsite.py — 买家到场监控（对齐邮箱回复监控的轮询机制）

最终口径（2026-09-03 田耕郡定稿）：对齐邮箱回复监控（monitor_stelang_replies.py）——
cron 定时跑，轮询 tradechina「买家到场」通知（notice-list --msg-type 3），
检测到新到场 → lark-cli 发卡片到展商群。

用法：
  python3 monitor_buyer_onsite.py [--company-id <sid>] [--chat-id <群ID>] [--dry-run]

TODO（等真实数据样例回填）：
  1. notice-list msgType=3 返回的 records 单条字段结构（通知 id、公司名、到场人、联系方式）
  2. 展商群 chat_id 绑定方式（对齐 dc_notify routes / 企业绑定）
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

try:
    from dc_notify import get_default_target
except ImportError:  # 兜底
    def get_default_target() -> str:
        return ""


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _state_path(company_id: str) -> Path:
    return _workspace_root() / "data" / "memory" / company_id / "buyer-onsite-monitor-state.json"


def load_state(company_id: str) -> dict:
    p = _state_path(company_id)
    if p.exists():
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(d, dict) and isinstance(d.get("known"), list):
                return d
        except Exception:
            pass
    return {"known": []}


def save_state(company_id: str, state: dict) -> None:
    p = _state_path(company_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = _now()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def fetch_onsite_notices(page_size: int = 50, mock_file: str = "") -> list[dict]:
    """轮询 tradechina「买家到场」通知（notice-list --msg-type 3）。

    指定 mock_file 时读本地 JSON（列表，或 {"records":[...]}），不走真实接口，
    用于联调/测试。
    """
    if mock_file:
        try:
            raw = Path(mock_file).read_text(encoding="utf-8")
            data = json.loads(raw)
            if isinstance(data, list):
                return data
            if isinstance(data, dict):
                return data.get("records") or data.get("notices") or []
            return []
        except Exception as e:
            print(f"[monitor_buyer_onsite] mock 读取失败: {e}", file=sys.stderr)
            return []
    cmd = [
        "xiaoyuan",
        "--open-id", os.environ.get("MIO_V_OPEN_ID", ""),
        "--supplier-id", os.environ.get("MIO_CDP_SUPPLIER_ID", ""),
        "company", "notice-list",
        "--msg-type", "3",
        "--page-size", str(page_size),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    try:
        parsed = json.loads(proc.stdout or proc.stderr)
        data = parsed.get("response", {}).get("data") or {}
        recs = data.get("records") or []
        return recs if isinstance(recs, list) else []
    except Exception as e:
        print(f"[monitor_buyer_onsite] 解析失败: {e}", file=sys.stderr)
        return []


def notice_key(n: dict) -> str:
    """通知唯一键（去重）。TODO：按真实字段回填（如 noticeId / id）。"""
    for k in ("id", "noticeId", "messageId", "msgId"):
        if n.get(k):
            return f"{k}:{n[k]}"
    return "hash:" + json.dumps(n, ensure_ascii=False, sort_keys=True)


def format_card_text(n: dict) -> str:
    """把一条到场通知格式化成卡片文本。TODO：按真实字段回填（公司名 + 到场人 + 联系方式）。"""
    # 占位：真实字段回填后替换
    name = n.get("companyName") or n.get("buyerCompanyName") or n.get("title") or "(未知买家)"
    extra = ""
    contact = n.get("contactName") or n.get("contact") or ""
    if contact:
        extra += f"\n联系人：{contact}"
    email = n.get("email") or ""
    if email:
        extra += f"\n邮箱：{email}"
    phone = n.get("phone") or n.get("mobile") or ""
    if phone:
        extra += f"\n电话：{phone}"
    return f"📥 邀约买家已到场\n公司：{name}{extra}"


def send_feishu_card(chat_id: str, text: str, dry_run: bool = False) -> bool:
    """lark-cli 发消息到展商群（对齐邮件回复监控的推群方式）。"""
    if not chat_id:
        print("[monitor_buyer_onsite] 缺 chat_id，跳过推群", file=sys.stderr)
        return False
    cmd = [
        "lark-cli", "im", "+messages-send",
        "--as", "bot",
        "--chat-id", chat_id,
        "--text", text,
    ]
    if dry_run:
        print("[dry-run] " + " ".join(cmd))
        return True
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return True
    except Exception as e:
        print(f"[monitor_buyer_onsite] 推群失败: {e}", file=sys.stderr)
        return False


def main() -> None:
    p = argparse.ArgumentParser(description="小元-买家到场监控（轮询 notice-list msgType=3）")
    p.add_argument("--company-id", default=None, help="企业 ID（supplier_id，缺省读 MIO_CDP_SUPPLIER_ID）")
    p.add_argument("--chat-id", default=None, help="展商群 chat_id（缺省读 dc_notify routes default）")
    p.add_argument("--mock-file", default="", help="本地 mock 到场通知 JSON（列表或 {records:[...]}），不走真实接口")
    p.add_argument("--dry-run", action="store_true", help="只打印不执行")
    args = p.parse_args()

    company_id = canonical_company_id(args.company_id)
    if not company_id:
        raise SystemExit("[monitor_buyer_onsite] 无法确定企业 ID：--company-id 或 MIO_CDP_SUPPLIER_ID")
    # 复用 dc_notify 的路由绑定（routes.json default 键），--chat-id 可显式覆盖
    chat_id = (args.chat_id or get_default_target() or "").strip()

    notices = fetch_onsite_notices(mock_file=args.mock_file)
    state = load_state(company_id)
    known = set(state["known"])

    new_notices = []
    for n in notices:
        k = notice_key(n)
        if k in known:
            continue
        known.add(k)
        new_notices.append(n)

    state["known"] = sorted(known)
    save_state(company_id, state)

    if not new_notices:
        print("NO_NEW_ONSITE")
        return

    for n in new_notices:
        text = format_card_text(n)
        send_feishu_card(chat_id, text, dry_run=args.dry_run)
        print(f"NOTIFIED: {n.get('companyName') or n.get('title') or notice_key(n)}")


if __name__ == "__main__":
    main()
