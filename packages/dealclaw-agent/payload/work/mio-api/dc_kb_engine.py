#!/usr/bin/env python3
"""
DC-KB v2 — DealClaw 统一知识库引擎

每个企业一个知识库文件: data/memory/{supplier_id}/kb.json

六模块:
  🏢 profile     企业画像 (analyze-company)
  👤 persona     买家画像 (导入+标注累积)
  📦 products    产品库 (结构化产品线)
  📋 materials   物料库 (销售材料清单)
  🧠 competitive 竞争情报 (OS策略)
  💬 iq_memory   交互记忆 (IQ对话学习)

用法:
  python3 dc_kb_engine.py show solarunis.com         # 完整知识库
  python3 dc_kb_engine.py products solarunis.com     # 产品库
  python3 dc_kb_engine.py persona solarunis.com      # 买家画像
  python3 dc_kb_engine.py materials solarunis.com    # 物料清单
"""

import json, os, re, sys
from datetime import datetime, timezone
from pathlib import Path

# 画像/知识库 canonical 统一进 data/memory/<企业>/kb.json（与线索/邮件/信号同目录）
KB_DIR = Path(__file__).resolve().parents[2] / "data" / "memory"
DEFAULT_MATERIAL_TYPES = ["catalog", "price", "spec", "certificate", "sample", "case_study", "video"]
MATERIAL_LABELS = {
    "catalog": "产品目录", "price": "报价单", "spec": "技术规格",
    "certificate": "认证/证书", "sample": "样品/实拍",
    "case_study": "案例/项目", "video": "产品视频",
}

