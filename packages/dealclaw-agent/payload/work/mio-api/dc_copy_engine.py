#!/usr/bin/env python3
"""DC-Copy 开发信引擎 — CBIE+OS+buyer → 多渠道多轮序列"""

import json, os, sys
from pathlib import Path

CHANNEL_RULES = {
    "MY": {"primary": "WA", "secondary": "Email", "language": "en"},
    "VN": {"primary": "Email", "secondary": "WA", "language": "en"},
    "ID": {"primary": "WA", "secondary": "Email", "language": "en"},
    "DE": {"primary": "Email", "secondary": "LinkedIn", "language": "en"},
    "US": {"primary": "Email", "secondary": "LinkedIn", "language": "en"},
    "AE": {"primary": "WA", "secondary": "Email", "language": "en"},
    "JP": {"primary": "Email", "secondary": "", "language": "en"},
    "IN": {"primary": "WA", "secondary": "Email", "language": "en"},
    "BR": {"primary": "WA", "secondary": "Email", "language": "en"},
    "MX": {"primary": "Email", "secondary": "WA", "language": "en"},
    "PL": {"primary": "Email", "secondary": "LinkedIn", "language": "en"},
    "ZA": {"primary": "Email", "secondary": "WA", "language": "en"},
}


# ── 合规 Footer（GS 邮件自动附加，FD 不加） ─────────────────
# B2B 合法利益基础 (GDPR Art.6(1)(f) / LGPD Art.7(IX))
LEGAL_FOOTER = {
    "en": (
        "\n---\n"
        "You received this message as a relevant B2B contact. "
        "We process your data based on legitimate interest. "
        "Reply \"unsubscribe\" to opt out or request deletion at any time. "
        "No automated decisions are made with your data."
    ),
    "pt": (
        "\n---\n"
        "Você recebeu esta mensagem como um contato B2B relevante. "
        "Processamos seus dados com base em interesse legítimo. "
        "Responda \"cancelar\" para não receber mais mensagens ou solicitar exclusão. "
        "Nenhuma decisão automatizada é tomada com seus dados."
    ),
    "es": (
        "\n---\n"
        "Recibió este mensaje como contacto B2B relevante. "
        "Procesamos sus datos con base en interés legítimo. "
        "Responda \"cancelar\" para darse de baja o solicitar la eliminación. "
        "No se toman decisiones automatizadas con sus datos."
    ),
}


def _materials_section(enterprise_domain=""):
    """生成邮件中的物料链接段落。从 KB 读取就绪物料的链接。"""
    try:
        from dc_kb_engine import KBEngine
        kb = KBEngine()
        links = kb.get_material_links(enterprise_domain)
        if not links:
            return ("", "")
        html_parts = ["<p><strong>Available materials:</strong></p><ul>"]
        text_parts = ["Available materials:"]
        for m in links[:4]:
            label = m["label"]
            link = m.get("link", "")
            name = m.get("name", "") or label
            if link:
                html_parts.append(f'<li>{label}: <a href="{link}">{name}</a></li>')
                text_parts.append(f"- {label}: {name} ({link})")
            else:
                html_parts.append(f"<li>{label}: {name}</li>")
                text_parts.append(f"- {label}: {name}")
        html_parts.append("</ul>")
        return ("\n".join(html_parts), "\n".join(text_parts))
    except Exception:
        return ("", "")


def _get_template_preference(enterprise=""):
    """读取用户反馈的模板偏好，覆盖默认模板选择"""
    try:
        pref_file = Path(__file__).resolve().parent / "data" / "template_preferences.jsonl"
        if not pref_file.exists():
            return None
        prefs = []
        with open(pref_file) as f:
            for line in f:
                p = json.loads(line.strip())
                if p.get("enterprise") == enterprise:
                    prefs.append(p)
        if prefs:
            latest = prefs[-1]
            return latest.get("preferred_template", "")
    except Exception:
        pass
    return None


def _legal_footer(lang="en"):
    """返回对应语言的合规 footer。未知语言退化为英文。"""
    return LEGAL_FOOTER.get(lang, LEGAL_FOOTER["en"])


def pick_channel(country_code):
    """根据买家国家选首选/次选渠道"""
    code = (country_code or "").upper()
    return CHANNEL_RULES.get(code, {"primary": "Email", "secondary": "WA", "language": "en"})


