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
import re
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


# ── 展示工具：简介不硬截 + 中英不混排 ────────────────────────
#
# 历史问题（2026-09-14 田耕郡报）：
#   ① 公司简介被 `profile[:120]` 硬截断——120 是早期遗留值，飞书文本消息上限远大于此；
#   ② 卡片中英混杂——简介优先取 `company_profile`（海外买家多为英文），
#      兑底又把英文 buyer_characteristics 与中文「行业：」拼在一起；
#      标签还写成了英文缩写「电话/WA」。
INTRO_MAX_LEN = 500          # 简介展示上限（保护性上限，不是内容裁剪）
CHARACTERISTICS_MAX_LEN = 200
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def has_cjk(text: str) -> bool:
    """文本里是否含中文（用于判定要不要标注「英文原文」）。"""
    return bool(_CJK_RE.search(text or ""))


def clip_text(text: str, limit: int = INTRO_MAX_LEN) -> str:
    """在句读处截断（优先 。！？.!?），超限补省略号；未超限原样返回。"""
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    window = t[:limit]
    cut = max((window.rfind(ch) for ch in "。！？!?."), default=-1)
    if cut >= limit // 2:
        return window[: cut + 1] + "…"
    return window.rstrip() + "…"


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
            # 中文字段优先：先取平台可能给的中文简介，再退到英文原文键。
            # （英文简介在中文卡片里会被误认为「中英混杂」，展示层会标注原文）
            profile = (
                bi.get("买家公司简介")
                or bi.get("companyProfileCn")
                or bi.get("company_profile_cn")
                or bi.get("company_profile")
                or bi.get("companyProfile")
                or bi.get("buyerIntroduce")
                or ""
            ).strip()
            industry = (bi.get("purchase_big_industry_cns") or "").strip()
            chars = (bi.get("buyer_characteristics") or "").strip()
            if profile:
                return clip_text(profile)
            parts = []
            # 行业标签（中文）放前，英文特征放后并限长，尽量不让英文占主体
            if industry:
                tags = [t for t in industry.split(",") if t and t != "其他"]
                if tags:
                    parts.append("行业：" + "/".join(tags[:3]))
            if chars:
                parts.append(clip_text(chars.replace(",", "、"), CHARACTERISTICS_MAX_LEN))
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

    company = n.get("company") or fields.get("公司名称") or fields.get("企业名称") or n.get("title") or "(未知买家)"
    contact = (fields.get("买家姓名") or fields.get("联系人") or fields.get("姓名")
               or n.get("contactName") or "")
    contact = str(contact).strip()
    phone = (n.get("phone") or n.get("mobile") or fields.get("手机号码") or fields.get("手机")
             or fields.get("电话") or fields.get("WhatsApp") or "")
    phone = phone.replace("#a", "").replace("#A", "").strip()
    email = (n.get("email") or fields.get("邮箱") or "").strip()
    # 平台有时把邮箱塞进「联系人」（2026-09-15 截图实证：联系人 = 邮箱，两行重复）
    # → 邮箱形态的值不当联系人；若邮箱为空则回填到邮箱行，避免丢信息。
    if "@" in contact:
        if not email:
            email = contact
        contact = ""
    arrival = (fields.get("到场时间（本地）") or fields.get("到场时间")
               or fields.get("到场时间(本地)") or "")
    intro = n.get("_intro") or ""

    lines = ["📥 邀约买家已到场", f"公司：{company}"]
    if contact:
        lines.append(f"联系人：{contact}")
    if email:
        lines.append(f"邮箱：{email}")
    if phone:
        lines.append(f"电话/WhatsApp：{phone}")
    if arrival:
        lines.append(f"到场时间：{arrival}")
    if intro:
        # 纯英文简介明确标注为原文，避免与中文标签混排后看似「中英混杂」
        label = "公司介绍" if has_cjk(intro) else "公司介绍（英文原文）"
        lines.append(f"{label}：{intro}")
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
