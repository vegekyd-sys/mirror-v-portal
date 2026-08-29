#!/usr/bin/env python3
"""
DC-KB Publish — DealClaw 知识库飞书文档生成器

三层架构:
  python3 dc_kb_publish.py home solarunis.com     → 企业驾驶舱首页
  python3 dc_kb_publish.py full solarunis.com      → 完整知识库(旧版,兼容)
  python3 dc_kb_publish.py profile solarunis.com   → 企业画像页
  python3 dc_kb_publish.py buyer solarunis.com     → 买家深度调研页(待建)

十组件库: 判断块/风险块/机会块/关键数字/对比表/行动清单/图片解释/证据块/待确认块/相关推荐
"""

import json, os, sys
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"

def _now():
    return datetime.now(timezone.utc).isoformat()[:19]

def _load_kb(enterprise):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from dc_kb_engine import KBEngine
    return KBEngine(), KBEngine().ensure(enterprise)

# ═══════════════════════════════════════════════════════════
#  组件库 — 10 个固定组件, AI 不准自由发挥
# ═══════════════════════════════════════════════════════════

def comp_judgment(text, confidence="confirmed"):
    """组件1: 💡 判断块"""
    marks = {"confirmed": "✅ 已确认", "inferred": "🔍 AI推断", "unconfirmed": "⚠️ 待确认"}
    mark = marks.get(confidence, "")
    return f'> 💡 **V的判断**\n>\n> {text}\n>\n> _{mark}_\n'

def comp_risk(text):
    """组件2: ⚠️ 风险块"""
    return f'> ⚠️ **当前风险**\n>\n> {text}\n'

def comp_opportunity(title, detail=""):
    """组件3: 🎯 机会块"""
    text = f"> 🎯 **{title}**\n"
    if detail:
        text += f"> {detail}\n"
    return text

def comp_key_metrics(metrics):
    """组件4: 关键数字区 — 3-5个数字"""
    rows = "| 指标 | 数据 |\n|---|---|\n"
    for label, value in metrics[:5]:
        rows += f"| {label} | **{value}** |\n"
    return rows + "\n"

def comp_compare_table(headers, rows, max_cols=5):
    """组件5: 对比表 — 最多5列"""
    if not rows: return ""
    h = headers[:max_cols]
    table = "| " + " | ".join(h) + " |\n"
    table += "|" + "|".join(["---"] * len(h)) + "|\n"
    for row in rows:
        cells = [str(row.get(k, "—"))[:60] for k in h]
        table += "| " + " | ".join(cells) + " |\n"
    return table + "\n"

def comp_action(items):
    """组件6: 行动清单"""
    text = "**📋 本周建议**\n"
    for item in items[:6]:
        text += f"- [ ] {item}\n"
    return text + "\n"

def comp_image(url, caption=""):
    """组件7: 图片+解释 — 图片必须有业务含义"""
    text = f"![{caption or '图片'}]({url})\n"
    if caption:
        text += f"> {caption}\n"
    return text + "\n"

def comp_evidence(sources):
    """组件8: 证据块"""
    text = "**📎 依据**\n"
    for s in sources[:6]:
        text += f"- {s}\n"
    return text + "\n"

def comp_unconfirmed(items):
    """组件9: 待确认块"""
    text = ""
    for item in items[:5]:
        text += f"> ❓ **待确认** — {item}\n>\n"
    return text

def comp_related(links):
    """组件10: 相关推荐"""
    text = "**🔗 相关页面**\n"
    for label, url in links[:5]:
        text += f"- → [{label}]({url})\n"
    return text + "\n"


# ═══════════════════════════════════════════════════════════
#  🏠 企业驾驶舱首页
# ═══════════════════════════════════════════════════════════