def _s(s):
    return (s or "").strip()


def _cap(s):
    return (_s(s)[:1].upper() + _s(s)[1:]) if s else ""


# ── 模板生成 ──

def _wa_round1(buyer_name, buyer_company, buyer_domain, product, usp, enterprise, gap_hint=""):
    """WhatsApp 首条：建立关联 → 指出缺口 → 价值主张 → 行动引导"""
    greet = f"Hi {buyer_name}" if buyer_name else "Hi"
    gap = gap_hint or f"I noticed you cover power transmission but timing belts aren't listed"
    return (
        f"{greet},\n"
        f"Saw your range on {buyer_domain} — {gap}.\n\n"
        f"That's what we do. {enterprise} — {product}.\n"
        f"{usp}.\n\n"
        f"Want to send you our catalog — open to a look?\n\n"
        f"[Hans / sender]"
    )


def _email_round1(buyer_name, buyer_company, buyer_domain, product, usp, enterprise, cert="", buyer_country=""):
    """Email 首封：专业结构，5段"""
    name = buyer_name or "there"
    domain_part = f" on {buyer_domain}" if buyer_domain else ""
    cert_line = f"\n{cert} certified." if cert else ""
    lang = COUNTRY_LANG.get((buyer_country or "").upper(), "en")
    footer = _legal_footer(lang)
    return {
        "subject": f"Synchronous belt line — open to a look?",
        "html": (
            f"<p>Hi {name},</p>\n\n"
            f"<p>I came across {buyer_company}{domain_part} — "
            f"your coverage in power transmission caught my eye.</p>\n\n"
            f"<p><strong>We make {product}.</strong><br>\n"
            f"{enterprise} — {usp}.{cert_line}</p>\n\n"
            f"<p>We are looking for a partner in your region who understands "
            f"power transmission. Would you be open to a brief chat or reviewing our catalog?</p>\n\n"
            f"<p>Best,<br>[Hans]<br>{enterprise}</p>\n"
            f"<p><em>Attached: Product catalog + spec comparison</em></p>\n"
            f"<p style=\"color:#888;font-size:12px\">{footer}</p>"
        ),
        "text": (
            f"Hi {name},\n\n"
            f"I came across {buyer_company}{domain_part}.\n\n"
            f"We make {product} — {enterprise}. {usp}.{cert_line}\n\n"
            f"Looking for a partner in your region. Open to a chat or reviewing our catalog?\n\n"
            f"Best,\n[Hans]\n{enterprise}\n\n"
            f"Attached: Product catalog + spec comparison\n"
            f"{footer}"
        ),
    }


def _wa_round2(buyer_name, product, enterprise):
    """WhatsApp 二轮（Day7）"""
    return (
        f"Hi {buyer_name}, following up on my message last week.\n\n"
        f"If {product} isn't a priority right now, no problem.\n"
        f"But if you do get inquiries from factory clients about\n"
        f"this category — we'd love to be your go-to supplier.\n\n"
        f"I've attached a comparison table: {enterprise} vs leading brand.\n\n"
        f"[Hans]"
    )


def _email_round2(buyer_name, product, enterprise, buyer_country=""):
    """Email 二轮（Day7）"""
    lang = COUNTRY_LANG.get((buyer_country or "").upper(), "en")
    footer = _legal_footer(lang)
    return {
        "subject": f"Re: Synchronous belt line",
        "html": (
            f"<p>Hi {buyer_name},</p>\n\n"
            f"<p>Just following up on my note last week about {product}.</p>\n\n"
            f"<p>If it's not a priority right now, no worries. But if your clients "
            f"ever need a competitive source for this category — "
            f"we'd be glad to support.</p>\n\n"
            f"<p>Attached: {enterprise} vs leading brand comparison.</p>\n\n"
            f"<p>Best,<br>[Hans]</p>\n"
            f"<p style=\"color:#888;font-size:12px\">{footer}</p>"
        ),
        "text": (
            f"Hi {buyer_name},\n\n"
            f"Following up on {product}.\n\n"
            f"If not a priority, no problem — but if clients ever ask for this "
            f"category, we'd be glad to support.\n\n"
            f"Attached: comparison table.\n\n"
            f"Best,\n[Hans]\n"
            f"{footer}"
        ),
    }


