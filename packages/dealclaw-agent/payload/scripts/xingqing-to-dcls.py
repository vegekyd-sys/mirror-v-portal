#!/usr/bin/env python3
"""
星擎线索库 → DC-LS 导入管道
============================
流程:
  1. 从星擎 API 拉线索 (selectPage, status=已验证/精品)
  2. CBIE 买家画像匹配评分 (内部, 不展示给用户)
  3. 过滤: 相关性不足 → 跳过
  4. 写入 DC-LS LeadStore, source="星擎"
  5. 飞书群通知 + 生成回复模板

用法:
  python3 scripts/xingqing-to-dcls.py pull           # 拉取新线索并处理
  python3 scripts/xingqing-to-dcls.py pull --all      # 拉全部（含已处理）
  python3 scripts/xingqing-to-dcls.py list            # 查看已导入的星擎线索
  python3 scripts/xingqing-to-dcls.py status          # 管道状态
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Optional

# ── 路径配置 ──────────────────────────────────────────────
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIO_API = os.path.join(ROOT, "work", "mio-api")
CLUE_AGENT = os.path.join(ROOT, "scripts", "clue-agent.js")
DC_LS_STORE = os.path.join(MIO_API, "dc_ls_store.py")
STATE_FILE = os.path.join(MIO_API, "data", "xingqing_import_state.json")
LEADS_FILE = os.path.join(MIO_API, "data", "leads.json")

# 将 mio-api 加入 path, 以便 import dc_ls_store 等模块
sys.path.insert(0, MIO_API)

# ── Feishu 通知目标 ───────────────────────────────────────
NOTIFY_GROUP = "chat:oc_f5d14db9efca0bb049d36a0f4e8a9a88"  # 小元 x 星擎线索

# ── 字段映射 ──────────────────────────────────────────────
def map_xingqing_to_dcls(clue: dict, enterprise: str) -> dict:
    """星擎线索 → DC-LS LeadStore 格式"""
    contact_name = (clue.get("contactName") or "").strip()
    email = (clue.get("email") or "").strip()
    phone = (clue.get("phone") or "").strip()
    dial_code = (clue.get("dialingCode") or "").strip()
    # 构造 domain: enterprise+contact 作为去重键 (无买家真实 domain 时)
    domain = f"xq-{enterprise}-{contact_name}" if contact_name else f"xq-{enterprise}-{clue.get('id','')}"
    
    return {
        "enterprise": enterprise,           # 星擎客户企业名 (租户隔离键)
        "company_name": contact_name,        # 买家联系人 (DC-LS 用 company_name 做去重)
        "domain": domain,                    # 构造去重键
        "country": clue.get("country") or "",
        "source": "星擎",
        "status": "待处理",
        "user_open_id": f"partner:{clue.get('partnerId','')}",  # partnerId 映射
        "keywords": [
            clue.get("interestArea", ""),
            clue.get("requirementDesc", ""),
            clue.get("position", ""),
        ],
        # 星擎特有字段
        "_xq_id": clue.get("id"),
        "_xq_partnerId": clue.get("partnerId"),
        "_xq_contactName": contact_name,
        "_xq_email": email,
        "_xq_phone": f"+{dial_code}{phone}" if dial_code and phone else phone,
        "_xq_whatsApp": clue.get("whatsApp"),
        "_xq_dialingCode": dial_code,
        "_xq_position": clue.get("position"),
        "_xq_requirementDesc": clue.get("requirementDesc"),
        "_xq_status": clue.get("status"),
        "_xq_importedAt": datetime.now(timezone.utc).isoformat(),
    }


# ── 星擎 API 封装 ─────────────────────────────────────────
def call_clue_agent(cmd: str, open_id: str = "ou_9737509fa952d8427acc05454c47fb99", *args) -> dict:
    """调用 clue-agent.js 返回 JSON"""
    argv = ["node", CLUE_AGENT, cmd, open_id] + list(args)
    try:
        result = subprocess.run(
            argv, cwd=ROOT, capture_output=True, text=True, timeout=30,
            env={**os.environ, "NODE_TLS_REJECT_UNAUTHORIZED": "0"}
        )
        if result.returncode != 0:
            return {"ok": False, "error": f"clue-agent error: {result.stderr[:500]}"}
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"JSON parse error: {result.stdout[:500]}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def pull_xingqing_leads(page: int = 0, size: int = 50) -> list[dict]:
    """拉取星擎已验证/精品线索"""
    result = call_clue_agent("list", "ou_9737509fa952d8427acc05454c47fb99", str(page), str(size))
    if not result.get("ok"):
        print(f"[星擎] 拉取失败: {result.get('error')}", file=sys.stderr)
        return []
    items = result.get("items", [])
    # 只取已验证(2)和精品(3)线索
    verified = [c for c in items if str(c.get("status")) in ("2", "3")]
    print(f"[星擎] page={page} total={result.get('rawTotal')} verified={len(verified)}")
    return verified


# ── State / 去重管理 ─────────────────────────────────────
def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"imported_ids": [], "last_pull_at": None}


def save_state(state: dict):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def is_already_imported(xq_id: int, state: dict) -> bool:
    return xq_id in state.get("imported_ids", [])


def mark_imported(xq_id: int, state: dict):
    if "imported_ids" not in state:
        state["imported_ids"] = []
    state["imported_ids"].append(xq_id)
    state["last_pull_at"] = datetime.now(timezone.utc).isoformat()


# ── CBIE 买家画像匹配评分 ─────────────────────────────────
def cbie_buyer_match(clue: dict, enterprise: str) -> dict:
    """
    CBIE 买家画像匹配 (内部评分, 不展示给用户)
    
    返回: {"score": 0-100, "verdict": "pass|fail|insufficient_data", "reason": str}
    
    当前 MVP: 基于已有线索字段做快速判断。
    完整版需 DC-CBIE 引擎运行后接入。
    """
    contact_name = (clue.get("contactName") or "").strip()
    email = (clue.get("email") or "").strip()
    phone = (clue.get("phone") or "").strip()
    requirement = (clue.get("requirementDesc") or "").strip()
    interest = (clue.get("interestArea") or "").strip()
    
    # 数据完整性检查
    has_contact = bool(contact_name)
    has_email = bool(email)
    has_phone = bool(phone)
    has_inquiry = bool(requirement and requirement not in ("test", "") and 
                        "来源" not in requirement and "Excel" not in requirement)
    
    # 垃圾检测
    garbage_keywords = ["test", "ggkisg", "nhhjkd", "测试"]
    is_garbage = any(k in str(clue).lower() for k in garbage_keywords)
    
    if is_garbage:
        return {"score": 0, "verdict": "fail", "reason": "垃圾数据, 全字段无效"}
    
    if not has_contact:
        return {"score": 0, "verdict": "fail", "reason": "缺少联系人姓名"}
    
    if not has_email and not has_phone:
        return {"score": 5, "verdict": "fail", "reason": "无邮箱且无电话, 无法联系"}
    
    # 基础评分
    score = 10.0
    if has_contact: score += 15
    if has_email: score += 15
    if has_phone: score += 10
    if has_inquiry: score += 30  # 有真实询盘内容 = 高价值
    if interest: score += 10
    
    # 企业邮箱加分 (非 gmail/yahoo/outlook 等)
    free_domains = {"gmail.com", "yahoo.com", "outlook.com", "hotmail.com", 
                    "163.com", "qq.com", "126.com", "foxmail.com"}
    email_domain = email.split("@")[-1].lower() if "@" in email else ""
    if email_domain and email_domain not in free_domains:
        score += 10  # 企业邮箱 -> 更可能是真实买家
    
    if score >= 45:
        return {"score": min(score, 100), "verdict": "pass", "reason": f"基础数据完整, 评分{score:.0f}"}
    else:
        return {"score": score, "verdict": "insufficient_data", 
                "reason": f"数据不足, 缺少买家企业信息, 当前仅{score:.0f}分"}


# ── 主流程 ────────────────────────────────────────────────
def import_xingqing_to_dcls(pull_all: bool = False):
    """主导入流程"""
    from dc_ls_store import LeadStore
    
    state = load_state()
    store = LeadStore()
    
    results = {"total": 0, "imported": 0, "skipped_duplicate": 0, "skipped_quality": 0}
    notifications = []
    
    # 拉取线索
    all_leads = pull_xingqing_leads(0, 50)
    # 如果数据多, 翻页
    # (当前 53 条中已验证/精品仅 ~9 条, 一页够)
    
    for clue in all_leads:
        xq_id = clue.get("id")
        results["total"] += 1
        
        # 去重检查
        if not pull_all and is_already_imported(xq_id, state):
            results["skipped_duplicate"] += 1
            continue
        
        enterprise = (clue.get("companyName") or "").strip()
        if not enterprise:
            print(f"[跳过] ID={xq_id} 无企业名", file=sys.stderr)
            continue
        
        # CBIE 匹配评分
        match_result = cbie_buyer_match(clue, enterprise)
        
        if match_result["verdict"] == "fail":
            results["skipped_quality"] += 1
            print(f"[CBIE-REJECT] {enterprise} / {clue.get('contactName')} → {match_result['reason']}")
            continue
        
        # 写入 DC-LS
        lead = map_xingqing_to_dcls(clue, enterprise)
        lead["_cbie_score"] = match_result["score"]
        lead["_cbie_reason"] = match_result["reason"]
        
        action = store.save_lead(lead)
        mark_imported(xq_id, state)
        results["imported"] += 1
        
        print(f"[DC-LS] {action.upper()} {enterprise} / {clue.get('contactName')} "
              f"→ score={match_result['score']:.0f}")
        
        notifications.append({
            "enterprise": enterprise,
            "contact": clue.get("contactName"),
            "position": clue.get("position"),
            "email": clue.get("email"),
            "phone": clue.get("phone"),
            "country": clue.get("country"),
            "inquiry": clue.get("requirementDesc"),
            "score": match_result["score"],
            "verdict": match_result["verdict"],
        })
    
    save_state(state)
    
    # 汇总
    print(f"\n[汇总] 处理{results['total']}条 | "
          f"导入{results['imported']} | "
          f"跳过(已导入){results['skipped_duplicate']} | "
          f"跳过(质量){results['skipped_quality']}")
    
    return results, notifications


def generate_reply_template(clue: dict) -> str:
    """生成邮件/WA 回复模板"""
    contact = clue.get("contact") or "您好"
    channel = "WhatsApp" if clue.get("phone") else "邮件"
    enterprise = clue.get("enterprise", "我们公司")
    inquiry = clue.get("inquiry") or "您的消息"
    
    template = f"""【{channel} 回复模板】