def build_homepage(enterprise, layer_links=None):
    """第一层: 知识库首页 — 企业驾驶舱
    layer_links: {"home":"url", "full":"url", "profile":"url", "layer3":"url", ...}
    """
    layer_links = layer_links or {}
    _, kb = _load_kb(enterprise)
    p = kb.get("profile", {})
    persona = kb.get("persona", {})
    products = kb.get("products", [])
    mats = kb.get("materials", {})
    comp = kb.get("competitive", {})
    iq = kb.get("iq_memory", {})
    e_name = p.get("name", enterprise)

    # ── 一句话定位 ──
    usp = p.get("usp", "") or p.get("product", "") or "待补充"
    certs = p.get("certifications", "")
    product_line = p.get("product", "")[:80]

    # ── V的判断 ──
    top_countries = list(persona.get("country", {}).keys())[:3]
    buyer_types = list(persona.get("buyer_type", {}).keys())
    judge_text = f"{e_name} 的核心产品{'已明确' if products else '待完善'}。"
    if top_countries:
        judge_text += f" 买家集中在{'/'.join(top_countries)}，以{'/'.join(buyer_types[:2]) if buyer_types else 'B2B买家'}为主。"
    if comp.get("positioning"):
        judge_text += f"\n\n{comp['positioning'][:120]}"
    if not products:
        judge_text += "\n\n当前产品信息不足，建议优先补充产品线数据。"

    # ── 业务就绪度 ──
    ready_mats = sum(1 for m in mats.values() if m.get("status") == "ready")
    has_products = len(products) > 0
    has_persona = persona.get("version", 0) > 0
    has_competitors = len(comp.get("competitors", [])) > 0
    has_strategy = len(comp.get("entry_angles", [])) > 0
    has_iq = iq.get("total_interactions", 0) > 0

    readiness = [
        ("找买家", has_persona, "买家画像就绪，搜索精准" if has_persona else "缺历史客户数据"),
        ("开发信", has_products, "产品信息完整，可生成开发信" if has_products else "缺产品数据"),
        ("物料发送", ready_mats >= 3, f"{ready_mats}/7 项物料就绪" if ready_mats >= 3 else f"仅{ready_mats}/7 项物料，需补充"),
        ("竞争策略", has_competitors, f"已分析{len(comp.get('competitors',[]))}家竞品" if has_competitors else "缺竞品分析"),
        ("自动回复", has_iq, f"已处理{iq.get('total_interactions',0)}次买家互动" if has_iq else "暂无买家互动数据"),
    ]

    # ── 当前最值得做 ──
    opportunities = []
    if has_strategy:
        for a in comp.get("entry_angles", [])[:3]:
            opportunities.append(a[:80])
    if has_competitors:
        c1 = comp["competitors"][0]
        opportunities.append(f"打{c1['name']}的弱点：{c1.get('weakness','?')[:50]}")
    if not opportunities:
        opportunities = ["补充产品和竞品数据以生成策略建议"]

    # ── 知识地图 ──
    knowledge = [
        ("产品", min(len(products) * 50, 100) if products else 10),
        ("市场", 70 if persona else 10),
        ("买家", 75 if persona else 10),
        ("认证", 90 if certs else 30),
        ("物料", ready_mats * 14),
        ("策略", 50 if has_strategy else 10),
    ]

    # ── 最近学到的新知识 ──
    recent_learnings = []
    evo = persona.get("evolution", [])
    if evo:
        last = evo[-1]
        recent_learnings.append(f"画像更新: {last.get('change','')[:80]}")
    if has_iq:
        recent_learnings.append(f"买家交互 {iq.get('total_interactions',0)} 次")
    qs = iq.get("common_questions", [])
    if qs:
        recent_learnings.append(f"买家常问: {qs[0]['question'][:50]}")
    
    
    if not recent_learnings:
        recent_learnings = ["知识库刚建立，开始使用后会累积学习记录"]

    # ── 组装文档 ──
    lines = []
    lines.append(f"# 🏢 {e_name}")
    lines.append("")
    lines.append(f"> {usp}")
    lines.append("")

    # 关键数字
    metrics = [
        ("产品线", f"{len(products)} 条"),
        ("目标市场", f"{len(top_countries)} 个国家"),
        ("竞品分析", f"{len(comp.get('competitors',[]))} 家"),
        ("物料就绪", f"{ready_mats}/7"),
        ("画像版本", f"v{persona.get('version',0)}"),
    ]
    lines.append("---")
    lines.append("")
    lines.append(comp_key_metrics(metrics))
    lines.append("")

    # V的判断
    lines.append(comp_judgment(judge_text.strip()))
    lines.append("")

    # 业务就绪度
    lines.append("---")
    lines.append("")
    lines.append("## ⚡ 当前业务就绪度")
    lines.append("")
    for name, ok, detail in readiness:
        icon = "🟢" if ok else "🟡"
        lines.append(f"- {icon} **{name}**: {detail}")
    lines.append("")

    # 最值得做
    lines.append("---")
    lines.append("")
    lines.append("## 🎯 当前最值得做")
    lines.append("")
    for i, op in enumerate(opportunities[:3]):
        emoji = ["🥇", "🥈", "🥉"][i]
        lines.append(f"{emoji} {op}")
    lines.append("")

    # 知识地图
    lines.append("---")
    lines.append("")
    lines.append("## 🗺️ 企业知识地图")
    lines.append("")
    for name, pct in knowledge:
        bar = "█" * (pct // 10) + "░" * (10 - pct // 10)
        color = "🟢" if pct >= 70 else ("🟡" if pct >= 40 else "🔴")
        lines.append(f"```\n{name:4s} {bar} {pct}%\n```")
    lines.append("")

    # 学到的新知识
    lines.append("---")
    lines.append("")
    lines.append("## 🧠 最近学到的新知识")
    lines.append("")
    for item in recent_learnings[:5]:
        lines.append(f"- 💡 {item}")
    lines.append("")

    # 导航
    lines.append("---")
    lines.append("")
    lines.append("**🔗 三层知识库导航**")
    lines.append("")
    lines.append(f"📖 [知识库主题页]({layer_links.get('full','')}) — 产品线/竞品/买家画像/物料清单" if layer_links.get('full') else "📖 知识库主题页 — 产品线/竞品/买家画像/物料清单")
    lines.append(f"📋 [物料索引]({layer_links.get('layer3','')}) — 结构化物料清单，可拖入文件" if layer_links.get('layer3') else "📋 物料索引 — 结构化物料清单，可拖入文件")
    if layer_links.get('profile'):
        lines.append(f"🏢 [企业画像]({layer_links.get('profile')}) — 完整企业分析")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(f"> 🤖 DealClaw KB · {_now()}")
    lines.append("> ✏️ 本文档可直接编辑 | 数据来源于结构化知识引擎")

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
#  📦 完整知识库 (旧版,兼容)
# ═══════════════════════════════════════════════════════════

def build_full(enterprise):
    """第二层: 完整知识库文档(带物料文件提示)"""
    _, kb = _load_kb(enterprise)
    p = kb.get("persona", {})
    products = kb.get("products", [])
    mats = kb.get("materials", {})
    comp = kb.get("competitive", {})
    iq = kb.get("iq_memory", {})
    profile = kb.get("profile", {})
    e_name = profile.get("name", enterprise)
    usp = profile.get("usp", "") or profile.get("product", "")

    lines = []
    lines.append(f"# 🏢 {e_name} · 知识库")
    lines.append("")
    lines.append(f"> 📌 {usp}")
    lines.append("")

    ready_mats = sum(1 for m in mats.values() if m.get("status") == "ready")
    lines.append("---")
    lines.append(f"**📊 总览** | 🏭 {len(products)}条产品 | 👤 画像v{p.get('version',0)} | 🧠 {len(comp.get('competitors',[]))}家竞品 | 📋 {ready_mats}/7物料 | 💬 {iq.get('total_interactions',0)}次交互")
    lines.append("---")
    lines.append("")

    # 产品
    lines.append("## 📦 产品线")
    lines.append("")
    for i, pr in enumerate(products):
        price = pr.get("pricing", {}).get("fob", "—")
        mkts = ", ".join(pr.get("target_markets", [])[:4]) or "—"
        specs = " · ".join(f"**{k}**: {v}" for k, v in list(pr.get("specs", {}).items())[:5])
        lines.append(f"### {'🟢' if i == 0 else '🔵'} {pr['name']}")
        lines.append("")
        lines.append(f"| 属性 | 内容 |")
        lines.append(f"|---|---|")
        lines.append(f"| 💰 定价 | **{price}** |")
        lines.append(f"| 🎯 目标市场 | {mkts} |")
        lines.append(f"| ⚙️ 规格 | {specs} |")
        if pr.get("certifications"):
            lines.append(f"| ✅ 认证 | {' · '.join(pr['certifications'][:4])} |")
        lines.append("")

    # 画像
    country_data = p.get("country", {})
    if country_data:
        lines.append("---")
        lines.append("## 👤 买家画像")
        lines.append("")
        max_w = max(country_data.values())
        for c, w in list(country_data.items())[:8]:
            bar_len = int(w / max(max_w, 1) * 15)
            bar = "█" * bar_len + "░" * (15 - bar_len)
            lines.append(f"```\n{c}  {bar}  {w:.0%}\n```")
        lines.append(f"**买家类型**: {' · '.join(p.get('buyer_type', {}).keys())}")
        lines.append("")

    # 竞品
    lines.append("---")
    lines.append("## 🧠 竞争情报")
    lines.append("")
    if comp.get("positioning"):
        lines.append(comp_judgment(comp['positioning'][:150], "confirmed"))
    competitors = comp.get("competitors", [])
    if competitors:
        rows = [{"竞品": c['name'], "弱点": c.get('weakness', '—')[:50], "优势": c.get('advantage', '—')[:50]} for c in competitors]
        lines.append(comp_compare_table(["竞品", "弱点", "优势"], rows))
        lines.append("")

    # 物料
    lines.append("---")
    lines.append("## 📋 物料清单")
    lines.append("")
    lines.append("> 💡 每一行都可拖入文件、粘贴图片或插入链接")
    lines.append("")
    lb = {"catalog": "📖 产品目录", "price": "💰 报价单", "spec": "⚙️ 技术规格",
          "certificate": "✅ 认证证书", "sample": "📸 样品实拍",
          "case_study": "🏆 客户案例", "video": "🎬 产品视频"}
    hints = {"catalog": "拖入PDF或产品图片", "price": "拖入Excel报价单", "spec": "拖入datasheet PDF",
             "certificate": "拖入证书图片", "sample": "拖入产品实拍照片", "case_study": "拖入案例文档或照片",
             "video": "粘贴视频链接或嵌入飞书视频"}
    lines.append("| 物料 | 状态 | 📎 操作提示 |")
    lines.append("|---|---|---|")
    for mt in ["catalog", "price", "spec", "certificate", "sample", "case_study", "video"]:
        m = mats.get(mt, {})
        status = "🟢 已上传" if m.get("status") == "ready" else "⚪ 待补充"
        hint = hints.get(mt, "")
        if m.get("status") == "ready":
            lines.append(f"| {lb.get(mt, mt)} | {status} | ✅ 已就绪 |")
        else:
            lines.append(f"| {lb.get(mt, mt)} | {status} | ✏️ {hint} |")
    lines.append("")

    # IQ
    lines.append("---")
    lines.append(f"## 💬 买家常问 ({iq.get('total_interactions', 0)}次)")
    lines.append("")
    for q in sorted(iq.get("common_questions", []), key=lambda x: x["count"], reverse=True)[:8]:
        lines.append(f"- 🔹 {q['question'][:80]} ×{q['count']}")
    lines.append("")

    lines.append("---")
    lines.append(f"> 🤖 DealClaw KB · {_now()}")

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
#  🏗️ 企业画像模板
# ═══════════════════════════════════════════════════════════

def build_profile(enterprise):
    """第二层: 企业画像 — 完整企业分析"""
    _, kb = _load_kb(enterprise)
    p = kb.get("profile", {})
    persona = kb.get("persona", {})
    products = kb.get("products", [])
    comp = kb.get("competitive", {})
    mats = kb.get("materials", {})
    e_name = p.get("name", enterprise)

    lines = []
    lines.append(f"# 🏢 {e_name} · 企业画像")
    lines.append("")

    # 一句话判断
    top_countries = list(persona.get("country", {}).keys())[:3]
    buyer_types = list(persona.get("buyer_type", {}).keys())
    has_certs = bool(p.get("certifications", ""))
    judge = f"{e_name} "
    judge += f"专注{p.get('product','')[:60]}。" if p.get("product") else "产品信息待补充。"
    if top_countries:
        judge += f"\n\n核心市场为{'/'.join(top_countries)}，买家以{'/'.join(buyer_types[:2]) if buyer_types else 'B2B客户'}为主。"
    if has_certs:
        judge += f"\n\n已持有{p.get('certifications','')[:60]}认证，构成市场准入优势。"
    lines.append(comp_judgment(judge.strip()))
    lines.append("")

    # 关键数字
    lines.append(comp_key_metrics([
        ("产品线", f"{len(products)} 条"),
        ("目标市场", f"{len(top_countries)} 个国家"),
        ("认证", p.get("certifications", "—")[:40]),
        ("画像版本", f"v{persona.get('version',0)}"),
    ]))
    lines.append("")

    # 产品结构
    if products:
        lines.append("---")
        lines.append("## 📦 产品结构")
        lines.append("")
        for pr in products:
            price = pr.get("pricing", {}).get("fob", "—")
            mkts = ", ".join(pr.get("target_markets", [])[:4]) or "—"
            specs = " · ".join(f"**{k}**: {v}" for k, v in list(pr.get("specs", {}).items())[:4])
            lines.append(f"### {pr['name']}")
            lines.append(f"| 💰 定价 | 🎯 市场 | ⚙️ 核心规格 |")
            lines.append(f"|---|---|---|")
            lines.append(f"| **{price}** | {mkts} | {specs} |")
            lines.append("")

    # 竞争优势
    lines.append("---")
    lines.append("## 💪 竞争优势")
    lines.append("")
    if comp.get("positioning"):
        lines.append(comp_opportunity("市场定位", comp['positioning'][:150]))
    if comp.get("competitors"):
        rows = [{"竞品": c['name'], "我方优势": c.get('weakness', '—')[:50], "竞品优势": c.get('advantage', '—')[:50]} for c in comp["competitors"]]
        lines.append(comp_compare_table(["竞品", "我方优势", "竞品优势"], rows))
    lines.append("")

    # 认证
    lines.append("---")
    lines.append("## ✅ 认证与信任证据")
    lines.append("")
    if p.get("certifications"):
        lines.append(f"已持有: **{p['certifications']}**")
    lines.append(comp_evidence([
        f"产品认证: {p.get('certifications','待补充')[:60]}",
        f"物料就绪度: {sum(1 for m in mats.values() if m.get('status')=='ready')}/7",
    ]))
    lines.append("")

    # 知识缺口
    missing = [t for t, m in mats.items() if m.get("status") != "ready"]
    if missing:
        lines.append("---")
        lines.append("## ❓ 当前知识缺口")
        lines.append("")
        labels = {"sample": "样品实拍", "case_study": "客户案例", "video": "产品视频",
                  "catalog": "产品目录", "price": "报价单", "spec": "技术规格", "certificate": "认证证书"}
        items = [f"{labels.get(m, m)} 待补充" for m in missing[:5]]
        lines.append(comp_unconfirmed(items))

    lines.append("---")
    lines.append(f"> 🤖 DealClaw · {_now()}")

    return "\n".join(lines)



# ═══════════════════════════════════════════════════════════
#  🔍 买家深度调研模板
# ═══════════════════════════════════════════════════════════

def build_buyer(enterprise):
    """第二层: 理想买家 — 深度调研"""
    _, kb = _load_kb(enterprise)
    persona = kb.get("persona", {})
    comp = kb.get("competitive", {})
    iq = kb.get("iq_memory", {})
    profile = kb.get("profile", {})
    e_name = profile.get("name", enterprise)
    top_countries = list(persona.get("country", {}).items())[:4]
    buyer_types = list(persona.get("buyer_type", {}).keys())
    objections = iq.get("buyer_objections", [])

    lines = []
    lines.append("# 🔍 " + e_name + " · 理想买家")
    lines.append("")
    if top_countries:
        lines.append(comp_judgment(e_name + " 的理想买家是" + top_countries[0][0] + "市场的" + (buyer_types[0] if buyer_types else "B2B买家") + "。"))
    lines.append("")
    lines.append("## 👤 买家画像")
    lines.append("")
    if buyer_types:
        lines.append("**🎯 目标买家类型**: " + " · ".join(buyer_types))
        lines.append("")
    hints = {"分销商":"寻找有稳定客户群的专业分销商","安装商":"寻找活跃的本地安装商","系统集成商":"寻找项目型集成商","OEM":"寻找有OEM需求的制造商"}
    for bt in buyer_types[:4]:
        lines.append("### " + bt)
        lines.append("")
        lines.append(hints.get(bt, "—"))
        lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 🔗 采购链路")
    lines.append("")
    lines.append("```\n制造商 (中国)\n  ↓\n进口商 / 经销商 / 品牌商\n  ↓\n区域代理 / 批发商\n  ↓\n终端工厂 / 安装公司 / 零售商\n```")
    lines.append("")
    lines.append("> DealClaw 当前优先找进口商和专业经销商，不优先找小型终端。")
    lines.append("")
    if top_countries:
        lines.append("---\n\n## 🌍 目标国家\n")
        mx = max(w for _, w in top_countries)
        for c, w in top_countries[:6]:
            bl = int(w / mx * 15)
            bar = "█" * bl + "░" * (15 - bl)
            lines.append("```\n" + c + "  " + bar + "  " + str(int(w*100)) + "%\n```")
        lines.append("")
    if objections:
        lines.append("---\n\n## 🛑 常见异议\n")
        for o in objections[-5:]:
            lines.append("- ❌ " + o.get("objection","?")[:80])
        lines.append("")
    if comp.get("entry_angles"):
        lines.append("---\n\n## 💬 切入策略\n")
        for a in comp["entry_angles"][:5]:
            lines.append("- 🎯 " + a)
        lines.append("")
    lines.append("---\n\n## ⛔ 排除条件\n")
    exclude = persona.get("exclude_reasons", [])
    if exclude:
        for e_item in exclude[:5]:
            lines.append("- 🚫 " + e_item)
    else:
        lines.append("- 暂无排除规则")
    lines.append("")
    lines.append(comp_action(["确认主推买家类型和优先级","补全买家画像中的缺失字段","为每个买家类型准备差异化开发信","定期回顾 IQ 记忆中的常见异议"]))
    lines.append("---\n> 🤖 DealClaw · " + _now())
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
#  🌍 市场与国家
# ═══════════════════════════════════════════════════════════

def build_market(enterprise):
    """第二层: 市场与国家 — 机会分析"""
    _, kb = _load_kb(enterprise)
    persona = kb.get("persona", {})
    comp = kb.get("competitive", {})
    products = kb.get("products", [])
    profile = kb.get("profile", {})
    e_name = profile.get("name", enterprise)
    top_countries = list(persona.get("country", {}).items())[:6]

    lines = []
    lines.append("# 🌍 " + e_name + " · 市场与国家")
    lines.append("")
    if top_countries:
        lines.append(comp_judgment(e_name + " 的核心市场是" + top_countries[0][0] + "，权重 " + str(int(top_countries[0][1]*100)) + "%。"))
    lines.append("")
    lines.append("## 🏆 机会国家排名\n")
    if top_countries:
        rows = [{"国家":c,"买家权重":str(int(w*100))+"%","建议":"优先" if w>0.2 else ("重点" if w>0.1 else "观察")} for c,w in top_countries]
        lines.append(comp_compare_table(["国家","买家权重","建议"], rows))
    lines.append("")
    if products:
        lines.append("---\n\n## 📦 产品×市场 矩阵\n")
        all_mkts = set()
        for pr in products:
            for m in pr.get("target_markets",[]):
                all_mkts.add(m)
        for pr in products:
            mkts = pr.get("target_markets",[])
            bar = "".join("█" if m in mkts else "·" for m in sorted(all_mkts)[:8])
            lines.append("```\n" + pr["name"] + " " + bar + "\n```")
        lines.append("\n> 横轴: " + " · ".join(sorted(all_mkts)[:8]))
        lines.append("")
    if comp.get("entry_angles"):
        lines.append("---\n\n## 🎯 市场切入策略\n")
        for i,a in enumerate(comp["entry_angles"][:5]):
            lines.append(("🥇🥈🥉"[i] if i<3 else "💡") + " " + a)
        lines.append("")
    lines.append(comp_action(["确认优先级最高的3个目标国家","为每个国家准备差异化切入材料","定期更新各国买家搜索关键词"]))
    lines.append("---\n> 🤖 DealClaw · " + _now())
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
#  💼 销售与营销
# ═══════════════════════════════════════════════════════════

def build_sales(enterprise):
    """第二层: 销售与营销 — 话术、案例、异议"""
    _, kb = _load_kb(enterprise)
    comp = kb.get("competitive", {})
    iq = kb.get("iq_memory", {})
    mats = kb.get("materials", {})
    profile = kb.get("profile", {})
    e_name = profile.get("name", enterprise)

    lines = []
    lines.append("# 💼 " + e_name + " · 销售与营销")
    lines.append("")
    lines.append("## 💪 核心卖点\n")
    usp = profile.get("usp","")
    if usp:
        lines.append("> " + usp)
    lines.append("")
    if comp.get("positioning"):
        lines.append("**市场定位**: " + comp["positioning"][:150])
    lines.append("")
    competitors = comp.get("competitors", [])
    if competitors:
        lines.append("---\n\n## 🆚 竞品对比\n")
        rows = [{"竞品":c["name"],"我方优势":c.get("weakness","—")[:50],"注意":c.get("advantage","—")[:50]} for c in competitors]
        lines.append(comp_compare_table(["竞品","我方优势","注意"], rows))
        lines.append("")
    lines.append("---\n\n## 🛑 常见异议 & 应对话术\n")
    objections = iq.get("buyer_objections", [])
    if objections:
        for o in objections[-5:]:
            lines.append("**异议**: _" + o.get("objection","?")[:80] + "_\n> 💬 建议回应: (根据竞品优势调整)\n")
    else:
        lines.append("> 暂无买家异议记录\n")
    lines.append("---\n\n## 📋 可用的销售物料\n")
    labels = {"catalog":"📖 目录","price":"💰 报价","spec":"⚙️ 规格","certificate":"✅ 认证","sample":"📸 样品","case_study":"🏆 案例","video":"🎬 视频"}
    for mt in ["catalog","price","spec","certificate","sample","case_study","video"]:
        m = mats.get(mt,{})
        status = "✅ 可用" if m.get("status")=="ready" else "⬜ 缺失"
        lines.append("- " + labels.get(mt,mt) + ": " + status)
    lines.append("")
    lines.append(comp_action(["确认每个市场的核心卖点和差异化话术","补全物料中缺失的销售工具","建立异议处理的标准话术库"]))
    lines.append("---\n> 🤖 DealClaw · " + _now())
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
#  📊 第三层: 数据与原始资料
# ═══════════════════════════════════════════════════════════

def build_layer3(enterprise, user_open_id=""):
    """第三层: 数据索引 — boss看全部, sales只看自己"""
    _, kb = _load_kb(enterprise)
    profile = kb.get("profile", {})
    persona = kb.get("persona", {})
    iq = kb.get("iq_memory", {})
    e_name = profile.get("name", enterprise)
    evo = persona.get("evolution", [])
    is_boss = not user_open_id

    lines = []
    lines.append(f"# 📊 {e_name} · {'运营数据' if is_boss else '我的工作台'}")
    lines.append("")
    if is_boss:
        lines.append("> 👔 **老板视图** — 可查看全企业数据和所有销售的操作记录")
    else:
        lines.append(f"> 🧑‍💼 **销售视图** — 仅展示你的线索和操作记录")
    lines.append("")

    # ── 买家表格 ──
    lines.append("## 📋 买家数据")
    lines.append("")
    if is_boss:
        lines.append("| 表格 | 说明 | 链接 |")
        lines.append("|---|---|---|")
        lines.append("| 买家线索 | 全企业所有线索 | → [销售看板](https://hit5b11g3sf.feishu.cn/base/SCsibOMyMan0Lks1lXwcBnq4nsc) |")
        lines.append("| 操作日志 | 全企业审计追溯 | → [操作日志](https://hit5b11g3sf.feishu.cn/base/KZ3Jb6NnGaGzCosphtXczwGOnod) |")
        lines.append("| 企业总览 | 漏斗+数据看板 | → [老板看板](https://hit5b11g3sf.feishu.cn/base/SxLabNXXkazqW9sxcIbcekf1nHe) |")
    else:
        lines.append("| 表格 | 说明 |")
        lines.append("|---|---|")
        lines.append(f"| 我的线索 | 你入库和标注的买家 | 销售看板(按你筛选) |")
        lines.append(f"| 我的操作 | 你的发送和回复记录 | 操作日志(按你筛选) |")
    lines.append("")

    # ── 文件资料 ──
    lines.append("---")
    lines.append("")
    lines.append("## 📁 文件资料")
    lines.append("")
    lines.append("| 类型 | 说明 | 权限 |")
    lines.append("|---|---|---|")
    lines.append("| 产品目录 | PDF 或图片 | 🔓 全员可见 |")
    lines.append("| 报价单 | Excel 或链接 | 🔒 仅管理员可编辑 |")
    lines.append("| 技术规格 | Datasheet | 🔓 全员可见 |")
    lines.append("| 认证证书 | PDF 或图片 | 🔓 全员可见 |")
    lines.append("| 样品实拍 | 照片或视频 | 🔓 全员可见 |")
    lines.append("| 客户案例 | 文档或照片 | 🔒 仅管理员可编辑 |")
    lines.append("")

    # ── 历史报告 ──
    lines.append("---")
    lines.append("")
    lines.append("## 📄 分析报告")
    lines.append("")
    lines.append("- 企业画像 · 市场与国家 · 理想买家 · 销售与营销")
    if not is_boss:
        lines.append("- 以上报告均为企业共享知识，所有销售可阅读")
    lines.append("")

    # ── 数据来源(仅boss)
    if is_boss:
        lines.append("---")
        lines.append("")
        lines.append("## 🔗 数据来源")
        lines.append("")
        lines.append(comp_evidence([
            f"企业画像: 企业分析 + 人工补充",
            f"买家画像: {len(evo)} 次进化 · v{persona.get('version',0)}",
            f"IQ 记忆: {iq.get('total_interactions',0)} 次买家互动",
            "竞争情报: web_search + 人工标注",
            "产品数据: 人工录入",
        ]))

    # ── 版本记录(仅boss)
    if is_boss:
        lines.append("---")
        lines.append("")
        lines.append("## 📝 版本记录")
        lines.append("")
        if evo:
            lines.append("| 版本 | 时间 | 变更 |")
            lines.append("|---|---|---|")
            for e in evo[-10:]:
                ts = e.get("at", "")[:10]
                lines.append(f"| v{e.get('version','?')} | {ts} | {e.get('change','')[:60]} |")
        else:
            lines.append("> 暂无版本记录")
        lines.append("")

    lines.append("---")
    lines.append(f"> 🤖 DealClaw · {_now()}")
    if is_boss:
        lines.append("> 🔒 本文档仅企业管理员可访问")
    else:
        lines.append("> 🔒 本文档仅你可访问，其他销售看不到你的数据")
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
#  📚 主目录
# ═══════════════════════════════════════════════════════════

def build_master_index(enterprise, pages):
    """三层知识库总导航"""
    _, kb = _load_kb(enterprise)
    profile = kb.get("profile", {})
    e_name = profile.get("name", enterprise)

    lines = []
    lines.append("# 📚 " + e_name + " · 知识库")
    lines.append("\n> 三层架构: 首页给判断 → 主题页给证据 → 原始数据放多维表格\n")

    lines.append("---\n\n## 🏠 第一层: 知识库首页\n")
    lines.append("→ [企业驾驶舱](" + pages.get("home","") + ") — 一屏看懂企业全貌\n")

    lines.append("---\n\n## 📖 第二层: 业务主题页面\n")
    items = [
        ("🏢 企业与品牌","profile","企业画像、品牌定位、认证与产能"),
        ("📦 产品与解决方案","full","产品线、技术规格、应用场景"),
        ("🌍 市场与国家","market","全球机会、国家排名、切入策略"),
        ("👤 理想买家","buyer","买家画像、采购链路、异议处理"),
        ("💼 销售与营销","sales","核心卖点、竞品对比、话术库"),
        ("🎪 展会与客户资产","","展会计划、名片管理 (建设中)"),
    ]
    for label, key, desc in items:
        url = pages.get(key,"")
        if url:
            lines.append("- → [" + label + "](" + url + ") — " + desc)
        else:
            lines.append("- " + label + " — " + desc + " (建设中)")
    lines.append("")

    lines.append("---\n\n## 📊 第三层: 数据与原始资料\n")
    lines.append("→ [数据与资料索引](" + pages.get("layer3","") + ")\n")
    lines.append("---\n> 🤖 DealClaw · " + _now())
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
#  🚀 一键发布全部
# ═══════════════════════════════════════════════════════════

def publish_all(enterprise, sales_users=None):
    """一键生成三层全部页面。sales_users: [open_id, ...]"""
    pages = {}
    builders = [
        ("home","企业驾驶舱",build_homepage),
        ("profile","企业画像",build_profile),
        ("full","产品与解决方案",build_full),
        ("market","市场与国家",build_market),
        ("buyer","理想买家",build_buyer),
        ("sales","销售与营销",build_sales),
    ]
    for key, label, builder in builders:
        title = enterprise + " · " + label
        content = builder(enterprise)
        url = publish(title, content, enterprise if key == "home" else "")
        pages[key] = url or ""
        status = "✅" if url else "❌"
        print("  " + status + " " + label + ": " + (url or "失败"))

    # Layer3: Boss + Sales 两版
    boss_content = build_layer3(enterprise, user_open_id="")
    boss_url = publish(enterprise + " · 运营数据 (管理员)", boss_content, enterprise)
    pages["layer3_boss"] = boss_url or ""
    print("  " + ("✅" if boss_url else "❌") + " 运营数据(管理员): " + (boss_url or "失败"))

    sales_pages = []
    if sales_users:
        for uid in sales_users:
            sales_content = build_layer3(enterprise, user_open_id=uid)
            sales_url = publish(enterprise + " · 我的工作台", sales_content, enterprise="",
                               grant_to=uid)
            sales_pages.append((uid, sales_url or ""))
            print("  " + ("✅" if sales_url else "❌") + " 销售工作台(" + uid[-6:] + "): " + (sales_url or "失败"))
    pages["layer3_sales"] = sales_pages

    # 总目录
    master_pages = dict(pages)
    master_pages["layer3"] = boss_url
    index_content = build_master_index(enterprise, master_pages)
    index_url = publish(enterprise + " · 知识库目录", index_content, enterprise)
    pages["index"] = index_url or ""
    print("  " + ("✅" if index_url else "❌") + " 总目录: " + (index_url or "失败"))
    return pages

# ═══════════════════════════════════════════════════════════
#  CLI
# ═══════════════════════════════════════════════════════════

def publish(title, content, enterprise="", grant_to=""):
    """创建飞书文档。grant_to: 额外授权的 open_id (销售个人)"""
    import subprocess
    result = subprocess.run(
        ["lark-cli", "docs", "+create", "--title", title, "--content", content, "--as", "bot"],
        capture_output=True, text=True, timeout=15
    )
    if result.returncode == 0 and result.stdout:
        data = json.loads(result.stdout)
        if data.get("ok"):
            doc_token = data["data"]["document"]["document_id"]
            url = data["data"]["document"]["url"]
            # 自动给田耕郡加权限
            subprocess.run(
                ["lark-cli", "drive", "permission.members", "create",
                 "--token", doc_token, "--type", "docx",
                 "--data", '{"member_id":"ou_2b516abcb05aa539ff0056bc839d3d3a","member_type":"openid","perm":"full_access"}',
                 "--yes", "--as", "bot"],
                capture_output=True, timeout=10
            )
            # 如果指定了单独授权用户(销售个人)
            if grant_to and grant_to != "ou_2b516abcb05aa539ff0056bc839d3d3a":
                subprocess.run(
                    ["lark-cli", "drive", "permission.members", "create",
                     "--token", doc_token, "--type", "docx",
                     "--data", f'{{"member_id":"{grant_to}","member_type":"openid","perm":"full_access"}}',
                     "--yes", "--as", "bot"],
                    capture_output=True, timeout=10
                )
            # 保存到KB
            if enterprise:
                from dc_kb_engine import KBEngine
                kb = KBEngine().ensure(enterprise)
                kb["_feishu_doc_url"] = url
                KBEngine()._save(enterprise, kb)
            return url
    print(f"发布失败: {result.stderr[:200]}", file=sys.stderr)
    return None


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: home|full|profile|buyer|market|sales|layer3|all <enterprise>")
        print("      all solarunis.com      一键发布全部三层")
        sys.exit(1)

    cmd, ent = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "solarunis.com"

    if cmd == "all":
        pages = publish_all(ent)
        sys.exit(0)

    builders = {"home": build_homepage, "full": build_full, "profile": build_profile,
                "buyer": build_buyer, "market": build_market, "sales": build_sales, "layer3": build_layer3}
    if cmd not in builders:
        print(f"未知命令: {cmd}")
        sys.exit(1)

    content_text = builders[cmd](ent)
    url = publish(f"{ent} · 知识库", content_text, ent)
    if url:
        print(url)
