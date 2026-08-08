#!/usr/bin/env python3
"""DC-IQ询盘处理引擎 — 入站消息→CBIE上下文→状态迁移→回复/人工断点"""

import json, os, re, sys, subprocess
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
PROFILE_DIR = BASE_DIR / "memory" / "projects" / "mio" / "dealclaw" / "profiles"

INTENT_PATTERNS = {
    "自动回复": [r"out of office",r"on leave",r"vacation",r"ooo",r"自动回复",r"休假"],
    "拒绝": [r"not interested",r"wrong person",r"stop",r"unsubscribe",r"remove",r"don.t contact",r"不感兴趣",r"不需要",r"投诉"],
    "索要资料": [r"catalog",r"price",r"price list",r"quote",r"spec",r"certificate",r"certification",r"sample",r"send (me|us)",r"pictures?",r"brochure",r"datasheet",r"目录",r"报价",r"规格",r"证书",r"样品",r"资料"],
    "表达兴趣": [r"interesting",r"tell me more",r"looking for",r"need",r"we want",r"could be",r"sounds good",r"interested",r"感兴趣",r"可以了解",r"需要"],
    "预约会议": [r"call",r"meeting",r"schedule",r"talk",r"visit",r"video",r"zoom",r"teams",r"discuss",r"电话",r"会议",r"视频"],
    "一般回复": [r"thanks?",r"got it",r"will check",r"noted",r"received",r"thank you",r"\bok\b",r"收到",r"好的",r"谢谢"],
}

STAGE_TRANSITIONS = {
    (0,"一般回复"):1, (0,"表达兴趣"):2, (0,"索要资料"):1,
    (1,"表达兴趣"):2, (1,"索要资料"):3,
    (2,"索要资料"):3, (2,"预约会议"):4,
    (3,"预约会议"):4,
    (0,"拒绝"):-1, (1,"拒绝"):-1, (2,"拒绝"):-1, (3,"拒绝"):-1,
    (0,"自动回复"):0, (1,"自动回复"):1, (2,"自动回复"):2, (3,"自动回复"):3,
}
STAGE_NAMES = {0:"未建联",1:"已回复",2:"已表达兴趣",3:"已索要资料",4:"已预约会议",5:"销售跟进",-1:"已暂停"}

MATERIAL_KEYWORDS = {
    "catalog": ["catalog", "brochure", "目录", "产品手册"],
    "price": ["price", "price list", "quote", "报价", "价格"],
    "spec": ["spec", "datasheet", "规格", "参数"],
    "certificate": ["certificate", "certification", "cert", "证书", "认证"],
    "sample": ["sample", "样品"],
}

PROFILE_REQUIRED = ["enterprise_external", "product", "usp"]


def classify_intent(text):
    tl = text.lower()
    scores = {}
    for intent, patterns in INTENT_PATTERNS.items():
        matches = sum(1 for p in patterns if re.search(p, tl))
        if matches > 0:
            scores[intent] = 0.85 if matches >= 3 else (0.7 if matches >= 2 else 0.5)
    if not scores:
        return ("表达兴趣", 0.3)
    
    # 🔄 读取用户纠错记录，覆盖误判
    try:
        intent_file = Path(__file__).resolve().parent / "data" / "intent_corrections.jsonl"
        if intent_file.exists():
            with open(intent_file) as f:
                for line in f:
                    c = json.loads(line.strip())
                    if c.get("original") in scores and any(w in tl for w in c.get("user_message","").lower().split()[:4]):
                        scores[c["actual"]] = scores.pop(c["original"], 0) + 0.2
                        break
    except Exception:
        pass
    
    priority = ["拒绝", "索要资料", "预约会议", "表达兴趣", "一般回复", "自动回复"]
    for p in priority:
        if p in scores:
            return (p, scores[p])
    return list(scores.items())[0]