收件人: {contact} ({clue.get('email') or clue.get('phone')})
---
{contact}，你好！

我从 {enterprise} 的 TikTok 账号收到了{inquiry}。

{enterprise} 是一家专业的[行业]供应商，主要产品包括[核心产品]。

想了解一下您的具体需求：
- 需要的产品型号/规格？
- 目标数量？
- 目标市场/国家？

期待您的回复！
"""
    return template


# ── CLI ───────────────────────────────────────────────────
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="星擎 → DC-LS 导入管道")
    sub = parser.add_subparsers(dest="cmd")
    
    sub.add_parser("pull", help="拉取新线索并处理").add_argument(
        "--all", action="store_true", help="含已处理")
    sub.add_parser("list", help="查看已导入的星擎线索")
    sub.add_parser("status", help="管道状态")
    sub.add_parser("test", help="干跑测试（不写入 DC-LS）")
    
    args = parser.parse_args()
    
    if args.cmd == "pull":
        results, notifications = import_xingqing_to_dcls(pull_all=getattr(args, 'all', False))
        print(json.dumps({
            "ok": True,
            "results": results,
            "notifications": notifications,
            "action_required": "请将 notifications 发送到飞书群通知",
        }, ensure_ascii=False, indent=2))
    
    elif args.cmd == "list":
        state = load_state()
        # 从 DC-LS 中列出星擎来源的线索
        from dc_ls_store import LeadStore
        store = LeadStore()
        xq_leads = [l for l in store._leads if l.get("source") == "星擎"]
        print(f"已导入星擎线索: {len(xq_leads)} 条")
        for l in xq_leads[:20]:
            print(f"  {l.get('_xq_contactName','?'):20s} | {l.get('_xq_email','?'):30s} | "
                  f"{l.get('enterprise','?')[:30]} | score={l.get('_cbie_score','?')}")
    
    elif args.cmd == "status":
        state = load_state()
        from dc_ls_store import LeadStore
        store = LeadStore()
        xq_leads = [l for l in store._leads if l.get("source") == "星擎"]
        print(f"管道状态:")
        print(f"  已导入线索: {len(xq_leads)}")
        print(f"  已处理ID数: {len(state.get('imported_ids', []))}")
        print(f"  最后拉取: {state.get('last_pull_at', 'N/A')}")
        print(f"  DC-LS 数据文件: {LEADS_FILE}")
    
    elif args.cmd == "test":
        # 干跑: 拉取但不写入
        leads = pull_xingqing_leads(0, 50)
        for clue in leads:
            enterprise = clue.get("companyName", "")
            match_result = cbie_buyer_match(clue, enterprise)
            print(f"[TEST] {enterprise[:20]:20s} | {clue.get('contactName',''):15s} "
                  f"| {(clue.get('requirementDesc') or '')[:30]:30s} "
                  f"→ score={match_result['score']:.0f} {match_result['verdict']}")
        print(f"\n干跑完成，处理 {len(leads)} 条")
    
    else:
        parser.print_help()