def _wa_round3(buyer_name, product, enterprise):
    """WhatsApp 三轮（Day21，最后）"""
    return (
        f"Hi {buyer_name}, last follow-up from me.\n\n"
        f"If timing isn't right, I'll leave it here. But do keep\n"
        f"{enterprise} in mind for {product}.\n\n"
        f"Wishing you a great week ahead.\n\n"
        f"[Hans]"
    )


def _email_round3(buyer_name, enterprise, buyer_country=""):
    """Email 三轮（Day21，最后）"""
    lang = COUNTRY_LANG.get((buyer_country or "").upper(), "en")
    footer = _legal_footer(lang)
    return {
        "subject": f"Re: Synchronous belt line",
        "html": (
            f"<p>Hi {buyer_name},</p>\n\n"
            f"<p>Last note from me. If the timing isn't right, I'll leave it here.</p>\n\n"
            f"<p>Do keep {enterprise} in mind when the need comes up — "
            f"Bando-quality belts at significantly lower cost, shipped to your region.</p>\n\n"
            f"<p>Wishing you a great week ahead.</p>\n\n"
            f"<p>Best,<br>[Hans]</p>\n"
            f"<p style=\"color:#888;font-size:12px\">{footer}</p>"
        ),
        "text": (
            f"Hi {buyer_name},\n\n"
            f"Last note from me. If timing isn't right, I'll leave it here.\n\n"
            f"Keep {enterprise} in mind for {buyer_name}'s region.\n\n"
            f"Best,\n[Hans]\n"
            f"{footer}"
        ),
        "text": (
            f"Hi {buyer_name},\n\n"
            f"Last note from me. If timing isn't right, I'll leave it here.\n\n"
            f"Keep {enterprise} in mind for future needs.\n\n"
            f"Best,\n[Hans]"
        ),
    }


# ── 引擎 ──

# ── 多语言本地化模板 ──

LANG_TEMPLATES = {
    "ja": {  # 日本語
        "greeting": "{name}様",
        "intro": "{domain}で{company}様のビジネスを拝見しました。",
        "who_we_are": "弊社{enterprise}は、{product}を製造しております。",
        "usp": "{usp}。",
        "cta": "カタログをお送りしてもよろしいでしょうか？ご検討いただければ幸いです。",
        "best": "敬具",
        "sign": "{sender}\n{enterprise}\n{email}",
        "subject": "{product}のご提案 — ご検討いただけませんか",
    },
    "ko": {  # 한국어
        "greeting": "{name}님 안녕하세요",
        "intro": "{domain}에서 {company}의 사업을 확인했습니다.",
        "who_we_are": "저희 {enterprise}는 {product}을(를) 제조하고 있습니다.",
        "usp": "{usp}.",
        "cta": "카탈로그를 보내드려도 될까요? 검토 부탁드립니다.",
        "best": "감사합니다",
        "sign": "{sender} 드림\n{enterprise}\n{email}",
        "subject": "{product} 제안 — 검토 부탁드립니다",
    },
    "es": {  # Español
        "greeting": "Hola {name}",
        "intro": "He visto su negocio en {domain} — {company}.",
        "who_we_are": "Somos {enterprise}, fabricantes de {product}.",
        "usp": "{usp}.",
        "cta": "¿Le interesaría recibir nuestro catálogo? Quedo a su disposición.",
        "best": "Saludos cordiales",
        "sign": "{sender}\n{enterprise}\n{email}",
        "subject": "{product} — ¿abierto a conocer nuestra propuesta?",
    },
    "vi": {  # Tiếng Việt
        "greeting": "Chào {name}",
        "intro": "Tôi đã xem qua {domain} của {company}.",
        "who_we_are": "Chúng tôi là {enterprise}, sản xuất {product}.",
        "usp": "{usp}.",
        "cta": "Tôi có thể gửi catalogue để bạn tham khảo được không?",
        "best": "Trân trọng",
        "sign": "{sender}\n{enterprise}\n{email}",
        "subject": "{product} — mong được hợp tác",
    },

    "pt": {  # Português Brasileiro
        "greeting": "Olá {name}",
        "intro": "Conheci a {company} através do {domain}.",
        "who_we_are": "Somos a {enterprise}, fabricantes de {product}.",
        "usp": "{usp}.",
        "cta": "Gostaria de receber nosso catálogo? Fico à disposição.",
        "best": "Atenciosamente",
        "sign": "{sender}\n{enterprise}\n{email}",
        "subject": "{product} — oportunidade de parceria",
    },
    "zh": {  # 中文
        "greeting": "{name} 您好",
        "intro": "在{domain}上看到贵司{company}的业务。",
        "who_we_are": "我们是{enterprise}，专业生产{product}。",
        "usp": "{usp}。",
        "cta": "方便的话我发一份产品目录给您看看？",
        "best": "此致",
        "sign": "{sender}\n{enterprise}\n{email}",
        "subject": "关于{product}的合作机会",
    },
    "en": {  # English (default)
        "greeting": "Hi {name}",
        "intro": "I came across {company} on {domain}.",
        "who_we_are": "We are {enterprise}, manufacturing {product}.",
        "usp": "{usp}.",
        "cta": "Would you be open to reviewing our catalog?",
        "best": "Best",
        "sign": "{sender}\n{enterprise}\n{email}",
        "subject": "{product} — open to a look?",
    },
}