# ── helpers ──
def _slug(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _resolve_supplier_id() -> str:
    """单租户 supplier id：动态从 MIO_CDP_SUPPLIER_ID 环境变量 / .env 读（不做硬编码占位）。"""
    sid = os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()
    if sid:
        return sid
    env_path = Path(__file__).resolve().parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("MIO_CDP_SUPPLIER_ID="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""

def _now():
    return datetime.now(timezone.utc).isoformat()

# ── 空知识库模板 ──
def empty_kb(enterprise):
    return {
        "enterprise": enterprise,
        "version": 1,
        "created_at": _now(),
        "updated_at": _now(),
        "profile": {},
        "persona": {
            "country": {}, "keywords": {}, "buyer_type": {}, "product_pattern": {},
            "exclude_countries": [], "exclude_reasons": [],
            "version": 0, "updated_at": "", "sources": [], "evolution": [],
        },
        "products": [],
        "materials": {t: {"name": "", "description": "", "link": "", "status": "missing", "updated_at": ""}
                      for t in DEFAULT_MATERIAL_TYPES},
        "competitive": {"positioning": "", "competitors": [], "entry_angles": [], "os_updated": ""},
        "iq_memory": {"total_interactions": 0, "common_questions": [], "buyer_objections": [],
                      "last_interaction": ""},
    }


class KBEngine:
    def __init__(self):
        os.makedirs(str(KB_DIR), exist_ok=True)
        self._cache = {}
        self._audit = None

    def _audit_log(self, action, enterprise, target, detail):
        try:
            if self._audit is None:
                from dc_audit import AuditLog
                self._audit = AuditLog()
            self._audit.log(action, user_open_id="system", enterprise=enterprise,
                            target=target, detail=detail)
        except Exception:
            from dc_degrade import degrade
            degrade.decide("audit_write", enterprise=enterprise)

    def _key(self, enterprise):
        sid = _resolve_supplier_id()
        if sid:
            return sid  # 单租户：路径统一用 supplier id，不用网址/企业名 slug
        return _slug(enterprise)

    def _path(self, enterprise):
        return KB_DIR / self._key(enterprise) / "kb.json"

    def _load(self, enterprise):
        key = self._key(enterprise)
        if key in self._cache:
            return self._cache[key]
        path = self._path(enterprise)
        if path.exists():
            kb = json.loads(path.read_text())
            self._cache[key] = kb
            return kb
        return None

    def _save(self, enterprise, kb):
        key = self._key(enterprise)
        kb["updated_at"] = _now()
        kb["version"] = kb.get("version", 1) + 1
        self._cache[key] = kb
        path = self._path(enterprise)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(kb, ensure_ascii=False, indent=2))

    def ensure(self, enterprise):
        """确保企业 KB 存在，不存在则创建空模板"""
        kb = self._load(enterprise)
        if kb is None:
            kb = empty_kb(enterprise)
            self._save(enterprise, kb)
            self._audit_log("kb.create", enterprise, enterprise, "知识库初始化")
        return kb

    # ═══════════════════════════════════════════════════════
    #  🏢 企业画像
    # ═══════════════════════════════════════════════════════

    def seed_profile(self, enterprise, profile_data):
        """从 analyze-company 写入企业画像，同时自动播种买家画像。

        兼容两套字段：新字段（analyze-company Document Fields）+ 旧 CBIE 字段（历史兼容）（enterprise_external/usp 等）。
        """
        kb = self.ensure(enterprise)
        p = profile_data or {}
        # 公司名：新 key name / name_en，旧 key enterprise_external / enterprise_internal
        _name = (p.get("name")
                 or p.get("enterprise_internal")
                 or p.get("enterprise_external")
                 or p.get("company_name") or "")
        _name_en = (p.get("name_en")
                    or p.get("enterprise_external")
                    or p.get("company_name_en") or "")
        _product = (p.get("product")
                    or p.get("products")
                    or ((", ".join(p["products"]) if isinstance(p.get("products"), list) else "")) or "")
        incoming = {
            "name": _name,
            "name_en": _name_en,
            "product": _product,
            "products": p.get("products", []) if isinstance(p.get("products", []), list) else ([x.strip() for x in str(_product).split(",") if x.strip()] if _product else []),
            "usp": p.get("usp") or p.get("advantage", ""),
            "certifications": p.get("certifications") or "",
            "target_markets": p.get("target_markets") or [],
            "founded": p.get("founded", "") or p.get("year_founded", ""),
            "company_type": p.get("company_type") or p.get("enterprise_type", ""),
            "business_model": p.get("business_model", ""),
            "customization": p.get("customization", ""),
            "scale": p.get("scale") or p.get("company_type") or p.get("employees", ""),
            "source": p.get("source") or p.get("data_source", ""),
        }
        # 非破坏合并（2026-09-17）：analyze-company 不得覆盖日常沉淀出来的画像。
        # 过去这里是整块赋值，会把 dc_profile_learn 积累的字段冲掉。
        try:
            from dc_profile_learn import merge_profile  # noqa: PLC0415
            merged, _changed, _skipped = merge_profile(kb.get("profile") or {}, incoming)
        except Exception:  # noqa: BLE001
            merged = {**(kb.get("profile") or {}), **incoming}
        if not merged.get("source"):
            merged["source"] = incoming.get("source") or ""
        merged["updated"] = _now()
        kb["profile"] = merged
        self._save(enterprise, kb)
        self._audit_log("kb.profile", enterprise, enterprise, f"画像更新: {kb['profile'].get('name','')[:30]}")
        # 🔄 回路1: analyze-company → Persona — 自动播种买家画像
        markets = p.get("target_markets") or []
        if markets:
            incoming = {"country": {m: 0.5/len(markets) for m in markets[:8]}}
            self.update_persona(enterprise, incoming, source="analyze_auto", weight=0.3,
                               change=f"企业画像更新→买家画像自动播种: {', '.join(markets[:4])}")

    # ═══════════════════════════════════════════════════════
    #  👤 买家画像
    # ═══════════════════════════════════════════════════════

    def get_persona(self, enterprise):
        kb = self.ensure(enterprise)
        return kb.get("persona", {})

    def update_persona(self, enterprise, incoming, source="annotate", weight=0.08, change=""):
        """融合新数据进画像。weight=1.0 用于批量导入。"""
        kb = self.ensure(enterprise)
        base = kb.get("persona", empty_kb(enterprise)["persona"])

        for field in ("country", "keywords", "buyer_type", "product_pattern"):
            merged = {}
            all_keys = set(base.get(field, {}).keys()) | set(incoming.get(field, {}).keys())
            for k in all_keys:
                bv = base.get(field, {}).get(k, 0)
                iv = incoming.get(field, {}).get(k, 0)
                merged[k] = round(bv * (1 - weight) + iv * weight, 3)
            base[field] = {k: v for k, v in merged.items() if v > 0.001}

        base["exclude_countries"] = list(set(base.get("exclude_countries", []) + incoming.get("exclude_countries", [])))
        base["exclude_reasons"] = list(set(base.get("exclude_reasons", []) + incoming.get("exclude_reasons", [])))
        base["version"] = base.get("version", 0) + 1
        base["updated_at"] = _now()
        base["sources"] = base.get("sources", []) + [source]

        if "evolution" not in base:
            base["evolution"] = []
        base["evolution"].append({
            "version": base["version"], "source": source,
            "at": _now(), "change": change[:120],
        })

        kb["persona"] = base
        self._save(enterprise, kb)

    # ═══════════════════════════════════════════════════════
    #  📦 产品库
    # ═══════════════════════════════════════════════════════

    def add_product(self, enterprise, product_id, data):
        """添加/更新一条产品"""
        kb = self.ensure(enterprise)
        existing = [i for i, p in enumerate(kb["products"]) if p.get("id") == product_id]
        entry = {
            "id": product_id,
            "name": data.get("name", product_id),
            "category": data.get("category", ""),
            "specs": data.get("specs", {}),
            "pricing": data.get("pricing", {}),
            "target_markets": data.get("target_markets", []),
            "certifications": data.get("certifications", []),
            "lead_time": data.get("lead_time", ""),
            "updated_at": _now(),
        }
        if existing:
            kb["products"][existing[0]] = entry
        else:
            kb["products"].append(entry)
        self._save(enterprise, kb)
        return entry

    def get_products(self, enterprise):
        kb = self.ensure(enterprise)
        return kb.get("products", [])

    def find_product_for_iq(self, enterprise, keywords):
        """IQ 用：根据买家需求匹配最相关的产品"""
        kb = self.ensure(enterprise)
        products = kb.get("products", [])
        if not products:
            return None
        # 简单关键词匹配
        scores = []
        for p in products:
            text = f"{p.get('name','')} {p.get('category','')} {' '.join(p.get('specs',{}).values())}".lower()
            score = sum(1 for kw in keywords if kw.lower() in text)
            if score > 0:
                scores.append((score, p))
        if scores:
            scores.sort(reverse=True)
            return scores[0][1]
        return products[0]

    # ═══════════════════════════════════════════════════════
    #  📋 物料库
    # ═══════════════════════════════════════════════════════

    def check_materials(self, enterprise, types=None):
        kb = self.ensure(enterprise)
        mats = kb.get("materials", {})
        types = types or DEFAULT_MATERIAL_TYPES
        return {t: mats.get(t, {}) for t in types if mats.get(t, {}).get("status") == "ready"}

    def missing_materials(self, enterprise, types=None):
        kb = self.ensure(enterprise)
        mats = kb.get("materials", {})
        types = types or [t for t in DEFAULT_MATERIAL_TYPES if t not in ("case_study", "video")]
        return [t for t in types if mats.get(t, {}).get("status") != "ready"]

    def set_material(self, enterprise, mtype, name="", description="", link=""):
        kb = self.ensure(enterprise)
        if "materials" not in kb:
            kb["materials"] = {}
        kb["materials"][mtype] = {
            "name": name or MATERIAL_LABELS.get(mtype, mtype),
            "description": description, "link": link,
            "status": "ready", "updated_at": _now(),
        }
        self._save(enterprise, kb)
        # 双写：同步物料到 data/memory/<企业>/materials.json（agent 读卡片/发营销内容用）
        try:
            mats_path = self._path(enterprise).parent / "materials.json"
            mats_path.write_text(json.dumps(kb.get("materials", {}), ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def seed_materials_from_company_analysis(self, enterprise, profile):
        """从企业分析自动播种物料"""
        kb = self.ensure(enterprise)
        mats = kb.get("materials", {})
        cert = profile.get("certifications") or profile.get("certificate")
        product = profile.get("product") or profile.get("main_product")
        changed = False
        if cert and mats.get("certificate", {}).get("status") != "ready":
            kb["materials"]["certificate"] = {"name": "认证资质", "description": cert, "link": "", "status": "ready", "updated_at": _now()}
            changed = True
        if product and mats.get("spec", {}).get("status") != "ready":
            kb["materials"]["spec"] = {"name": "主营产品概述", "description": product, "link": "", "status": "ready", "updated_at": _now()}
            changed = True
        if changed:
            self._save(enterprise, kb)
            self._audit_log("kb.seed", enterprise, enterprise, f"analyze-company→KB auto-seed")

    def summary_for_iq(self, enterprise):
        kb = self.ensure(enterprise)
        ready = [MATERIAL_LABELS.get(t, t) for t in DEFAULT_MATERIAL_TYPES
                 if kb.get("materials", {}).get(t, {}).get("status") == "ready"]
        if not ready:
            return ""
        return "We have " + ", ".join(ready[:-1]) + (" and " + ready[-1] if len(ready) > 1 else ready[0]) + " ready to share."

    def get_material_links(self, enterprise):
        """返回所有就绪物料的名称和链接，供 Copy/IQ 引擎调用"""
        kb = self.ensure(enterprise)
        mats = kb.get("materials", {})
        result = []
        for mt in ["catalog", "price", "spec", "certificate", "sample", "case_study", "video"]:
            m = mats.get(mt, {})
            if m.get("status") == "ready":
                result.append({
                    "type": mt,
                    "label": MATERIAL_LABELS.get(mt, mt),
                    "name": m.get("name", ""),
                    "link": m.get("link", ""),
                    "description": m.get("description", "")[:100],
                })
        return result

    # ── 向后兼容别名 ──
    def seed_from_company_analysis(self, enterprise_key, profile):
        """向后兼容: 企业分析 → KB 播种物料 + 画像"""
        self.seed_materials_from_company_analysis(enterprise_key, profile)
        self.seed_profile(enterprise_key, profile)

    # ═══════════════════════════════════════════════════════
    #  🧠 竞争情报
    # ═══════════════════════════════════════════════════════

    def set_competitive(self, enterprise, data):
        kb = self.ensure(enterprise)
        kb["competitive"] = {
            "positioning": data.get("positioning", ""),
            "competitors": data.get("competitors", []),
            "entry_angles": data.get("entry_angles", []),
            "os_updated": _now(),
        }
        self._save(enterprise, kb)

    def get_entry_angle(self, enterprise, buyer_country=""):
        """生成交互式知识图谱 HTML — 拖拽/点击/编辑/新增"""
        kb = self.ensure(enterprise)
        p = kb.get("persona", {})
        products = kb.get("products", [])
        comp = kb.get("competitive", {})
        iq = kb.get("iq_memory", {})
        profile = kb.get("profile", {})
        mats = kb.get("materials", {})
        e_name = profile.get("name", enterprise)

        nodes = []
        edges = []
        nid = 0
        def N(label, group="", info=""):
            nonlocal nid; nid+=1
            return {"id":nid,"label":label,"group":group,"title":info[:200]}
        def E(f,t,label=""):
            return {"from":f,"to":t,"label":label}

        # 中心节点
        center = N(e_name, "enterprise", f"{profile.get('usp','')[:100]}\n定位: {comp.get('positioning','')[:100]}")
        nodes.append(center)

        # 产品
        for prod in products:
            pnode = N(prod["name"], "product",
                f"价格: {prod.get('pricing',{}).get('fob','—')}\n"
                f"规格: {', '.join(f'{k}:{v}' for k,v in list(prod.get('specs',{}).items())[:5])}\n"
                f"市场: {', '.join(prod.get('target_markets',[])[:4])}")
            nodes.append(pnode)
            edges.append(E(center["id"], pnode["id"]))

            for mkt in prod.get("target_markets", [])[:3]:
                mn = N(mkt, "market", f"{prod['name']} 目标市场: {mkt}")
                nodes.append(mn)
                edges.append(E(pnode["id"], mn["id"], "目标"))

        # 买家画像
        persona_node = N("买家画像", "persona",
            f"v{p.get('version',0)} · {len(p.get('evolution',[]))}次进化\n"
            f"国家: {', '.join(f'{k} {v:.0%}' for k,v in list(p.get('country',{}).items())[:6])}\n"
            f"类型: {', '.join(p.get('buyer_type',{}).keys())}")
        nodes.append(persona_node)
        edges.append(E(center["id"], persona_node["id"]))

        for c, w in list(p.get("country", {}).items())[:6]:
            cn = N(f"{c} {w:.0%}", "country", f"{c} 市场权重 {w:.0%}\n历史成交占比")
            nodes.append(cn)
            edges.append(E(persona_node["id"], cn["id"], f"{w:.0%}"))

        for t in list(p.get("buyer_type", {}).keys())[:4]:
            tn = N(t, "buyer_type", f"买家类型: {t}")
            nodes.append(tn)
            edges.append(E(persona_node["id"], tn["id"]))

        # 竞品
        comp_node = N("竞品格局", "competitor", comp.get("positioning", "")[:100])
        nodes.append(comp_node)
        edges.append(E(center["id"], comp_node["id"]))

        for c in comp.get("competitors", [])[:5]:
            cn = N(c["name"], "competitor",
                f"弱点: {c.get('weakness','—')}\n优势: {c.get('advantage','—')}")
            nodes.append(cn)
            edges.append(E(comp_node["id"], cn["id"], c.get("weakness","")[:15]))

        # IQ
        if iq.get("total_interactions", 0) > 0:
            iq_node = N("IQ记忆", "iq", f"{iq.get('total_interactions',0)} 次交互")
            nodes.append(iq_node)
            edges.append(E(center["id"], iq_node["id"]))
            for q in iq.get("common_questions", [])[:5]:
                qn = N(q["question"][:25]+"…", "iq", f"问了 {q['count']} 次\n{q['question'][:150]}")
                nodes.append(qn)
                edges.append(E(iq_node["id"], qn["id"], f"×{q['count']}"))

        # 物料
        mat_node = N("物料清单", "material", f"{sum(1 for m in mats.values() if m.get('status')=='ready')}/7 项就绪")
        nodes.append(mat_node)
        edges.append(E(center["id"], mat_node["id"]))
        labels = {"catalog":"目录","price":"报价","spec":"规格","certificate":"认证","sample":"样品","case_study":"案例","video":"视频"}
        for mtype, m in sorted(mats.items()):
            icon = "✅" if m.get("status")=="ready" else "⬜"
            mn = N(f"{icon} {labels.get(mtype,mtype)}", "material",
                f"{m.get('name','')[:60]}\n{m.get('description','')[:100]}")
            nodes.append(mn)
            edges.append(E(mat_node["id"], mn["id"]))

        nodes_json = json.dumps(nodes, ensure_ascii=False)
        edges_json = json.dumps(edges, ensure_ascii=False)

        return f'''<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><title>{e_name} · 交互知识图谱</title>
<script src="https://unpkg.com/vis-network@9.1.6/dist/vis-network.min.js"></script>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,system-ui,sans-serif;overflow:hidden;display:flex;height:100vh}}
#graph{{flex:1}}
#info{{width:320px;background:#fff;border-left:1px solid #ddd;padding:20px;overflow-y:auto;display:none}}
#info.active{{display:block}}
#info h3{{font-size:16px;margin-bottom:8px}}
#info .meta{{font-size:13px;color:#666;line-height:1.8;white-space:pre-wrap}}
#info .edit-btn{{margin-top:12px;padding:6px 16px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px}}
#info .edit-area{{display:none;margin-top:8px}}
#info .edit-area textarea{{width:100%;height:100px;border:1px solid #ddd;border-radius:6px;padding:8px;font-size:13px;font-family:inherit;resize:vertical}}
#info .edit-area button{{margin-top:6px;padding:4px 12px;background:#34a853;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-right:6px;font-size:12px}}
.toolbar{{position:absolute;top:12px;left:12px;z-index:10;display:flex;gap:8px}}
.toolbar button{{padding:6px 14px;background:#fff;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;box-shadow:0 1px 3px rgba(0,0,0,.1)}}
.toolbar button:hover{{background:#f0f0f0}}
.legend{{position:absolute;bottom:16px;left:16px;z-index:10;background:#fff;padding:10px 14px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.1);font-size:12px;display:flex;flex-wrap:wrap;gap:10px}}
.legend span{{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}}
</style></head>
<body>
<div class="toolbar">
  <button onclick="network.fit()">🔍 适应窗口</button>
  <button onclick="addNode()">➕ 新增节点</button>
  <button onclick="exportData()">📥 导出</button>
</div>
<div id="graph"></div>
<div id="info">
  <h3 id="info-title"></h3>
  <div class="meta" id="info-meta"></div>
  <button class="edit-btn" onclick="toggleEdit()">✏️ 编辑</button>
  <div class="edit-area" id="edit-area">
    <textarea id="edit-text"></textarea>
    <button onclick="saveEdit()">保存</button>
    <button onclick="cancelEdit()" style="background:#999">取消</button>
  </div>
</div>
<div class="legend">
  <span style="background:#1a73e8"></span>企业
  <span style="background:#34a853"></span>产品
  <span style="background:#fbbc04"></span>画像
  <span style="background:#ea4335"></span>竞品
  <span style="background:#9c27b0"></span>IQ
  <span style="background:#00acc1"></span>物料
  <span style="background:#78909c"></span>市场
</div>
<script>
const nodes = new vis.DataSet({nodes_json});
const edges = new vis.DataSet({edges_json});
const container = document.getElementById('graph');
const data = {{nodes, edges}};
const options = {{
  groups: {{
    enterprise: {{color:{{background:'#1a73e8',border:'#0d47a1'}},font:{{color:'#fff',size:15}}}},
    product: {{color:{{background:'#34a853',border:'#1e7e34'}},font:{{color:'#fff'}}}},
    persona: {{color:{{background:'#fbbc04',border:'#f9a825'}},font:{{color:'#333'}}}},
    competitor: {{color:{{background:'#ea4335',border:'#c62828'}},font:{{color:'#fff'}}}},
    iq: {{color:{{background:'#9c27b0',border:'#6a1b9a'}},font:{{color:'#fff'}}}},
    material: {{color:{{background:'#00acc1',border:'#00838f'}},font:{{color:'#fff'}}}},
    market: {{color:{{background:'#78909c',border:'#546e7a'}},font:{{color:'#fff'}}}},
    country: {{color:{{background:'#ff9800',border:'#e65100'}},font:{{color:'#fff'}}}},
    buyer_type: {{color:{{background:'#8d6e63',border:'#5d4037'}},font:{{color:'#fff'}}}},
  }},
  physics: {{solver:'forceAtlas2Based',forceAtlas2Based:{{gravitationalConstant:-40,centralGravity:0.005,springLength:150,springConstant:0.08}}}},
  interaction: {{hover:true,tooltipDelay:200,navigationButtons:true,keyboard:true}},
  edges: {{arrows:'to',smooth:{{type:'cubicBezier'}},font:{{size:10,color:'#666'}}}},
}};
const network = new vis.Network(container, data, options);
let selectedNode = null;

network.on('click', function(params) {{
  if (params.nodes.length > 0) {{
    const node = nodes.get(params.nodes[0]);
    selectedNode = node;
    document.getElementById('info').classList.add('active');
    document.getElementById('info-title').textContent = node.label;
    document.getElementById('info-meta').textContent = node.title || '(无详细信息)';
    document.getElementById('edit-text').value = node.title || '';
    document.getElementById('edit-area').style.display = 'none';
  }} else {{
    document.getElementById('info').classList.remove('active');
    selectedNode = null;
  }}
}});

function toggleEdit() {{
  const area = document.getElementById('edit-area');
  const btn = document.querySelector('.edit-btn');
  if (area.style.display === 'block') {{
    area.style.display = 'none';
    btn.textContent = '✏️ 编辑';
  }} else {{
    area.style.display = 'block';
    btn.textContent = '收起编辑';
  }}
}}

function saveEdit() {{
  if (!selectedNode) return;
  const newTitle = document.getElementById('edit-text').value;
  nodes.update({{id: selectedNode.id, title: newTitle}});
  document.getElementById('info-meta').textContent = newTitle;
  document.getElementById('edit-area').style.display = 'none';
  document.querySelector('.edit-btn').textContent = '✏️ 编辑';
}}

function cancelEdit() {{
  document.getElementById('edit-text').value = selectedNode ? selectedNode.title : '';
  document.getElementById('edit-area').style.display = 'none';
  document.querySelector('.edit-btn').textContent = '✏️ 编辑';
}}

let addCount = 1;
function addNode() {{
  const label = prompt('节点名称:', '新节点 ' + addCount);
  if (!label) return;
  const group = prompt('类型 (product/persona/competitor/material/iq/market):', 'product');
  const info = prompt('详情:', '');
  nodes.add({{id: Date.now(), label: label, group: group || 'product', title: info || ''}});
  addCount++;
}}

function exportData() {{
  const allNodes = nodes.get();
  const allEdges = edges.get();
  const exportObj = {{nodes: allNodes.map(n=>({{label:n.label,group:n.group,info:n.title}})), edges: allEdges.map(e=>{{const f=allNodes.find(n=>n.id===e.from);const t=allNodes.find(n=>n.id===e.to);return{{from:f?f.label:e.from,to:t?t.label:e.to,label:e.label}}}})}};
  const blob = new Blob([JSON.stringify(exportObj,null,2)],{{type:'application/json'}});
  const a = document.createElement('a');a.href=URL.createObjectURL(blob);a.download='dealclaw_graph.json';a.click();
}}
</script>
</body></html>'''

    # ═══════════════════════════════════════════════════════
    #  🗺️ 知识图谱
    # ═══════════════════════════════════════════════════════

    def to_strategic_dashboard(self, enterprise):
        """用户视角战略看板 — 支持编辑模式"""
        kb = self.ensure(enterprise)
        p = kb.get("persona", {})
        products = kb.get("products", [])
        mats = kb.get("materials", {})
        comp = kb.get("competitive", {})
        iq = kb.get("iq_memory", {})
        profile = kb.get("profile", {})
        e_name = profile.get("name", enterprise)
        ins = []
        if products:
            ins.append(f'你的{products[0]["name"]}卖到{"/".join(products[0].get("target_markets",["?"])[:2])}，定价{products[0].get("pricing",{}).get("fob","?")}')
        if comp.get("competitors"):
            ins.append(f'在{comp.get("positioning","你的市场")[:20]}，{comp["competitors"][0]["name"]}的弱点是{comp["competitors"][0].get("weakness","?")}')
        missing = ["样品","案例","视频"]
        if mats.get("case_study",{}).get("status")!="ready": missing.append("案例")
        ins.append(f'缺{"/".join(missing[:3])}，问了{iq.get("total_interactions",0)}次没准备')
        mrows = ""
        for prod in products[:4]:
            mkts = ", ".join(prod.get("target_markets",[])[:4]) or "—"
            pid = prod.get("id","")
            btn = f"""<button onclick="del('p','{pid}')">🗑</button>"""
            pid = prod.get("id","")
            mrows += "<tr data-pid=" + pid + "><td><strong class=ed>" + prod["name"] + "</strong></td><td class=ed>" + prod.get("pricing",{}).get("fob","—") + "</td><td class=ed>" + mkts + "</td><td class=ea><button onclick=delP('" + pid + "')>🗑</button></td></tr>"

        cc = ""
        for i, c in enumerate(comp.get("competitors",[])):
            cc += f'<div class="cr" data-cidx="{i}"><div class="cn ed">{c["name"]}</div><div class="cw ed">弱点: {c.get("weakness","—")[:60]}</div><div class="ca ed">优势: {c.get("advantage","—")[:60]}</div><button onclick="del(\'c\',{i})" class="ea">🗑</button></div>'
        mr = ""
        lb = {"catalog":"目录","price":"报价","spec":"规格","certificate":"认证","sample":"样品","case_study":"案例","video":"视频"}
        for mt in ["catalog","price","spec","certificate","sample","case_study","video"]:
            m = mats.get(mt,{})
            icon = "✅" if m.get("status")=="ready" else "⬜"
            nm = m.get("name","") or lb.get(mt,mt)
            mr += f'<tr data-mtype="{mt}"><td onclick="tgm(\'{mt}\')" style="cursor:pointer">{icon}</td><td class="ed">{nm[:40]}</td></tr>'
        cb = ""
        mw = max(p.get("country",{}).values()) if p.get("country") else 1
        for c, w in list(p.get("country",{}).items())[:6]:
            cb += f'<div class="c-bar"><div class="cf">{c}</div><div class="ct"><div class="cfi" style="width:{int(w/max(mw,1)*100)}%"></div></div><div class="cp">{w:.0%}</div></div>'
        iqit = "".join(f'<div class="iq-q">🔹 {q["question"][:70]} <span>×{q["count"]}</span></div>' for q in iq.get("common_questions",[])[:5])
        ang = "".join(f'<li class="ed">{a}</li>' for a in comp.get("entry_angles",[])[:4])
        return f'''<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{e_name} · 战略看板</title>
<style>*{{margin:0;padding:0;box-sizing:border-box}}body{{font-family:system-ui,sans-serif;background:#f5f5f5;color:#222}}header{{background:linear-gradient(135deg,#1a237e,#0d47a1);color:#fff;padding:24px 32px;display:flex;justify-content:space-between;align-items:center}}header h1{{font-size:22px}}header .sub{{opacity:.8;font-size:13px;margin-top:4px}}#et{{background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.3);padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px}}#et.active{{background:#ff9800}}#et:hover{{background:rgba(255,255,255,.3)}}.ins{{display:flex;gap:12px;padding:14px 32px;background:#1a237e;flex-wrap:wrap}}.ins>div{{flex:1;min-width:200px;background:rgba(255,255,255,.12);border-radius:8px;padding:12px 14px;color:#fff;font-size:13px}}.grid{{display:grid;grid-template-columns:2fr 1fr;gap:14px;padding:16px 32px;max-width:1200px;margin:0 auto}}.card{{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)}}.card h3{{padding:12px 16px;border-bottom:1px solid #eee;font-size:14px;display:flex;justify-content:space-between;align-items:center}}table{{width:100%;border-collapse:collapse;font-size:13px}}td,th{{padding:8px 12px;text-align:left;border-bottom:1px solid #f0f0f0}}th{{color:#888;font-size:11px}}.c-bar{{display:flex;align-items:center;gap:8px;margin:6px 0}}.cf{{width:32px;font-weight:700;font-size:13px}}.ct{{flex:1;height:10px;background:#eee;border-radius:5px;overflow:hidden}}.cfi{{height:100%;background:linear-gradient(90deg,#f9a825,#ff6f00);border-radius:5px}}.cp{{width:36px;text-align:right;font-size:11px;color:#888}}.cr{{padding:8px 0;border-bottom:1px solid #f5f5f5}}.cn{{font-weight:600;font-size:13px}}.cw,.ca{{font-size:11px;margin-top:2px;color:#666}}.iq-q{{font-size:12px;padding:5px 0;border-bottom:1px solid #fafafa}}.iq-q span{{color:#999}}.ea button{{display:none;font-size:12px;background:none;border:1px solid #ddd;border-radius:3px;cursor:pointer;padding:2px 6px}}.editing .ea button{{display:inline-block}}.editing .ed{{border:1px dashed #ccc;border-radius:4px;padding:3px 6px;background:#fffef5;cursor:text}}.editing .add-b{{display:inline-block}}.add-b{{display:none;font-size:11px;color:#1a73e8;cursor:pointer;margin-top:6px;border:none;background:none}}#sv{{display:none;position:fixed;bottom:18px;right:18px;background:#fff;padding:14px 20px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.15);z-index:1000;align-items:center;gap:10px}}#sv.show{{display:flex}}#sv span{{font-size:12px;color:#888}}#sv button{{padding:7px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:600}}#sv .prim{{background:#34a853;color:#fff}}#sv .sec{{background:#eee;color:#666}}.footer{{text-align:center;color:#bbb;font-size:11px;padding:20px}}</style></head><body>
<header><div><h1>🏢 {e_name}</h1><div class="sub">{profile.get('product','')[:80] or '产品信息待补充'}</div></div><button id="et" onclick="te()">✏️ 编辑模式</button></header>
<div class="ins">{''.join(f'<div>{["🎯","🧠","⚠️"][i] if i<3 else "💡"} {s}</div>' for i,s in enumerate(ins[:4]))}</div>
<div class="grid">
<div class="card"><h3>📦 产品<button class="add-b" onclick="ap()">+ 添加</button></h3>
<table><tr><th>产品</th><th>定价</th><th>市场</th><th class="ea"></th></tr>{mrows}</table></div>
<div class="card"><h3>👤 买家画像</h3><div style="padding:12px 16px">{cb}<div style="margin-top:10px;font-size:12px">买家类型: {", ".join(p.get('buyer_type',{}).keys()) or "—"}</div></div></div>
<div class="card"><h3>🧠 竞争情报<button class="add-b" onclick="ac()">+ 添加</button></h3><div style="padding:12px 16px"><p class="ed" data-field="pos" style="font-size:12px;margin-bottom:10px;color:#555">{comp.get('positioning','')[:120] or "—"}</p>{cc}</div></div>
<div class="card"><h3>📋 物料</h3><table>{mr}</table></div>
<div class="card"><h3>🎯 切入策略</h3><div style="padding:8px 16px"><ul style="font-size:12px">{ang or '<li style="color:#999">暂无</li>'}</ul></div></div>
<div class="card"><h3>💬 买家常问</h3><div style="padding:8px 16px">{iqit or '<div style="color:#999;font-size:12px">暂无互动</div>'}</div></div>
</div>
<div id="sv"><span id="cc">0处更改</span><button class="sec" onclick="te()">取消</button><button class="prim" onclick="save()">💾 导出脚本</button></div>
<div class="footer">DealClaw · {kb.get('version',1)}次迭代</div>
<script>
let ed=false,ch={{}};
function te(){{ed=!ed;document.body.classList.toggle('editing',ed);const b=document.getElementById('et');b.classList.toggle('active',ed);b.textContent=ed?'✅ 完成':'✏️ 编辑模式';document.getElementById('sv').classList.toggle('show',ed);if(!ed){{ch={{}};uc()}}}}
function rc(el){{const k=el.dataset.field||el.closest('[data-pid]')?.dataset.pid||'';ch[k]=(ch[k]||0)+1;uc()}}
function uc(){{document.getElementById('cc').textContent=Object.keys(ch).length+'处更改'}}
document.querySelectorAll('.ed').forEach(e=>{{e.addEventListener('input',()=>rc(e));e.addEventListener('blur',()=>rc(e))}});
function ap(){{const n=prompt('产品名:');if(!n)return;const t=document.querySelector('table');const r=t.insertRow(-1);r.innerHTML=`<td class="ed">${{n}}</td><td class="ed">—</td><td class="ed">—</td><td class="ea"><button onclick="this.closest(\'tr\').remove()">🗑</button></td>`;rc({{dataset:n}})}}
function ac(){{const d=document.querySelector('.cr');if(!d)return;const c=d.cloneNode(true);c.querySelector('.cn').textContent='新竞品';d.parentNode.insertBefore(c,d.nextSibling);rc({{dataset:'comp_'+Date.now()}})}}
function del(type,id){{if(!confirm('确认删除?'))return;const s=type=='p'?`tr[data-pid="${{id}}"]`:`div[data-cidx="${{id}}"]`;const e=document.querySelector(s);if(e)e.remove();rc({{dataset:type+'_'+id+'_del'}})}}
function tgm(mt){{if(!ed)return;alert('点击切换物料状态'+(mt))}}
function save(){{const s=['from dc_kb_engine import KBEngine','kb=KBEngine()',"kb.ensure('{enterprise}')"];document.querySelectorAll('.ed').forEach(e=>{{const t=e.textContent.trim();if(!t)return;const f=e.dataset.field;if(f)s.push(f"kb.ensure('{enterprise}')['competitive']['{{f}}']='{{t}}'")}});s.push('print("✅")');const b=new Blob([s.join('\\n')],{{type:'text/plain'}});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='update_kb.py';a.click()}}
</script></body></html>'''

    def to_html(self, enterprise):
        """生成自包含 HTML 知识库面板"""
        kb = self.ensure(enterprise)
        e = enterprise
        p = kb.get("persona", {})
        products = kb.get("products", [])
        mats = kb.get("materials", {})
        comp = kb.get("competitive", {})
        iq = kb.get("iq_memory", {})
        profile = kb.get("profile", {})

        # ── 产品卡片 ──
        product_cards = ""
        for prod in products:
            specs_html = "".join(f'<span class="tag">{k}: {v}</span>' for k, v in list(prod.get("specs", {}).items())[:5])
            markets = ", ".join(prod.get("target_markets", [])[:4])
            price = prod.get("pricing", {}).get("fob", "—")
            product_cards += f'''
            <div class="product-card">
              <h4>{prod["name"]}</h4>
              <div class="price">{price}</div>
              <div class="specs">{specs_html}</div>
              <div class="markets">🎯 {markets or "未设置"}</div>
            </div>'''

        # ── 国家条 ──
        country_bars = ""
        max_w = max(p.get("country", {}).values()) if p.get("country") else 1
        for c, w in list(p.get("country", {}).items())[:6]:
            pct = int(w / max(max_w, 1) * 100)
            country_bars += f'<div class="country-bar"><span class="country-label">{c}</span><div class="bar"><div class="fill" style="width:{pct}%"></div></div><span>{w:.0%}</span></div>'

        # ── 物料清单 ──
        material_items = ""
        labels = {"catalog":"产品目录","price":"报价单","spec":"技术规格","certificate":"认证","sample":"样品","case_study":"案例","video":"视频"}
        for mtype in ["catalog","price","spec","certificate","sample","case_study","video"]:
            m = mats.get(mtype, {})
            icon = "✅" if m.get("status") == "ready" else "⬜"
            name = m.get("name", "") or labels.get(mtype, mtype)
            material_items += f'<div class="mat-item">{icon} {name[:30]}</div>'

        # ── 竞品 ──
        comp_html = ""
        for c in comp.get("competitors", []):
            comp_html += f'<div class="comp-item"><strong>{c["name"]}</strong><br/>弱点: {c.get("weakness","—")}<br/>优势: {c.get("advantage","—")}</div>'

        return f'''<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><title>{e} · DealClaw 知识库</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,system-ui,sans-serif;background:#f0f2f5;padding:20px;color:#333}}
.header{{background:linear-gradient(135deg,#1a73e8,#0d47a1);color:#fff;padding:24px;border-radius:12px;margin-bottom:20px}}
.header h1{{font-size:22px;font-weight:600}}
.header .usp{{opacity:.85;margin-top:8px;font-size:14px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}}
.card{{background:#fff;border-radius:10px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,.08)}}
.card h3{{font-size:14px;color:#666;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px}}
.product-card{{background:#f8f9fa;border-radius:8px;padding:14px;margin-bottom:8px}}
.product-card h4{{font-size:16px;color:#1a73e8}}
.product-card .price{{font-size:20px;font-weight:700;color:#34a853;margin:6px 0}}
.tag{{display:inline-block;background:#e8f0fe;color:#1a73e8;padding:2px 8px;border-radius:4px;font-size:12px;margin:2px}}
.country-bar{{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:13px}}
.country-label{{width:32px;font-weight:600}}
.bar{{flex:1;height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden}}
.fill{{height:100%;background:linear-gradient(90deg,#1a73e8,#34a853);border-radius:4px}}
.mat-item{{padding:4px 0;font-size:13px}}
.comp-item{{background:#fff3e0;padding:10px;border-radius:6px;margin:6px 0;font-size:13px;line-height:1.6}}
.iq-item{{font-size:13px;padding:4px 0;border-bottom:1px solid #f0f0f0}}
.evo-item{{font-size:12px;color:#666;padding:4px 0}}
.footer{{text-align:center;color:#999;font-size:12px;margin-top:24px}}
</style></head>
<body>
<div class="header">
  <h1>🏢 {profile.get("name", e)}</h1>
  <div class="usp">{profile.get("usp", "")}</div>
</div>
<div class="grid">
  <div class="card">
    <h3>📦 产品线</h3>
    {product_cards or "<p style='color:#999'>暂无产品</p>"}
  </div>
  <div class="card">
    <h3>👤 买家画像</h3>
    <p style="font-size:13px;color:#666;margin-bottom:8px">v{p.get("version",0)} · 基于 {p.get("evolution",[]) and len(p["evolution"])} 次进化</p>
    {country_bars or "<p style='color:#999'>暂无数据</p>"}
    <p style="font-size:13px;margin-top:8px">买家类型: {", ".join(p.get("buyer_type",{}).keys()) or "—"}</p>
  </div>
  <div class="card">
    <h3>🧠 竞争情报</h3>
    <p style="font-size:13px;margin-bottom:8px">{comp.get("positioning","—")[:120]}</p>
    {comp_html or "<p style='color:#999'>暂无竞品数据</p>"}
  </div>
  <div class="card">
    <h3>📋 物料清单</h3>
    {material_items}
  </div>
  <div class="card">
    <h3>💬 IQ 记忆</h3>
    <p style="font-size:13px;color:#666">{iq.get("total_interactions",0)} 次交互</p>
    {"".join(f'<div class="iq-item">🔹 {q["question"][:60]} <span style="color:#999">×{q["count"]}</span></div>' for q in iq.get("common_questions",[])[:5]) or "<p style='color:#999'>暂无</p>"}
  </div>
</div>
<div class="footer">DealClaw KB v{kb.get("version",1)} · {kb.get("updated_at","")[:10]}</div>
</body></html>'''

    # ═══════════════════════════════════════════════════════
    #  💬 交互记忆
    # ═══════════════════════════════════════════════════════

    def record_iq_interaction(self, enterprise, intent, buyer_question="", buyer_domain=""):
        """记录一次 IQ 交互"""
        kb = self.ensure(enterprise)
        mem = kb.get("iq_memory", empty_kb(enterprise)["iq_memory"])
        mem["total_interactions"] = mem.get("total_interactions", 0) + 1
        mem["last_interaction"] = _now()

        if buyer_question:
            found = False
            for q in mem.get("common_questions", []):
                if q.get("question") == buyer_question[:80]:
                    q["count"] += 1
                    found = True
                    break
            if not found:
                mem["common_questions"].append({"question": buyer_question[:80], "count": 1})
                mem["common_questions"] = mem["common_questions"][-20:]

        if intent == "拒绝":
            mem["buyer_objections"].append({
                "objection": buyer_question[:100] if buyer_question else "unspecified",
                "domain": buyer_domain, "at": _now(),
            })
            mem["buyer_objections"] = mem["buyer_objections"][-20:]

        kb["iq_memory"] = mem
        self._save(enterprise, kb)

    def get_common_questions(self, enterprise, top_n=5):
        kb = self.ensure(enterprise)
        qs = kb.get("iq_memory", {}).get("common_questions", [])
        qs.sort(key=lambda x: x["count"], reverse=True)
        return qs[:top_n]

    # ═══════════════════════════════════════════════════════
    #  全量展示
    # ═══════════════════════════════════════════════════════

    def show(self, enterprise):
        kb = self.ensure(enterprise)
        return {
            "enterprise": kb["enterprise"],
            "version": kb["version"],
            "updated": kb["updated_at"][:19],

            "profile": {
                "name": kb["profile"].get("name", ""),
                "product": kb["profile"].get("product", ""),
                "usp": kb["profile"].get("usp", ""),
            },

            "persona": {
                "v": kb["persona"].get("version", 0),
                "countries": list(kb["persona"].get("country", {}).keys())[:5],
                "top_keywords": list(kb["persona"].get("keywords", {}).keys())[:8],
                "types": list(kb["persona"].get("buyer_type", {}).keys()),
                "evolution_count": len(kb["persona"].get("evolution", [])),
            },

            "products": [{"id": p["id"], "name": p["name"], "specs_count": len(p.get("specs", {})),
                          "has_pricing": bool(p.get("pricing"))} for p in kb.get("products", [])],

            "materials": {t: m.get("status") for t, m in kb.get("materials", {}).items()},

            "competitive": {
                "positioning": kb["competitive"].get("positioning", "")[:60],
                "competitors": len(kb["competitive"].get("competitors", [])),
                "angles": len(kb["competitive"].get("entry_angles", [])),
            },

            "iq_memory": {
                "interactions": kb["iq_memory"].get("total_interactions", 0),
                "questions": len(kb["iq_memory"].get("common_questions", [])),
                "objections": len(kb["iq_memory"].get("buyer_objections", [])),
            },
        }

    def publish_to_feishu(self, enterprise):
        """生成图文并茂的飞书知识库文档"""
        from dc_kb_publish import build_content
        content = build_content(enterprise)
        kb = self.ensure(enterprise)
        e_name = kb.get("profile", {}).get("name", enterprise)

        import subprocess, json as j
        result = subprocess.run(
            ["lark-cli", "docs", "+create", "--title", f"{e_name} · 知识库",
             "--content", content, "--as", "bot"],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode == 0 and result.stdout:
            data = j.loads(result.stdout)
            if data.get("ok"):
                doc_token = data.get("data", {}).get("document", {}).get("document_id", "")
                url = data.get("data", {}).get("document", {}).get("url", "")
                if doc_token and url:
                    # 自动给田耕郡加编辑权限
                    subprocess.run(
                        ["lark-cli", "drive", "permission.members", "create",
                         "--token", doc_token, "--type", "docx",
                         "--data", '{"member_id":"ou_2b516abcb05aa539ff0056bc839d3d3a","member_type":"openid","perm":"full_access"}',
                         "--yes", "--as", "bot"],
                        capture_output=True, timeout=10
                    )
                    kb["_feishu_doc_url"] = url
                    self._save(enterprise, kb)
                    return url
        print(f"发布失败: {result.stderr[:200] if result.stderr else '未知错误'}", file=sys.stderr)
        return None


# ── CLI ──
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("dc_kb_engine.py show|products|persona|materials|competitive|iq <enterprise>")
        sys.exit(1)

    cmd = sys.argv[1]
    enterprise = sys.argv[2] if len(sys.argv) > 2 else "solarunis.com"
    kb = KBEngine()
    kb.ensure(enterprise)

    if cmd == "show":
        print(json.dumps(kb.show(enterprise), ensure_ascii=False, indent=2))
    elif cmd == "products":
        print(json.dumps(kb.get_products(enterprise), ensure_ascii=False, indent=2))
    elif cmd == "persona":
        print(json.dumps(kb.get_persona(enterprise), ensure_ascii=False, indent=2))
    elif cmd == "materials":
        mats = kb.check_materials(enterprise)
        for t in DEFAULT_MATERIAL_TYPES:
            m = kb.ensure(enterprise)["materials"].get(t, {})
            print(f"{'✅' if m.get('status')=='ready' else '⬜'} {MATERIAL_LABELS.get(t,t):12s} {m.get('name','')[:40]}")
    elif cmd == "competitive":
        print(json.dumps(kb.ensure(enterprise)["competitive"], ensure_ascii=False, indent=2))
    elif cmd == "iq":
        print(json.dumps(kb.ensure(enterprise)["iq_memory"], ensure_ascii=False, indent=2))
    elif cmd == "graph":
        print(kb.to_mermaid(enterprise))
    elif cmd == "ig":
        print(kb.to_interactive_graph(enterprise))
    elif cmd == "html":
        print(kb.to_html(enterprise))
    elif cmd == "dash":
        print(kb.to_html(enterprise))
    elif cmd == "publish":
        # 生成飞书文档
        doc_url = kb.publish_to_feishu(enterprise)
        print(doc_url or "❌ 发布失败")