def get_next_stage(cur, intent):
    return STAGE_TRANSITIONS.get((cur,intent), cur)


def _first_regex(text, pattern, default=""):
    m = re.search(pattern, text, re.I | re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else default


def _strip_md(s):
    return re.sub(r"[*_`]+", "", (s or "")).strip()


def _slug_candidates(value):
    raw = (value or "").lower()
    parts = [raw, raw.replace(".", "-"), raw.split(".")[0]]
    parts += [re.sub(r"[^a-z0-9]+", "", p) for p in parts]
    parts += [re.sub(r"[^a-z0-9]+", "-", p).strip("-") for p in parts]
    return [p for p in dict.fromkeys(parts) if p]



def has_cjk(s):
    return bool(re.search(r"[\u4e00-\u9fff]", s or ""))

def english_segment(s):
    s = _strip_md(s or "")
    # Prefer English inside parentheses when Chinese + English are mixed.
    parens = re.findall(r"[（(]([^）)]+)[）)]", s)
    for item in parens:
        if re.search(r"[A-Za-z]", item) and not has_cjk(item):
            return item.strip()
    # If whole string is English-safe, keep it.
    if re.search(r"[A-Za-z]", s) and not has_cjk(s):
        return s
    return ""

def field_external(text, field_name):
    return _strip_md(_first_regex(text, r"\|\s*" + re.escape(field_name) + r"\s*\|\s*[^|]+\|\s*([^|]+)\|"))

def compact_usp(parts):
    clean=[]
    for x in parts:
        x=english_segment(x)
        if x and x.lower() not in [c.lower() for c in clean]:
            clean.append(x)
    return ", ".join(clean[:3])

def load_cbie_profile(enterprise="", enterprise_domain="", profile_path=""):
    """读取 CBIE Phase3 画像 markdown/json，返回邮件可用字段。"""
    path = Path(profile_path) if profile_path else None
    if not path or not path.exists():
        for slug in _slug_candidates(enterprise_domain) + _slug_candidates(enterprise):
            for ext in (".md", ".json"):
                cand = PROFILE_DIR / (slug + ext)
                if cand.exists():
                    path = cand
                    break
            if path and path.exists():
                break
    if not path or not path.exists():
        return {"source":"missing", "missing":["CBIE画像"], "materials":{}}

    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        try:
            data = json.loads(text)
            return normalize_profile(data, str(path))
        except Exception:
            pass

    profile = {"source": str(path), "materials": {}}
    profile["enterprise_internal"] = field_external(text, "公司名")  # filled below with external-safe value for email
    profile["enterprise_external"] = field_external(text, "公司名")
    raw_product = _first_regex(text, r"\*\*核心自产[:：]\*\*\s*([^\n]+)") or _first_regex(text, r"主营产品[:：]\s*([^\n]+)")
    profile["product"] = english_segment(raw_product)

    brand = field_external(text, "品牌")
    agent = field_external(text, "代理")
    cert = field_external(text, "资质")
    scale = field_external(text, "规模")
    company_type = field_external(text, "类型")
    profile["usp"] = compact_usp([agent, cert, scale, company_type, brand])
    if cert:
        profile["certifications"] = cert
        profile["materials"]["certificate"] = cert

    # 邮件外发字段必须是英文外部线；不足就断点，不用中文内部线硬凑。
    missing = [k for k in PROFILE_REQUIRED if not profile.get(k)]
    for k in ("enterprise_external", "product", "usp"):
        if has_cjk(profile.get(k, "")) and k not in missing:
            missing.append(k + "_external_en")
    profile["missing"] = missing
    return profile


def normalize_profile(data, source):
    profile = {"source": source, "materials": data.get("materials", {}) if isinstance(data, dict) else {}}
    if isinstance(data, dict):
        profile["enterprise_external"] = data.get("enterprise_external") or data.get("company_external") or data.get("company") or ""
        profile["enterprise_internal"] = data.get("enterprise_internal") or data.get("company_internal") or ""
        profile["product"] = data.get("product") or data.get("main_product") or ""
        profile["usp"] = data.get("usp") or data.get("value_prop") or data.get("positioning") or ""
        profile["certifications"] = data.get("certifications") or ""
    profile["missing"] = [k for k in PROFILE_REQUIRED if not profile.get(k)]
    return profile


def requested_materials(reply_text):
    tl = reply_text.lower()
    found = []
    for key, kws in MATERIAL_KEYWORDS.items():
        if any(k.lower() in tl for k in kws):
            found.append(key)
    return found


def material_missing(profile, material_keys):
    materials = profile.get("materials") or {}
    return [k for k in material_keys if not materials.get(k)]


def build_feishu_notice(reason, buyer_name, buyer_domain, reply_text, missing=None, draft=None, user_open_id=""):
    title = {
        "missing_profile": "📌 CBIE画像不足，IQ暂停自动回复",
        "missing_material": "📂 买家索要资料，但资料不足",
        "uncertain": "💬 买家回复意图不确定",
        "meeting": "📅 买家想约会议，需人工确认",
        "rejected": "❌ 买家拒绝/投诉，已暂停自动营销",
    }.get(reason, "⚠️ DC-IQ 人工断点")
    body = [title]
    body.append(f"买家：{buyer_name or buyer_domain}")
    if buyer_domain:
        body.append(f"域名：{buyer_domain}")
    body.append(f"原文：{reply_text[:500]}")
    if missing:
        body.append("缺失：" + ", ".join(missing))
    if draft:
        body.append("草稿：" + draft[:500])
    if user_open_id:
        body.append(f"处理人：{user_open_id}")
    body.append("动作：请补充资料，或人工确认后再发送。")
    return "\n".join(body)


def maybe_send_feishu_notice(user_open_id, notice_text):
    """生产环境设置 DC_IQ_SEND_FEISHU=1 才真正发送。默认只返回 notice payload。"""
    if not user_open_id or os.getenv("DC_IQ_SEND_FEISHU") != "1":
        return {"sent": False, "reason": "disabled", "notice": notice_text}
    try:
        cmd = ["openclaw", "message", "send", "--target", f"user:{user_open_id}", "--message", notice_text]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        return {"sent": p.returncode == 0, "stdout": p.stdout[-500:], "stderr": p.stderr[-500:], "notice": notice_text}
    except Exception as e:
        return {"sent": False, "reason": str(e), "notice": notice_text}


def generate_reply(intent, new_stage, buyer="", profile=None, kb_summary=""):
    profile = profile or {}
    company = profile.get("enterprise_external") or profile.get("enterprise_internal") or "our company"
    product = profile.get("product") or "your products"
    usp = profile.get("usp") or "reliable quality and export-ready support"
    name = (", " + buyer) if buyer else ""
    sign = "\n— " + company
    # 合规提示：已在对话中的买家，尾部附加简短退订提醒
    optout = "\n\n-- \nReply \"unsubscribe\" to opt out at any time."
    if intent == "自动回复":
        return None
    if new_stage < 0:
        return "Thank you. We'll pause outreach. Reach out anytime." + sign
    if new_stage == 1:
        return f"Got it{name}. What {product} specs or applications are you working with? I'll send the relevant info." + sign + optout
    if new_stage == 2:
        return f"For {product}, our edge is {usp}. What size, application or quantity are you considering?" + sign + optout
    if new_stage == 3:
        # 🔗 获取可用物料链接
        mat_links = ""
        try:
            from dc_kb_engine import KBEngine
            links = KBEngine().get_material_links(profile.get("enterprise",""))
            if links:
                mat_names = [f"{m['label']}" for m in links[:4]]
                mat_links = "\n\nAvailable: " + ", ".join(mat_names)
        except Exception:
            pass
        if kb_summary:
            return f"{kb_summary} Just let me know which specs interest you — I can send details right away.{mat_links}" + sign + optout
        return f"I can share the relevant {product} materials. Which specs or application matter most for your side?{mat_links}" + sign + optout
    return None


class IQEngine:
    def __init__(self):
        self._store = None
        self._kb = None
        self._sendlog = None
        self._audit = None

    @property
    def store(self):
        if self._store is None:
            sys.path.insert(0, os.path.dirname(__file__))
            from dc_ls_store import LeadStore
            self._store = LeadStore()
        return self._store

    @property
    def kb(self):
        if self._kb is None:
            sys.path.insert(0, os.path.dirname(__file__))
            from dc_kb_engine import KBEngine
            self._kb = KBEngine()
        return self._kb

    @property
    def sendlog(self):
        if self._sendlog is None:
            sys.path.insert(0, os.path.dirname(__file__))
            from dc_send_log import SendLog
            self._sendlog = SendLog()
        return self._sendlog

    def _audit_log(self, action, user_open_id, enterprise, target, detail):
        if not enterprise:
            return
        try:
            if self._audit is None:
                from dc_audit import AuditLog
                self._audit = AuditLog()
            self._audit.log(action, user_open_id=user_open_id, enterprise=enterprise,
                            target=target, detail=detail)
        except Exception:
            from dc_degrade import degrade
            degrade.decide("audit_write", error="audit_log", enterprise=enterprise)

    def _record_to_kb(self, enterprise, intent, reply_text, buyer_domain):
        if not enterprise:
            return
        try:
            self.kb.record_iq_interaction(enterprise, intent, reply_text[:100], buyer_domain)
        except Exception as e:
            from dc_degrade import degrade
            degrade.decide("kb_load", error=str(e), enterprise=enterprise)

    def _adapt_persona_from_iq(self, enterprise, buyer_domain, reply_text, intent, confidence):
        """回路2: IQ交互 → 搜索偏好自适应。高置信度的正面回复自动调整买家画像权重。"""
        if not enterprise or confidence < 0.6:
            return
        if intent not in ("索要资料", "表达兴趣"):
            return
        try:
            # 从回复内容推断买家类型
            text_lower = (reply_text or "").lower()
            buyer_type_hints = {
                "分销商": ["distributor", "wholesale", "distribution", "reseller"],
                "安装商": ["installer", "installation", "solar panel", "rooftop"],
                "系统集成商": ["integrator", "system integrator", "solution", "epc"],
                "OEM": ["oem", "manufacturer", "factory"],
            }
            detected_type = None
            for bt, hints in buyer_type_hints.items():
                if any(h in text_lower for h in hints):
                    detected_type = bt
                    break
            if detected_type:
                incoming = {"buyer_type": {detected_type: 0.8}}
                self.kb.update_persona(enterprise, incoming, source="iq_adapt", weight=0.05,
                                      change=f"IQ自适应: {buyer_domain} 识别为{detected_type}")
        except Exception:
            pass

    def process(self, buyer_domain, reply_text, channel="GS", current_stage=0,
                user_open_id="", buyer_name="", enterprise="", enterprise_domain="",
                cbie_profile_path=""):
        intent, conf = classify_intent(reply_text)
        profile = load_cbie_profile(enterprise, enterprise_domain, cbie_profile_path)
        new_stage = get_next_stage(current_stage, intent)
        draft = generate_reply(intent, new_stage, buyer_name, profile)
        result = {
            "intent":intent, "confidence":round(conf,2), "old_stage":current_stage,
            "new_stage":new_stage, "stage_name":STAGE_NAMES.get(new_stage,"未知"),
            "auto_reply":None, "draft_reply":draft, "action":"auto", "break_reason":"",
            "send_via":"none", "send_to":"", "send_command":"", "cbie_source":profile.get("source"),
            "missing":[], "feishu_notice":None, "feishu_send":None,
        }

        def breakpoint(reason, missing=None, draft_for_notice=None):
            result["action"] = "breakpoint" if reason not in ("rejected",) else "notify_only"
            result["break_reason"] = reason
            result["missing"] = missing or []
            notice = build_feishu_notice(reason, buyer_name, buyer_domain, reply_text, missing, draft_for_notice, user_open_id)
            result["feishu_notice"] = notice
            result["feishu_send"] = maybe_send_feishu_notice(user_open_id, notice)
            return result

        if conf < 0.4:
            return breakpoint("uncertain", draft_for_notice=draft)
        if intent == "拒绝" or new_stage < 0:
            result["new_stage"] = -1
            result["stage_name"] = STAGE_NAMES[-1]
            # B: 写入退订事件，后续发送前会被拦截
            if enterprise and buyer_domain:
                try:
                    self.sendlog._append({
                        "type": "unsubscribed",
                        "buyer_domain": buyer_domain,
                        "buyer_name": buyer_name,
                        "enterprise": enterprise,
                        "user_open_id": user_open_id,
                        "channel": channel,
                        "detail": "buyer rejected via IQ",
                        "status": "unsubscribed",
                    })
                except Exception:
                    from dc_degrade import degrade
                    degrade.decide("sendlog_read", error="unsubscribed write failed", enterprise=enterprise, buyer=buyer_domain)
            self._audit_log("iq.unsubscribed", user_open_id, enterprise, buyer_domain,
                            f"意图: {intent} | 买家: {buyer_name or buyer_domain}")
            # C: 拒绝时不存回复原文，仅存意图标签
            self._save_state(buyer_domain, buyer_name, user_open_id, -1, intent, "", channel, enterprise)
            return breakpoint("rejected")
        if profile.get("missing") or profile.get("source") == "missing":
            missing = profile.get("missing") or ["CBIE画像"]
            return breakpoint("missing_profile", missing, draft)
        if new_stage >= 4:
            self._save_state(buyer_domain, buyer_name, user_open_id, new_stage, intent, reply_text, channel, enterprise)
            return breakpoint("meeting", draft_for_notice=draft)
        if intent == "索要资料":
            needs = requested_materials(reply_text) or ["catalog"]
            ek = enterprise_domain or enterprise or buyer_domain or "unknown"
            # 首次命中时自动从 CBIE 画像播种 KB
            self.kb.seed_from_cbie(ek, profile)
            kb_missing = self.kb.missing_materials(ek, needs)
            if kb_missing:
                return breakpoint("missing_material", kb_missing, draft)
            kb_sum = self.kb.summary_for_iq(ek)
            draft = generate_reply(intent, new_stage, buyer_name, profile, kb_sum)
        result["auto_reply"] = draft
        self._save_state(buyer_domain, buyer_name, user_open_id, new_stage, intent, reply_text, channel, enterprise)
        # 🔄 回路2: IQ → 搜索偏好自适应
        self._adapt_persona_from_iq(enterprise, buyer_domain, reply_text, intent, conf)
        # 记录到 KB 交互记忆
        self._record_to_kb(enterprise, intent, reply_text, buyer_domain)
        self._audit_log("iq.process", user_open_id, enterprise, buyer_domain,
                        f"意图: {intent} → Stage {new_stage} ({STAGE_NAMES.get(new_stage,'?')})")
        return result

    def _save_state(self, buyer_domain, buyer_name, user_open_id, stage, intent, reply_text, channel, enterprise=""):
        if not user_open_id or not enterprise:
            return
        # C: 拒绝/退订时最小化存储 — 不存回复原文
        minimized_reply = "" if intent == "拒绝" else (reply_text or "")[:200]
        try:
            self.store.save_lead({"company_name":buyer_name or buyer_domain,"domain":buyer_domain,
                "enterprise":enterprise,"user_open_id":user_open_id,"status":"我的买家" if stage >= 0 else "不是我的买家",
                "iq_stage":stage,"iq_last_intent":intent,"iq_last_reply":minimized_reply,"iq_channel":channel,
                "iq_updated_at":datetime.now(timezone.utc).isoformat()})
        except Exception as e:
            from dc_degrade import degrade
            degrade.decide("persona_save", error=str(e), enterprise=enterprise, buyer=buyer_domain)

    def get_stage(self, buyer_domain, user_open_id, enterprise=""):
        if not user_open_id or not enterprise:
            return 0
        for l in self.store.get_user_leads(user_open_id, enterprise=enterprise) or []:
            if l.get("domain") == buyer_domain:
                return l.get("iq_stage",0)
        return 0

    def follow_up(self, buyer_domain, reply_text, channel="GS",
                  user_open_id="", buyer_name="", buyer_email="",
                  enterprise="", enterprise_domain="", cbie_profile_path=""):
        current = self.get_stage(buyer_domain, user_open_id, enterprise) if user_open_id and enterprise else 0
        result = self.process(
            buyer_domain=buyer_domain, reply_text=reply_text, channel=channel, current_stage=current,
            user_open_id=user_open_id, buyer_name=buyer_name, enterprise=enterprise,
            enterprise_domain=enterprise_domain, cbie_profile_path=cbie_profile_path,
        )
        if result["action"] == "auto" and result["auto_reply"] and buyer_email:
            result["send_via"] = "FD" if channel == "FD" else "GS"
            result["send_to"] = buyer_email
            escaped = result["auto_reply"].replace("\n", " ").replace('"', '')
            if channel == "FD":
                result["send_command"] = f'node scripts/founder-direct/send-direct.mjs --to "{buyer_email}" --subject "Re: your inquiry" --text "{escaped[:300]}"'
            else:
                result["send_command"] = f'node scripts/resend/send.mjs --from "v@mail.dogarm.top" --to "{buyer_email}" --subject "Re: your inquiry" --text "{escaped[:300]}"'
        elif result["action"] == "breakpoint":
            result["send_via"] = "manual"
            # 🔗 Heartbeat: 待确认回复草稿
            try:
                from heartbeat_data import append_pending_reply
                append_pending_reply(
                    buyer=buyer_name or buyer_domain,
                    contact=buyer_email or buyer_domain,
                    intent=intent,
                    risk=result.get("break_reason", "") or "需用户确认",
                    draft_path=f"drafts/{buyer_domain}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.md",
                )
            except Exception as _hb_err:
                print(f"[heartbeat] append_pending_reply failed: {_hb_err}")
        return result

    def simulate_conversation(self, buyer_domain, messages, channel="GS",
                              user_open_id="", buyer_name="", buyer_email="",
                              enterprise="", enterprise_domain="", cbie_profile_path=""):
        rounds = []
        for msg in messages:
            r = self.follow_up(
                buyer_domain=buyer_domain, reply_text=msg["text"], channel=channel,
                user_open_id=user_open_id, buyer_name=buyer_name, buyer_email=buyer_email,
                enterprise=enterprise, enterprise_domain=enterprise_domain, cbie_profile_path=cbie_profile_path,
            )
            rounds.append(r)
            if r["action"] == "breakpoint":
                break
        return rounds


if __name__ == "__main__":
    engine = IQEngine()
    if len(sys.argv) < 3:
        print("用法: python dc_iq_engine.py <domain> <reply_text> [channel] [stage] [enterprise_domain]")
        sys.exit(1)
    r = engine.process(
        sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv)>3 else "GS",
        int(sys.argv[4]) if len(sys.argv)>4 else 0,
        buyer_name=sys.argv[1].split(".")[0].title(),
        enterprise_domain=sys.argv[5] if len(sys.argv)>5 else "kmlbelt.com",
    )
    print(json.dumps(r, ensure_ascii=False, indent=2))