COUNTRY_LANG = {
    "JP": "ja", "KR": "ko", "ES": "es", "MX": "es", "AR": "es", "CL": "es",
    "VN": "vi", "CN": "zh", "TW": "zh", "HK": "zh", "SG": "zh",
    "BR": "pt", "DE": "en", "US": "en", "GB": "en", "MY": "en", "ID": "en", "IN": "en",
    "BR": "pt", "AE": "en", "PL": "en", "ZA": "en", "UZ": "en",  # default en
}


def localize_email(buyer_name, buyer_company, buyer_domain, product, usp,
                   enterprise, buyer_country="", sender_name="[Name]",
                   sender_email=""):
    """生成本地化邮件"""
    lang = COUNTRY_LANG.get((buyer_country or "").upper(), "en")
    t = LANG_TEMPLATES.get(lang, LANG_TEMPLATES["en"])
    
    name = buyer_name or "there"
    company = buyer_company or ""
    domain = buyer_domain or ""
    
    greeting = t["greeting"].format(name=name)
    intro = t["intro"].format(company=company, domain=domain)
    who = t["who_we_are"].format(enterprise=enterprise, product=product)
    usp_text = t["usp"].format(usp=usp) if usp else ""
    cta = t["cta"].format()
    sign = t["sign"].format(sender=sender_name, enterprise=enterprise, email=sender_email)
    subject = t["subject"].format(product=product)
    
    body = f"{greeting}\n\n{intro}\n\n{who}\n{usp_text}\n\n{cta}\n\n{sign}\n{_legal_footer(lang)}"
    return {"subject": subject, "text": body, "lang": lang}


