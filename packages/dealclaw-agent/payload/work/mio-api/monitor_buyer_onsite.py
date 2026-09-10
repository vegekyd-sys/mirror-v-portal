#!/usr/bin/env python3
# -- coding: UTF-8 --
"""monitor_buyer_onsite.py — 买家到场监控（对齐邮箱回复监控的轮询机制）

最终口径（2026-09-03 田耕郡定稿）：对齐邮箱回复监控（monitor_stelang_replies.py）——
cron 定时跑，轮询 tradechina「买家到场」通知（notice-list --msg-type 3），
检测到新到场 → openclaw message 发卡片到展商群。

真实 notice 结构（2026-09-09 小元核实）：公司名在 `company`，邮箱在 `email`，
联系人/手机/WhatsApp/到场时间埋在 `content` 文本（「键：值」分行），
手机/WhatsApp 带 #a...#A 包裹标记；公司介绍需另查（fetch_company_intro）。

用法：
  python3 monitor_buyer_onsite.py [--company-id <sid>] [--chat-id <群ID>] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

_WORKSPACE = Path(os.environ.get("OPENCLAW_WORKSPACE_DIR") or Path(__file__).resolve().parents[2])
_LOCAL_XIAOYUAN = _WORKSPACE / ".venv-xiaoyuan" / "bin" / "xiaoyuan"
_XIAOYUAN = shutil.which("xiaoyuan") or (
    str(_LOCAL_XIAOYUAN) if _LOCAL_XIAOYUAN.exists() else "/opt/xiaoyuan-venv/bin/xiaoyuan"
)

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
        _XIAOYUAN,
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


def _run_xiaoyuan(*args) -> dict | None:
    """跑一次 xiaoyuan CLI，返回解析后的 JSON dict；失败返回 None。"""
    cmd = [_XIAOYUAN, "--open-id", os.environ.get("MIO_V_OPEN_ID", ""),
           "--supplier-id", os.environ.get("MIO_CDP_SUPPLIER_ID", ""), *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    try:
        return json.loads(proc.stdout or proc.stderr)
    except Exception:
        return None


def fetch_company_intro(company_name: str, purchaser_id: str, exhibition_id: str) -> str:
    """查公司简介（1-2 句）。优先 company_profile，否则用买家特征 + 行业标签。

    失败静默返回空串，不影响主流程。每次新到场多 2 个只读 API 调用。
    """
    if not (company_name or purchaser_id or exhibition_id):
        return ""
    cdp_id = ""
    try:
        d = _run_xiaoyuan("buyer", "onsite", "--exhibition-id", exhibition_id,
                          "--keywords", company_name, "--page-no", "1", "--page-size", "10")
        recs = ((d or {}).get("response", {}).get("data", {}) or {}).get("records") or []
        for r in recs:
            if r.get("purchaserId") == purchaser_id or (r.get("companyName") or "").upper() == company_name.upper():
                cdp_id = r.get("companyCdpid") or ""
                break
    except Exception:
        pass

    if not cdp_id:
        return ""

    try:
        d2 = _run_xiaoyuan("buyer", "detail", "--company-cdp-id", cdp_id)
        data = (d2 or {}).get("response", {}).get("data", {})
        items = data if isinstance(data, list) else [data]
        for it in items:
            bi = it.get("buyerInfo") or it or {}
            profile = (bi.get("company_profile") or bi.get("companyProfile") or "").strip()
            industry = (bi.get("purchase_big_industry_cns") or "").strip()
            chars = (bi.get("buyer_characteristics") or "").strip()
            if profile:
                return profile[:120]
            parts = []
            if chars:
                parts.append(chars.replace(",", "、"))
            if industry:
                tags = [t for t in industry.split(",") if t and t != "其他"]
                if tags:
                    parts.append("行业：" + "/".join(tags[:3]))
            if parts:
                return "；".join(parts)
    except Exception:
        pass
    return ""


def notice_key(n: dict) -> str:
    """通知唯一键（去重）。用 id 字段。"""
    for k in ("id", "noticeId", "messageId", "msgId"):
        if n.get(k):
            return f"{k}:{n[k]}"
    return "hash:" + json.dumps(n, ensure_ascii=False, sort_keys=True)


def format_card_text(n: dict) -> str:
    """把一条到场通知格式化成卡片文本（全部信息 + 公司简介）。

    真实 notice 结构：公司名在 `company`，联系人/手机/WhatsApp/到场时间埋在 `content`
    文本里（「键：值」分行）；手机/WhatsApp 带 #a...#A 包裹标记要剥掉。
    """
    content = n.get("content") or ""
    fields = {}
    for line in content.splitlines():
        if "：" in line:
            k, _, v = line.partition("：")
            fields[k.strip()] = v.strip()

    company = n.get("company") or fields.get("公司名称") or n.get("title") or "(未知买家)"
    contact = n.get("contactName") or fields.get("买家姓名") or ""
    phone = (n.get("phone") or n.get("mobile") or fields.get("手机号码") or fields.get("WhatsApp") or "")
    phone = phone.replace("#a", "").replace("#A", "").strip()
    email = n.get("email") or ""
    arrival = fields.get("到场时间（本地）") or fields.get("到场时间") or ""
    intro = n.get("_intro") or ""

    lines = ["📥 邀约买家已到场", f"公司：{company}"]
    if contact:
        lines.append(f"联系人：{contact}")
    if email:
        lines.append(f"邮箱：{email}")
    if phone:
        lines.append(f"电话/WA：{phone}")
    if arrival:
        lines.append(f"到场时间：{arrival}")
    if intro:
        lines.append(f"公司介绍：{intro}")
    return "\n".join(lines)


def send_feishu_card(chat_id: str, text: str, dry_run: bool = False) -> bool:
    """openclaw message 发消息到展商群（对齐 dc_push_target 的推群方式）。"""
    if not chat_id:
        print("[monitor_buyer_onsite] 缺 chat_id，跳过推群", file=sys.stderr)
        return False
    openclaw_bin = os.environ.get("OPENCLAW_BIN", "openclaw")
    node_bin = os.environ.get("OPENCLAW_NODE")
    cmd = [
        openclaw_bin, "message", "send",
        "--channel", "feishu",
        "--target", chat_id,
        "--message", text,
        "--json",
    ]
    if dry_run:
        print("[dry-run] " + " ".join(cmd))
        return True
    env = os.environ.copy()
    if node_bin:
        env["PATH"] = str(Path(node_bin).resolve().parent) + os.pathsep + env.get("PATH", "")
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)
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
        n["_intro"] = fetch_company_intro(
            n.get("company") or "", str(n.get("purchaserId") or ""), n.get("exhibitionId") or "",
        )
        text = format_card_text(n)
        send_feishu_card(chat_id, text, dry_run=args.dry_run)
        print(f"NOTIFIED: {n.get('company') or n.get('title') or notice_key(n)}")


if __name__ == "__main__":
    main()
