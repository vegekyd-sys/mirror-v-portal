#!/usr/bin/env python3
"""
DC-LS 存储引擎 — 线索标注、去重、历史归档、偏好回传
======================================================
本地 JSON 存储。M0 版本，后续可迁 Supabase。

数据结构:
    {
      "company_cdp_id": "COXXX",
      "company_name": "PACIFIC TRANSMISSION",
      "domain": "pacifictransmission.com",
      "country": "MY",
      "keywords": ["power transmission", "belt"],
      "enterprise": "solarunis.com",  # 租户/企业隔离键，必填
      "user_open_id": "ou_xxx",
      "status": "我的买家",      # 我的买家 | 排除 | 跳过 | 待处理
      "exclude_reason": null,    # 体量太大 | 行业不对 | 已有供应商 | 黑名单
      "source": "CDP searchAIV2",
      "created_at": "2026-07-19T10:00:00",
      "annotated_at": null,
      "score": 85,
    }

去重键:
    - domain (标准化: 去 www/https/路径)
    - company_name (标准化: 大写去标点)

用法:
    from dc_ls_store import LeadStore
    
    store = LeadStore()
    
    # 标注（enterprise 必填，禁止跨企业操作）
    store.annotate("COXXX", "ou_xxx", "我的买家", enterprise="solarunis.com")
    store.annotate("COYYY", "ou_xxx", "排除", reason="体量太大", enterprise="solarunis.com")
    
    # 去重检查（只在本企业内去重）
    store.is_duplicate("pacifictransmission.com", enterprise="solarunis.com")  # → True/False
    store.filter_duplicates([...candidates...], current_user="ou_xxx", enterprise="solarunis.com")
    
    # 偏好回传
    prefs = store.get_user_preferences("ou_xxx")
    # → {"排除国家": ["US"], "排除规则": [{"type": "size", "threshold": "5000"}]}
    
    # 历史查询
    history = store.get_user_leads("ou_xxx", enterprise="solarunis.com")
    all_leads = store.get_enterprise_leads("solarunis.com")  # 本企业老板视角
"""

import json
import os
import re
from datetime import datetime, timezone
from typing import Optional