class CopyEngine:
    """开发信生成引擎"""

    def generate(self, buyer, profile, os_brief=None):
        """
        buyer:  {name, company, domain, country, email, role}
        profile: {enterprise_external, product, usp, certifications, materials}
        os_brief: {angle, key_points, advantage} (optional, from DC-OS)
        """
        ent = _s(profile.get("enterprise_external") or profile.get("enterprise_internal") or "our company")
        product = _s(profile.get("product") or "our products")
        usp = _s(profile.get("usp") or "competitive pricing and export-ready support")
        cert = _s(profile.get("certifications") or "")

        buyer_name = _s(buyer.get("name") or "")
        buyer_company = _s(buyer.get("company") or "")
        buyer_domain = _s(buyer.get("domain") or "")
        buyer_country = _s(buyer.get("country") or "")

        channel = pick_channel(buyer_country)

        # OS brief 优先覆盖
        angle = (os_brief or {}).get("angle", "")
        gap = f"I noticed {angle}" if angle else ""

        sequences = []

        # WhatsApp sequence
        if channel["primary"] == "WA" or channel["secondary"] == "WA":
            sequences.append({
                "channel": "WA",
                "round_1": _wa_round1(buyer_name, buyer_company, buyer_domain, product, usp, ent, gap),
                "round_2": _wa_round2(buyer_name, product, ent),
                "round_3": _wa_round3(buyer_name, product, ent),
                "send_rule": "手动复制发送（WA暂不自动化）",
            })

        # Email sequence
        sequences.append({
            "channel": "Email",
            "round_1": _email_round1(buyer_name, buyer_company, buyer_domain, product, usp, ent, cert, buyer_country),
            "round_2": _email_round2(buyer_name, product, ent, buyer_country),
            "round_3": _email_round3(buyer_name, ent, buyer_country),
            "send_rule": "首封用户确认 → GS发送；二三轮 DC-GS 自动",
        })

        # 🔗 附件: 从 KB 获取可用物料链接
        ent_domain = profile.get("enterprise_key") or profile.get("enterprise_domain") or ""
        material_links = []
        try:
            from dc_kb_engine import KBEngine
            material_links = KBEngine().get_material_links(ent_domain)
        except Exception:
            pass

        return {
            "buyer": buyer_name or buyer_domain,
            "enterprise": ent,
            "product": product,
            "primary_channel": channel["primary"],
            "secondary_channel": channel["secondary"],
            "sequences": sequences,
            "materials": material_links,  # 🆕 可用物料及链接
        }

    def for_gs(self, buyer, profile, round_num=1):
        """直接生成 GS 可用 payload（Email 首封/二轮/三轮）"""
        result = self.generate(buyer, profile)
        for seq in result["sequences"]:
            if seq["channel"] == "Email":
                return seq[f"round_{round_num}"]
        return None



    def for_wa(self, buyer, profile, round_num=1):
        """直接生成 WhatsApp 可用消息"""
        result = self.generate(buyer, profile)
        for seq in result["sequences"]:
            if seq["channel"] == "WA":
                return seq[f"round_{round_num}"]
        # Fallback: generate WA-style short version from email
        email = self.for_gs(buyer, profile, round_num)
        if email:
            text = email["text"]
            lines = [l for l in text.split("\n") if l.strip() and not l.strip().startswith("Attached") and not l.strip().startswith("Best")]
            wa_text = "\n".join(lines[:5])
            return wa_text
        return ""


    def localize(self, buyer, profile, sender_name="[Name]", sender_email=""):
        """生成本地化邮件（根据买家国家自动选语言）"""
        return localize_email(
            buyer_name=buyer.get("name",""),
            buyer_company=buyer.get("company",""),
            buyer_domain=buyer.get("domain",""),
            product=_s(profile.get("product","our products")),
            usp=_s(profile.get("usp","competitive pricing")),
            enterprise=_s(profile.get("enterprise_external","")),
            buyer_country=buyer.get("country",""),
            sender_name=sender_name,
            sender_email=sender_email,
        )

if __name__ == "__main__":
    import sys
    sys.path.insert(0, os.path.dirname(__file__))
    from dc_iq_engine import load_cbie_profile

    ce = CopyEngine()
    profile = load_cbie_profile(profile_path=str(
        Path(__file__).parents[2] / "memory/projects/mio/dealclaw/profiles/kmlbelt.md"))

    buyer = {"name":"Bonnie","company":"Pacific Transmission","domain":"pacifictransmission.com",
             "country":"MY","email":"bonnie.ptsb@gmail.com"}

    result = ce.generate(buyer, profile)

    if len(sys.argv) > 1 and sys.argv[1] == "gs":
        email = ce.for_gs(buyer, profile, 1)
        print("Subject:", email["subject"])
        print("---")
        print(email["text"])
    else:
        for seq in result["sequences"]:
            print(f"=== {seq['channel']} ===")
            if seq["channel"] == "Email":
                print("Subject:", seq["round_1"]["subject"])
                print("---")
                print(seq["round_1"]["text"])
            else:
                print(seq["round_1"])
            print()
    def localize(self, buyer, profile, sender_name="[Name]", sender_email=""):
        """生成本地化邮件（根据买家国家自动选语言）"""
        return localize_email(
            buyer_name=buyer.get("name",""),
            buyer_company=buyer.get("company",""),
            buyer_domain=buyer.get("domain",""),
            product=_s(profile.get("product","our products")),
            usp=_s(profile.get("usp","competitive pricing")),
            enterprise=_s(profile.get("enterprise_external","")),
            buyer_country=buyer.get("country",""),
            sender_name=sender_name,
            sender_email=sender_email,
        )


