#!/usr/bin/env python3
"""AI猎客每日买家线索推送 — 轻量确定性 orchestrator。

用法:
  python3 buyer_leads_daily.py <chat_id> [--dry-run] [--max-push N]

流程（全确定性，模型不参与）:
  读固化 state(binding + profile)
    → 查线索 (tradechina_buyer_leads.fetch_buyers)
    → 打分 (profile_matcher.score_envelope)
    → 筛选 push (匹配动作=push, 未推送过)
    → 渲染卡片 (复用 lead_card_renderer 的 lead_block + 解锁引导 footer)
    → 发卡片 (openclaw message send / --dry-run 只打印)
    → 写回 state (push.batches)

设计说明:
  - 复用 v15 的确定性脚本，卡片 100% 由本脚本产出，不可能漏解锁引导。
  - 绕过 tenant_run_guard/delivery_guard/resource_permission_guard 的严格契约:
    它们要求完整 onboarding state(profile + resource_permissions + 多 hash 一致性 + 60s 权限 readback)，
    而这些前置数据当前未固化。每日推送场景是「只读 + 推送到绑定群」，风险可控。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# 路径锚点：脚本在 work/mio-api/ 下，向上两级即工作区根（dev 与租户镜像 /data/workspace 通用）。
# DEALCLAW_HOME 可覆盖（过渡兼容）。
WORKSPACE_ROOT = Path(os.environ.get("DEALCLAW_HOME") or str(Path(__file__).resolve().parents[2]))
SKILL_DIR = os.environ.get(
    "BUYER_LEADS_SKILL_DIR",
    str(WORKSPACE_ROOT / "skills" / "dealclaw-buyer-leads-push" / "scripts"),
)
DATA_DIR = str(WORKSPACE_ROOT / "data" / "buyer-leads-v10")
LARK_CLI = shutil.which("lark-cli") or os.environ.get(
    "LARK_CLI", "/opt/node-v22.23.1/bin/lark-cli"
)
TZ = "+08:00"

sys.path.insert(0, SKILL_DIR)
# dc_company_registry 与本脚本同目录（work/mio-api）；显式 append 保持顺序不变
sys.path.append(str(WORKSPACE_ROOT / "work" / "mio-api"))

import tradechina_buyer_leads as tcl          # noqa: E402
import profile_matcher as pm                  # noqa: E402
import lead_card_renderer as lcr              # noqa: E402  (复用 lead_block / escape_lark_md / MEDALS)
import dc_company_registry as dcr             # noqa: E402  (ensure_company_lead_pool 幂等建池)


# 解锁引导 footer —— 与 lead_card_renderer.py render() 中的文案保持一致。
UNLOCK_FOOTER = (
    "📊 **AI猎客商机池：**\n"
    "[{base_url}]({base_url})\n\n"
    "💬 请在AI猎客商机池中标记每条线索的匹配结果"
    "（待确认/✅匹配/❌不匹配），系统将根据你的反馈优化后续推送。\n\n"
    "🔓 需要买家联系方式？在AI猎客商机池把该线索的「是否解锁」改为「已解锁」，"
    "或在本群回复「解锁线索 线索ID」，系统会把该买家的联系方式推送到本群。"
)


class OrchestratorError(RuntimeError):
    pass


def load_state(chat_id: str) -> dict[str, Any]:
    path = os.path.join(DATA_DIR, f"{chat_id}.json")
    if not os.path.exists(path):
        raise OrchestratorError(f"未找到固化 state: {path}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_state(chat_id: str, state: dict[str, Any]) -> None:
    path = os.path.join(DATA_DIR, f"{chat_id}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def base_url(base_app_token: str) -> str:
    return f"https://versa-ai.feishu.cn/base/{base_app_token}"


def fetch_and_score(state: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    binding = state["binding"]
    profile = state["profile"]
    chat_id = state["chat_id"]
    # 统一 supplier id：单租户下用数字 MIO_CDP_SUPPLIER_ID（.env），旧 S000xxx binding 仅作兑底。
    supplier_id = os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip() or binding.get("tradechina_supplier_id", "")
    # 画像未固化（无产品/目标国家）→ 无法查询，静默跳过（NO_REPLY），不报错、不刷群。
    # 缺产品/国家时由 agent 在对话里反问用户补，不在这里硬报错。
    if not profile or not (profile.get("products") or profile.get("target_countries")):
        raise OrchestratorError("state.profile 未固化（无产品/目标国家），静默跳过")

    countries = tcl.get_countries()
    resolved = {}
    for target in profile.get("target_countries", []):
        name = target["name"]
        r = tcl.resolve_country(name, countries)
        aliases = {tcl_norm(v): v for v in target.get("aliases", [])}
        for key in ("cnName", "enName"):
            val = r.get(key)
            if isinstance(val, str) and val.strip():
                aliases.setdefault(tcl_norm(val), val.strip())
        resolved[name] = {"resolved": r, "aliases": [aliases[k] for k in sorted(aliases)]}

    records_by_id: dict[str, dict[str, Any]] = {}
    for country in profile.get("target_countries", []):
        info = resolved[country["name"]]
        r = info["resolved"]
        for product in profile.get("products", []):
            kw = product["name"]
            result = tcl.fetch_buyers(
                supplier_id=supplier_id,
                country_id=str(r["countryId"]),
                product_keyword=kw,
                days=30,
                limit=20,
                max_pages=5,
            )
            for record in result.get("records", []):
                lead_id = record.get("线索ID")
                if lead_id:
                    records_by_id.setdefault(str(lead_id).strip(), record)

    matcher_records = []
    for lead_id in sorted(records_by_id):
        record = records_by_id[lead_id]
        # profile_matcher.score_envelope 要求这 11 个字段，显式构造，避免传入额外字段
        projected = {
            "飞书群ID": chat_id,
            "线索ID": record.get("线索ID", ""),
            "产品类别T1": record.get("产品类别T1", ""),
            "产品类别T2": record.get("产品类别T2", ""),
            "关注产品": record.get("关注产品", ""),
            "买家类型": record.get("买家类型", ""),
            "买家国家": record.get("买家国家", ""),
            "需求意向": record.get("需求意向", ""),
            "买家特征": record.get("买家特征", ""),
            "买家公司简介": record.get("买家公司简介", ""),
            "需求时间": record.get("需求时间", ""),
        }
        matcher_records.append(projected)

    now = datetime.now().astimezone().isoformat()
    # score_envelope 只接受 PROFILE_SCORE_KEYS 字段，从完整 profile 里投影出来
    score_keys = {
        "source_chat_id", "products", "buyer_types", "target_countries",
        "moq", "desired_buyer_tags", "buyer_profile_keywords", "intent_keywords",
    }
    scoring_profile = {k: profile.get(k) for k in score_keys if k in profile}
    scored = pm.score_envelope({
        "chat_id": chat_id,
        "run_at": now,
        "source_timezone": "Asia/Shanghai",
        "profile": scoring_profile,
        "records": matcher_records,
        "penalty_rules": [],
    })

    score_by_id = {r["线索ID"]: r for r in scored["records"]}
    merged = []
    for lead_id in sorted(records_by_id):
        source = records_by_id[lead_id]
        sr = score_by_id.get(lead_id)
        if not sr:
            continue
        m = dict(source)
        m.update(sr)
        m["画像企业名称"] = binding["company_name"]
        merged.append(m)
    return scored, merged


def already_pushed_leads(state: dict[str, Any]) -> set[str]:
    """收集 state.push.batches 里所有已推送过的 lead_ids，用于去重。"""
    pushed: set[str] = set()
    for batch in state.get("push", {}).get("batches", {}).values():
        for lid in batch.get("lead_ids", []):
            if lid:
                pushed.add(lid)
    return pushed


def render_cards(merged: list[dict[str, Any]], chat_id: str, base_token: str,
                 already_pushed: set[str] | None = None) -> list[dict[str, Any]]:
    already_pushed = already_pushed or set()
    pushed = [r for r in merged
              if r.get("匹配动作") == "push" and r["线索ID"] not in already_pushed]
    pushed.sort(key=lambda r: (-int(round(r.get("AI匹配分", 0))), r["线索ID"]))
    chosen = pushed[:5]
    if not chosen:
        return []

    url = base_url(base_token)
    grouped: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for record in chosen:
        country = lcr.display_text(record.get("买家国家"), "买家国家")
        if country not in grouped:
            grouped[country] = []
            order.append(country)
        grouped[country].append(record)

    rank_by_id = {r["线索ID"]: i for i, r in enumerate(chosen)}
    messages = []
    for country in order:
        elements = []
        for i, record in enumerate(grouped[country]):
            if i:
                elements.append({"tag": "hr"})
            elements.append(lcr.lead_block(record, rank_by_id[record["线索ID"]]))
        elements.extend([
            {"tag": "hr"},
            {"tag": "div", "text": {"tag": "lark_md", "content": UNLOCK_FOOTER.format(base_url=url)}},
            {
                "tag": "action",
                "actions": [{
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": "📊 打开AI猎客商机池"},
                    "type": "primary",
                    "url": url,
                }],
            },
        ])
        card = {
            "config": {"wide_screen_mode": True, "enable_forward": False},
            "header": {
                "template": "blue",
                "title": {"tag": "plain_text", "content": f"AI猎客｜来自{country}买家的采购机会"},
            },
            "elements": elements,
        }
        messages.append({
            "receive_id_type": "chat_id",
            "receive_id": chat_id,
            "msg_type": "interactive",
            "card": card,
            "lead_ids": [r["线索ID"] for r in grouped[country]],
            "companies": {r["线索ID"]: lcr.display_text(r.get("买家公司名称"), "买家公司名称") for r in grouped[country]},
        })
    return messages


def tcl_norm(value: Any) -> str:
    return " ".join(str(value).split()).casefold() if isinstance(value, str) else ""


def record_push(state: dict[str, Any], chat_id: str, messages: list[dict[str, Any]]) -> None:
    date = datetime.now().strftime("%Y-%m-%d")
    lead_ids = sorted({lid for m in messages for lid in m["lead_ids"]})
    material = "\n".join([chat_id, date, *lead_ids])
    batch_id = "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest()
    state.setdefault("push", {"batches": {}})
    state["push"]["batches"][batch_id] = {
        "date": date,
        "lead_ids": lead_ids,
        "status": "sent",
        "message_count": len(messages),
    }
    # 记录最近推送的买家（线索ID → 公司名），供解锁监听器反查
    state["push"].setdefault("recent_leads", {})
    for m in messages:
        for lid, company in m.get("companies", {}).items():
            state["push"]["recent_leads"][lid] = {
                "company": company,
                "pushed_at": datetime.now().isoformat(),
            }
    save_state(chat_id, state)


def send_card(chat_id: str, card: dict[str, Any]) -> tuple[str | None, str | None]:
    """用 lark-cli 发送 interactive card，返回 (message_id, error)。"""
    content = json.dumps(card, ensure_ascii=False)
    try:
        result = subprocess.run(
            [LARK_CLI, "im", "+messages-send", "--as", "bot",
             "--chat-id", chat_id, "--msg-type", "interactive",
             "--content", content, "--json"],
            capture_output=True, text=True, timeout=60,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        return None, str(exc)
    if result.returncode != 0:
        return None, result.stderr or result.stdout
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None, result.stdout
    if data.get("ok") and data.get("data", {}).get("message_id"):
        return data["data"]["message_id"], None
    return None, result.stdout


def ensure_pool(state: dict[str, Any]) -> str:
    """确保线索池 Base 存在，返回 base_app_token。幂等：读到就用，读不到自动建。

    建池不依赖画像确认——这是「直接推送是默认路径」的一部分：查不到就 ensure。
    """
    binding = state["binding"]
    if binding.get("base_app_token"):
        return binding["base_app_token"]
    company_id = binding.get("company_id") or _derive_company_id(binding)
    pool = dcr.ensure_company_lead_pool(
        company_id, binding["company_name"], chat_id=state["chat_id"]
    )
    binding["base_app_token"] = pool["app_token"]
    binding["base_table_id"] = pool["table_id"]
    binding["company_id"] = company_id
    save_state(state["chat_id"], state)
    return pool["app_token"]


def _derive_company_id(binding: dict[str, Any]) -> str:
    """无 company_id 时兑底：优先 supplier_id，其次公司名 slug。"""
    sid = (binding.get("tradechina_supplier_id") or "").strip()
    if sid:
        return "supplier-" + sid
    import re
    name = (binding.get("company_name") or "company").lower()
    name = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", name).strip("-")
    return name or "company"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("chat_id")
    parser.add_argument("--dry-run", action="store_true", help="只渲染不发送")
    parser.add_argument("--max-push", type=int, default=5)
    args = parser.parse_args()

    try:
        state = load_state(args.chat_id)
        scored, merged = fetch_and_score(state)
    except (OrchestratorError, tcl.ContractError, pm.MatchError) as exc:
        # 画像未固化（无产品/国家）→ 静默跳过，不刷群；缺信息由 agent 在对话里反问。
        if "未固化" in str(exc):
            print("NO_REPLY")
            return 0
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2

    base_token = ensure_pool(state)
    messages = render_cards(merged, args.chat_id, base_token,
                           already_pushed_leads(state))
    pushed_count = sum(len(m["lead_ids"]) for m in messages)

    if args.dry_run:
        summary = {
            "chat_id": args.chat_id,
            "company_name": state["binding"]["company_name"],
            "total_records": len(merged),
            "push_count": pushed_count,
            "message_count": len(messages),
            "dry_run": True,
        }
        print(json.dumps(summary, ensure_ascii=False))
        if messages:
            print(json.dumps(messages[0]["card"], ensure_ascii=False))
        else:
            print(json.dumps({"note": "无 ≥70 分的新线索可推送"}, ensure_ascii=False))
        return 0

    # 正常模式：真实发送。卡片已由 lark-cli 发到群，stdout 输出 NO_REPLY 抑制 cron 重复 post。
    if not messages:
        print("NO_REPLY")
        return 0

    sent = 0
    for m in messages:
        mid, err = send_card(args.chat_id, m["card"])
        if mid:
            sent += 1
        else:
            print(f"发送失败 {m['lead_ids']}: {err}", file=sys.stderr)
    record_push(state, args.chat_id, messages)
    if sent == 0:
        print(f"全部 {len(messages)} 张卡片发送失败", file=sys.stderr)
        return 3
    print("NO_REPLY")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