# ── 配置 ──────────────────────────────────────────────────
_DATA_DIR = os.environ.get("DC_DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
_LEADS_FILE = os.path.join(_DATA_DIR, "leads.json")
_PREFS_FILE = os.path.join(_DATA_DIR, "preferences.json")


# ── 域名标准化 ────────────────────────────────────────────
def normalize_domain(domain: str) -> str:
    """标准化域名：去掉 protocol、www、路径、尾缀空格"""
    if not domain:
        return ""
    d = domain.strip().lower()
    d = re.sub(r'^https?://', '', d)
    d = re.sub(r'^www\.', '', d)
    d = d.split('/')[0]  # 去掉路径
    d = d.strip()
    return d


def normalize_company_name(name: str) -> str:
    """标准化公司名：大写、去标点"""
    if not name:
        return ""
    return re.sub(r'[^\w\s]', '', name.upper().strip())


# ── 存储引擎 ──────────────────────────────────────────────
class LeadStore:
    """线索存储引擎"""

    def __init__(self):
        os.makedirs(_DATA_DIR, exist_ok=True)
        self._leads = self._load(_LEADS_FILE, [])
        self._prefs = self._load(_PREFS_FILE, {})
        self._audit = None

    def _load(self, path: str, default):
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)
        return default

    def _save_leads(self):
        with open(_LEADS_FILE, 'w') as f:
            json.dump(self._leads, f, ensure_ascii=False, indent=2)

    def _save_prefs(self):
        with open(_PREFS_FILE, 'w') as f:
            json.dump(self._prefs, f, ensure_ascii=False, indent=2)

    def _audit_log(self, action, user_open_id, enterprise, target, detail, before=None, after=None):
        if not enterprise:
            return
        try:
            if self._audit is None:
                from dc_audit import AuditLog
                self._audit = AuditLog()
            self._audit.log(action, user_open_id=user_open_id, enterprise=enterprise,
                            target=target, detail=detail, before=before, after=after)
        except Exception:
            from dc_degrade import degrade
            degrade.decide("audit_write", enterprise=enterprise)

    def _learn_from_annotate(self, enterprise, lead, promote_long_term=False):
        """标注反哺买家画像"""
        if not enterprise:
            return
        try:
            from dc_customer_import import learn_from_annotate
            learn_from_annotate(enterprise, lead, promote_long_term=promote_long_term)
        except Exception:
            pass

    # ── 线索 CRUD ──────────────────────────────────────

    def save_lead(self, lead: dict) -> str:
        """
        保存一条线索。自动去重——同 domain 已存在则更新。
        
        lead 必填: company_name, domain, user_open_id, enterprise
        lead 可选: company_cdp_id, country, keywords, source, score
        """
        enterprise = normalize_domain(lead.get("enterprise", ""))
        if not enterprise:
            raise ValueError("save_lead requires enterprise for tenant isolation")
        lead["enterprise"] = enterprise
        domain = normalize_domain(lead.get("domain", ""))
        company = normalize_company_name(lead.get("company_name", ""))

        # 检查是否已存在
        for i, existing in enumerate(self._leads):
            if normalize_domain(existing.get("enterprise", "")) != enterprise:
                continue
            existing_domain = normalize_domain(existing.get("domain", ""))
            existing_company = normalize_company_name(existing.get("company_name", ""))
            if existing_domain == domain or existing_company == company:
                # 更新
                lead["domain"] = domain
                lead["company_name"] = company
                lead["updated_at"] = datetime.now(timezone.utc).isoformat()
                if "created_at" not in lead:
                    lead["created_at"] = existing.get("created_at", lead["updated_at"])
                self._leads[i] = {**existing, **lead}
                self._save_leads()
                # 🔗 Heartbeat: 线索更新
                try:
                    from heartbeat_data import upsert_lead_status
                    upsert_lead_status(
                        buyer=company, contact=domain,
                        priority=lead.get("priority", "normal"),
                        status=lead.get("status", "已处理"),
                        notes=lead.get("score", "") or lead.get("recommendation", ""),
                    )
                except Exception as _hb_err:
                    print(f"[heartbeat] upsert_lead_status failed: {_hb_err}")
                # 📮 触发 A：线索落池后懒建默认邮箱（best-effort）
                self._ensure_default_mailbox(lead)
                return "updated"

        # 新线索
        lead["domain"] = domain
        lead["company_name"] = company
        lead["created_at"] = lead.get("created_at") or datetime.now(timezone.utc).isoformat()
        if "status" not in lead:
            lead["status"] = "待处理"
        self._leads.append(lead)
        self._save_leads()
        self._audit_log("lead.save", lead.get("user_open_id",""), lead.get("enterprise",""),
                        lead.get("domain",""), f"新线索入库: {lead.get('company_name','')}")
        # 🔗 Heartbeat: 新线索入库
        try:
            from heartbeat_data import upsert_lead_status
            upsert_lead_status(
                buyer=company, contact=domain,
                priority=lead.get("priority", "normal"),
                status=lead.get("status", "待处理"),
                notes=lead.get("score", "") or lead.get("recommendation", ""),
            )
        except Exception as _hb_err:
            print(f"[heartbeat] upsert_lead_status failed: {_hb_err}")
        # 📮 触发 A：线索落池后懒建默认邮箱（best-effort）
        self._ensure_default_mailbox(lead)
        return "created"

    def _ensure_default_mailbox(self, lead: dict) -> dict:
        """触发 A：线索落池之后懒建本租户默认邮箱（best-effort，永不抛异常）。

        轻量约定：
          · 只在当前租户 supplier_id 可解析时才动作（未配置则完全 no-op）；
          · 返回结构只作日志/上层观测用，**不影响** ``save_lead`` 的返回值；
          · 任何失败都吞掉（默认邮箱是增强能力，不能拖垮线索入库）。
        """
        try:
            from email_gateway.provision import resolve_tenant_id, try_ensure_mailbox
            enterprise_id = resolve_tenant_id("")   # 只认租户配置，不从线索域名猜
            if not enterprise_id:
                return {"ok": False, "skipped": "no_tenant_configured"}
            notify = str(lead.get("user_open_id", "") or "").strip()
            result = try_ensure_mailbox(
                enterprise_id,
                company_name=str(lead.get("company_name", "") or ""),
                owner_open_id=notify,
                notify_target=notify if notify[:3] in ("ou_", "oc_") else "",
            )
            if not result.get("ok"):
                print(f"[dc_ls_store] 默认邮箱懒建失败（不影响线索入库）："
                      f"{result.get('code')}: {result.get('error')}")
            return result
        except Exception as exc:  # noqa: BLE001
            print(f"[dc_ls_store] 默认邮箱懒建异常（不影响线索入库）："
                  f"{type(exc).__name__}: {exc}")
            return {"ok": False, "code": "internal_error", "error": str(exc)}

    def annotate(self, identifier: str, user_open_id: str, status: str,
                 reason: Optional[str] = None, enterprise: str = "",
                 promote_long_term: bool = False) -> bool:
        """
        标注一条线索。
        
        Args:
            identifier: company_cdp_id 或 domain 或 company_name
            user_open_id: 标注者
            status: 我的买家 | 不是我的买家 | 已有买家 | 黑名单买家
            reason: 二级子类目（仅"不是我的买家"时使用）
                    规模不匹配 | MOQ未达标 | 价格不匹配 | 行业不对 | 产品不匹配 | 区域不覆盖 | 其他
        """
        ent = normalize_domain(enterprise)
        if not ent:
            raise ValueError("annotate requires enterprise for tenant isolation")
        valid_statuses = ['我的买家', '不是我的买家', '已有买家', '黑名单买家']
        if status not in valid_statuses:
            raise ValueError(f"无效状态: {status}，可选: {valid_statuses}")
        for lead in self._leads:
            if normalize_domain(lead.get("enterprise", "")) != ent:
                continue
            if (lead.get("company_cdp_id") == identifier or
                normalize_domain(lead.get("domain", "")) == normalize_domain(identifier) or
                normalize_company_name(lead.get("company_name", "")) == normalize_company_name(identifier)):
                lead["status"] = status
                lead["user_open_id"] = user_open_id
                lead["annotated_at"] = datetime.now(timezone.utc).isoformat()
                if reason:
                    lead["exclude_reason"] = reason
                self._save_leads()
                self._update_preferences_from_lead(
                    lead, user_open_id, promote_long_term=promote_long_term
                )
                self._audit_log("lead.annotate", user_open_id, enterprise, identifier,
                                f"{lead.get('status','?')} | 理由: {reason or '无'}",
                                before=lead.get("status",""), after=lead.get("status",""))
                # 反哺买家画像
                self._learn_from_annotate(
                    enterprise, lead, promote_long_term=promote_long_term
                )
                # ── 同步 buyer_profile_state ──
                self._update_state_from_annotate(enterprise, user_open_id, status, lead)
                return True
        return False

    # ── 去重 ──────────────────────────────────────────

    def is_duplicate(self, domain: str, enterprise: str) -> bool:
        """检查 domain 是否已入库（仅本企业内去重）"""
        d = normalize_domain(domain)
        ent = normalize_domain(enterprise)
        if not d or not ent:
            return False
        for lead in self._leads:
            if (normalize_domain(lead.get("enterprise", "")) == ent and
                normalize_domain(lead.get("domain", "")) == d):
                return True
        return False

    def is_acquired_by_other_user(self, domain: str, current_user: str, enterprise: str) -> bool:
        """检查本企业内是否已被其他用户获取"""
        d = normalize_domain(domain)
        ent = normalize_domain(enterprise)
        if not ent:
            raise ValueError("is_acquired_by_other_user requires enterprise for tenant isolation")
        for lead in self._leads:
            if (normalize_domain(lead.get("enterprise", "")) == ent and
                normalize_domain(lead.get("domain", "")) == d and
                lead.get("user_open_id") != current_user and
                lead.get("status") != "排除"):
                return True
        return False

    def filter_duplicates(self, candidates: list[dict], current_user: str, enterprise: str) -> list[dict]:
        """
        过滤重复线索。只在本企业内去重，禁止跨企业探测。
        
        返回: 去重后的候选列表 + 已过滤的域名集合
        """
        ent = normalize_domain(enterprise)
        if not ent:
            raise ValueError("filter_duplicates requires enterprise for tenant isolation")
        filtered = []
        removed_domains = set()
        
        for c in candidates:
            domain = normalize_domain(c.get("domain", "") or c.get("website", ""))
            company = normalize_company_name(c.get("company_name", ""))
            
            # 本企业内去重
            if self.is_duplicate(domain, ent):
                removed_domains.add(domain)
                continue
            
            # 公司名去重（仅本企业）
            for lead in self._leads:
                if (normalize_domain(lead.get("enterprise", "")) == ent and
                    normalize_company_name(lead.get("company_name", "")) == company):
                    removed_domains.add(domain)
                    break
            else:
                filtered.append(c)
        
        return filtered

    # ── 偏好回传 ──────────────────────────────────────

    def _update_preferences_from_lead(self, lead: dict, user_open_id: str,
                                      promote_long_term: bool = False):
        """记录偏好证据；只有明确长期表达才晋升排除规则。"""
        if user_open_id not in self._prefs:
            self._prefs[user_open_id] = {
                "排除国家": [],
                "排除规则": [],
                "排除候选": [],
                "偏好候选": [],
                "偏好标签": {},
                "updated_at": None,
            }
        
        prefs = self._prefs[user_open_id]
        status = lead.get("status")
        reason = lead.get("exclude_reason")
        country = lead.get("country")

        if status == "我的买家":
            if promote_long_term and country:
                prefs["偏好标签"][country] = prefs["偏好标签"].get(country, 0) + 1
            else:
                candidate = {
                    "type": "positive_example",
                    "country": country,
                    "source_company": lead.get("company_name"),
                }
                if candidate not in prefs.setdefault("偏好候选", []):
                    prefs["偏好候选"].append(candidate)

        elif status == "不是我的买家":
            rule = {"type": reason or "其他", "source_company": lead.get("company_name")}
            if reason == "规模不匹配" and lead.get("company_size"):
                rule["size_threshold"] = lead["company_size"]
            if promote_long_term:
                if reason == "区域不覆盖" and country and country not in prefs["排除国家"]:
                    prefs["排除国家"].append(country)
                if rule not in prefs["排除规则"]:
                    prefs["排除规则"].append(rule)
            elif rule not in prefs.setdefault("排除候选", []):
                prefs["排除候选"].append(rule)

        elif status == "已有买家":
            # 这是单条线索状态，不是可泛化的长期买家偏好。
            candidate = {
                "type": "has_supplier",
                "source_company": lead.get("company_name"),
                "remind_after_months": 6,
            }
            if candidate not in prefs.setdefault("排除候选", []):
                prefs["排除候选"].append(candidate)

        elif status == "黑名单买家":
            candidate = {
                "type": "blacklist",
                "domain": lead.get("domain"),
                "source_company": lead.get("company_name"),
            }
            target = prefs["排除规则"] if promote_long_term else prefs.setdefault("排除候选", [])
            if candidate not in target:
                target.append(candidate)
        
        prefs["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._save_prefs()

    def get_user_preferences(self, user_open_id: str) -> dict:
        """获取用户偏好（合并默认值）"""
        return self._prefs.get(user_open_id, {
            "排除国家": [],
            "排除规则": [],
            "排除候选": [],
            "偏好候选": [],
            "偏好标签": {},
            "updated_at": None,
        })

    # ── 历史查询 ──────────────────────────────────────

    def get_user_leads(self, user_open_id: str, status: Optional[str] = None,
                       enterprise: Optional[str] = None) -> list[dict]:
        """获取某用户在某企业内的线索。enterprise 必填，跨企业数据不可查询。"""
        ent = normalize_domain(enterprise or "")
        if not ent:
            raise ValueError("get_user_leads requires enterprise for tenant isolation")
        leads = [l for l in self._leads
                 if l.get("user_open_id") == user_open_id
                 and normalize_domain(l.get("enterprise","")) == ent]
        if status:
            leads = [l for l in leads if l.get("status") == status]
        return sorted(leads, key=lambda l: l.get("annotated_at") or l.get("created_at", ""), reverse=True)

    def _update_state_from_annotate(self, enterprise: str, user_open_id: str,
                                     status: str, lead: dict):
        """
        标注后同步更新 buyer_profile_state。

        规则:
          - ✅ 买家 → positive_examples +1
          - ❌ 买家 → negative_examples +1（不永久排除）
          - ⏸️ → 暂存，不影响长期偏好
          - 单条内部标注不推进对话轮次；自然语言整轮由 dc_feedback 结算
        """
        try:
            from dc_buyer_state import BuyerState
            bs = BuyerState()
            domain = normalize_domain(lead.get("domain", ""))
            country = lead.get("country", "")

            if status == "我的买家":
                bs.add_example(enterprise, user_open_id,
                               f"{domain or lead.get('company_name','')} ({country})",
                               positive=True)
            elif status in ("不是我的买家", "黑名单买家"):
                bs.add_example(enterprise, user_open_id,
                               f"{domain or lead.get('company_name','')}",
                               positive=False)
                # 不直接永久排除，只写 negative_examples
                # 排除晋升由 dc_evolution 的 repeated negatives 驱动
                # 或用户明确说「以后不要这类」才调用 add_learned_rule
            elif status == "排除":
                # 跳过/暂存标注不影响长期偏好
                pass

        except Exception:
            pass

    def get_review_stats(self, enterprise: str, user_open_id: str = "") -> dict:
        """Get cumulative annotation stats for diagnostics; not a dialogue round."""
        ent = normalize_domain(enterprise)
        leads = [l for l in self._leads
                 if normalize_domain(l.get("enterprise", "")) == ent
                 and (not user_open_id or l.get("user_open_id") == user_open_id)
                 and l.get("status") != "待处理"]
        total = len(leads)
        positive = sum(1 for l in leads if l.get("status") == "我的买家")
        negative = total - positive
        return {"total": total, "positive": positive, "negative": negative}

    def get_enterprise_leads(self, enterprise: str) -> list[dict]:
        """获取某企业下的所有线索（老板隐式视角）。不需要 user_open_id。"""
        ent = normalize_domain(enterprise)
        if not ent:
            raise ValueError("get_enterprise_leads requires enterprise for tenant isolation")
        leads = [l for l in self._leads if normalize_domain(l.get("enterprise","")) == ent]
        return sorted(leads, key=lambda l: l.get("annotated_at") or l.get("created_at", ""), reverse=True)

    def is_buyer_blocked(self, enterprise: str, buyer: str) -> bool:
        """买家是否被拦截（拒绝/排除/黑名单/跳过）。buyer 可为域名或邮箱。"""
        ent = normalize_domain(enterprise or "")
        if not ent:
            return False
        d = (buyer or "").strip().lower()
        if "@" in d:
            d = d.split("@")[-1]
        d = normalize_domain(d)
        if not d:
            return False
        for l in self._leads:
            if normalize_domain(l.get("enterprise", "")) != ent:
                continue
            if normalize_domain(l.get("domain", "")) != d:
                continue
            if int(l.get("iq_stage", 0) or 0) < 0:
                return True
            if l.get("status") in ("不是我的买家", "黑名单买家", "排除", "跳过"):
                return True
        return False

    def get_unannotated_leads(self, user_open_id: str, enterprise: str) -> list[dict]:
        """获取某用户在某企业内未标注的线索"""
        ent = normalize_domain(enterprise)
        if not ent:
            raise ValueError("get_unannotated_leads requires enterprise for tenant isolation")
        return [l for l in self._leads
                if normalize_domain(l.get("enterprise", "")) == ent
                and l.get("user_open_id") == user_open_id and l.get("status") == "待处理"]

    # ── 统计 ─────────────────────────────────────────

    def stats(self, user_open_id: Optional[str] = None, enterprise: Optional[str] = None) -> dict:
        """线索统计。enterprise 必填；user_open_id 可选。"""
        ent = normalize_domain(enterprise or "")
        if not ent:
            raise ValueError("stats() requires enterprise for tenant isolation")
        leads = [l for l in self._leads if normalize_domain(l.get("enterprise", "")) == ent]
        if user_open_id:
            leads = [l for l in leads if l.get("user_open_id") == user_open_id]
        statuses = {}
        for l in leads:
            s = l.get("status", "待处理")
            statuses[s] = statuses.get(s, 0) + 1
        return {
            "total": len(leads),
            "by_status": statuses,
            "unique_domains": len({normalize_domain(l.get("domain", "")) for l in leads}),
        }


# ── 歧义消解 & 排除偏好（DC-LS 铁律7） ──────────────────

    def save_exclusion_preference(self, user_open_id, enterprise, exclude_keywords=None,
                                   exclude_industries=None, reason=""):
        """铁律7: 用户确认歧义后，永久写入排除偏好
        exclude_keywords: 公司名中的排除关键词列表，如 ["couple", "romance"]
        exclude_industries: 排除的行业列表，如 ["clothing", "fashion", "wedding"]
        """
        ent = normalize_domain(enterprise)
        if user_open_id not in self._prefs:
            self._prefs[user_open_id] = {
                "排除国家": [], "排除规则": [], "偏好标签": {},
                "歧义排除": {}, "updated_at": None,
            }
        
        disambig = self._prefs[user_open_id].setdefault("歧义排除", {})
        ent_disambig = disambig.setdefault(ent, {
            "关键词排除": [], "行业排除": [], "原因": [],
        })
        
        if exclude_keywords:
            for kw in exclude_keywords:
                if kw.lower() not in [k.lower() for k in ent_disambig["关键词排除"]]:
                    ent_disambig["关键词排除"].append(kw.lower())
        if exclude_industries:
            for ind in exclude_industries:
                if ind.lower() not in [i.lower() for i in ent_disambig["行业排除"]]:
                    ent_disambig["行业排除"].append(ind.lower())
        if reason and reason not in ent_disambig["原因"]:
            ent_disambig["原因"].append(reason)
        
        ent_disambig["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._prefs[user_open_id]["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._save_prefs()
        return ent_disambig

    def apply_exclusion_filter(self, candidates, user_open_id, enterprise):
        """铁律7: 搜索后自动过滤歧义排除项
        返回: (filtered_candidates, excluded_count, exclusion_details)
        """
        ent = normalize_domain(enterprise)
        prefs = self.get_user_preferences(user_open_id)
        disambig = prefs.get("歧义排除", {}).get(ent, {})
        exclude_kw = disambig.get("关键词排除", [])
        exclude_ind = disambig.get("行业排除", [])
        
        if not exclude_kw and not exclude_ind:
            return (candidates, 0, [])
        
        filtered = []
        excluded = []
        for c in candidates:
            name = (c.get("company_name", "") or "").lower()
            industry = (c.get("industry", "") or c.get("keywords", "") or "").lower()
            exclude = False
            detail = ""
            for kw in exclude_kw:
                if kw in name and not self._is_relevant(name, kw):
                    exclude = True
                    detail = f"公司名含'{kw}'且不相关"
                    break
            if not exclude:
                for ind in exclude_ind:
                    if ind in industry:
                        exclude = True
                        detail = f"行业'{ind}'已排除"
                        break
            if exclude:
                excluded.append({"company": c.get("company_name","?"), "detail": detail})
            else:
                filtered.append(c)
        
        return (filtered, len(excluded), excluded)

    @staticmethod
    def _is_relevant(name, keyword):
        """检查公司名中是否有关键词的相关上下文"""
        relevant = ["pipe", "fitting", "tube", "steel", "industrial", "valve",
                    "pump", "metal", "machinery", "hardware", "manufacturing",
                    "engineering", "forging", "casting", "precision"]
        return any(r in name for r in relevant)


# ── CLI ───────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    store = LeadStore()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stats"

    if cmd == "stats":
        if len(sys.argv) < 3:
            print("用法: stats <enterprise> [user_open_id]"); sys.exit(1)
        s = store.stats(enterprise=sys.argv[2], user_open_id=sys.argv[3] if len(sys.argv) > 3 else None)
        print(f"企业 {sys.argv[2]} 总线索: {s['total']}, 状态分布: {s['by_status']}")

    elif cmd == "annotate":
        # python dc_ls_store.py annotate <enterprise> <identifier> <user_open_id> <status> [reason]
        if len(sys.argv) < 6:
            print("用法: annotate <enterprise> <identifier> <user> <status> [reason]")
            print("  status: 我的买家 | 不是我的买家 | 已有买家 | 黑名单买家")
            print("  reason: 规模不匹配 | MOQ未达标 | 价格不匹配 | 行业不对 | 产品不匹配 | 区域不覆盖 | 其他")
        else:
            reason = sys.argv[6] if len(sys.argv) > 6 else None
            ok = store.annotate(sys.argv[3], sys.argv[4], sys.argv[5], reason, enterprise=sys.argv[2])
            print(f"{'✅' if ok else '❌'} {sys.argv[3]} → {sys.argv[5]}")

    elif cmd == "user":
        # python dc_ls_store.py user <enterprise> <open_id> [status]
        if len(sys.argv) < 4:
            print("用法: user <enterprise> <open_id> [status]"); sys.exit(1)
        enterprise = sys.argv[2]
        user_id = sys.argv[3]
        status = sys.argv[4] if len(sys.argv) > 4 else None
        leads = store.get_user_leads(user_id, status, enterprise=enterprise)
        print(f"企业 {enterprise} / 用户 {user_id}: {len(leads)} 条线索")
        for l in leads[:20]:
            print(f"  {l.get('status','?'):6s} | {l.get('company_name','?')[:30]:30s} | {l.get('domain','?'):25s} | {l.get('country','?')}")

    elif cmd == "prefs":
        # python dc_ls_store.py prefs <open_id>
        prefs = store.get_user_preferences(sys.argv[2])
        print(json.dumps(prefs, ensure_ascii=False, indent=2))

    elif cmd == "dedup":
        if len(sys.argv) < 4:
            print("用法: dedup <enterprise> <domain>"); sys.exit(1)
        enterprise = sys.argv[2]
        domain = sys.argv[3]
        print(f"企业 {enterprise} 重复检查 {domain}: {store.is_duplicate(domain, enterprise)}")

    else:
        print(f"未知命令: {cmd}")
        print("可用: stats | annotate | user | prefs | dedup")
