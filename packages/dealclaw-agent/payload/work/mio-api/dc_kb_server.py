#!/usr/bin/env python3
"""
DC-KB Server v2 — DealClaw 知识库编辑器
"""

import json, os, sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from datetime import datetime, timezone

DATA_DIR = Path(__file__).resolve().parent / "data"
KB_DIR = Path(__file__).resolve().parents[2] / "data" / "memory"
PORT = 8820

def _now():
    return datetime.now(timezone.utc).isoformat()

def list_enterprises():
    """扫描 data/kb/ 目录，返回所有企业列表"""
    ents = []
    if KB_DIR.exists():
        for f in KB_DIR.glob("*/kb.json"):
            try:
                d = json.loads(f.read_text())
                name = d.get("profile",{}).get("name") or d.get("enterprise", f.parent.name)
                ents.append({"key": d.get("enterprise", f.parent.name), "name": name[:30], "file": str(f)})
            except: pass
    if not ents:
        ents = [{"key":"solarunis.com","name":"Solarunis Energy","file":""}]
    return ents

def render(kb_data, enterprise, enterprises):
    """渲染编辑器 HTML"""
    p = kb_data.get("profile",{})
    persona = kb_data.get("persona",{})
    products = kb_data.get("products",[])
    mats = kb_data.get("materials",{})
    comp = kb_data.get("competitive",{})
    iq = kb_data.get("iq_memory",{})
    name = p.get("name", enterprise)
    kd_json = json.dumps(kb_data, ensure_ascii=False)
    ents_json = json.dumps(enterprises, ensure_ascii=False)

    return f"""<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>知识库 · {name}</title>
<style>
:root{{--blue:#3370ff;--green:#34c759;--red:#ff3b30;--orange:#ff9500;--purple:#af52de;--bg:#f5f6f7;--card:#fff;--text:#1f2329;--sub:#8f959e;--border:#e5e6eb;--radius:10px}}
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;font-size:14px}}
.topbar{{background:var(--blue);color:#fff;padding:0 20px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;gap:12px}}
.topbar h1{{font-size:18px;font-weight:600;white-space:nowrap}}
.topbar select{{background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:6px 32px 6px 10px;font-size:14px;cursor:pointer;appearance:none;min-width:180px;background-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='white'><path d='M2 4l4 4 4-4'/></svg>");background-repeat:no-repeat;background-position:right 8px center}}
.topbar select option{{color:#333;background:#fff}}
.btn{{padding:7px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:.15s}}
.btn-edit{{background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.3)}}
.btn-edit.active{{background:var(--orange);border-color:var(--orange)}}
.btn-save{{background:var(--green);color:#fff}}
.btn-cancel{{background:var(--sub);color:#fff}}
.btn-add{{background:none;color:var(--blue);border:1px dashed var(--blue);font-size:12px;padding:3px 10px;margin-left:8px}}
.btn-del{{color:var(--red);background:none;border:none;cursor:pointer;font-size:16px;padding:0 4px;opacity:.6}}
.btn-del:hover{{opacity:1}}
.main{{max-width:1400px;margin:0 auto;padding:16px 20px}}
.insights{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:16px}}
.insight{{background:var(--card);border-radius:var(--radius);padding:14px 16px;font-size:13px;border-left:3px solid var(--blue);box-shadow:0 1px 2px rgba(0,0,0,.04)}}
.insight .ic{{font-size:18px;margin-right:6px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px}}
.card{{background:var(--card);border-radius:var(--radius);overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}}
.card-head{{padding:12px 16px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px;display:flex;align-items:center;justify-content:space-between}}
.card-body{{padding:12px 16px}}
table{{width:100%;border-collapse:collapse}}
td,th{{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);font-size:13px;vertical-align:top}}
th{{color:var(--sub);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.5px}}
input,textarea,select{{border:1px solid var(--border);border-radius:5px;padding:7px 10px;font-size:13px;font-family:inherit;width:100%;background:#fff;transition:.15s}}
input:focus,textarea:focus,select:focus{{border-color:var(--blue);outline:none;box-shadow:0 0 0 2px rgba(51,112,255,.15)}}
textarea{{min-height:36px;resize:vertical}}
.edit-only{{display:none}}
.edit .edit-only{{display:revert}}
.edit .view-only{{display:none}}
.edit td,.edit th{{padding:5px 8px}}
.bar{{display:flex;align-items:center;gap:8px;margin:5px 0}}
.bar-flag{{width:32px;font-weight:600;font-size:13px}}
.bar-track{{flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden}}
.bar-fill{{height:100%;background:linear-gradient(90deg,var(--blue),var(--green));border-radius:4px;transition:width .3s}}
.bar-pct{{width:38px;text-align:right;font-size:11px;color:var(--sub)}}
.comp-row{{padding:8px 10px;margin:6px 0;background:#fafbfc;border-radius:6px;border:1px solid var(--border)}}
.iq-item{{font-size:12px;padding:5px 0;border-bottom:1px solid #fafbfc;display:flex;justify-content:space-between}}
.iq-item span{{color:var(--sub)}}
#toast{{position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:10px 24px;border-radius:8px;color:#fff;font-size:14px;z-index:999;opacity:0;transition:opacity .3s;pointer-events:none}}
#toast.show{{opacity:1}}
#toast.ok{{background:var(--green)}}
#toast.err{{background:var(--red)}}
#toast.info{{background:var(--blue)}}
.auto-save-indicator{{display:none;font-size:11px;color:var(--green);align-items:center;gap:4px}}
.edit .auto-save-indicator{{display:flex}}
.empty{{color:var(--sub);font-size:13px;padding:12px 0;text-align:center}}
</style></head><body>
<div class="topbar">
  <div style="display:flex;align-items:center;gap:12px">
    <h1>🏢 知识库</h1>
    <select id="entSelect" onchange="switchEnterprise(this.value)">{''.join(f'<option value="{e["key"]}" {"selected" if e["key"]==enterprise else ""}>{e["name"]}</option>' for e in enterprises)}</select>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    <span class="auto-save-indicator" id="autoSaveDot">🟢 已保存</span>
    <button class="btn btn-cancel edit-only" onclick="cancelEdit()">取消</button>
    <button class="btn btn-save edit-only" onclick="saveKB()">💾 保存</button>
    <button class="btn btn-edit" id="editBtn" onclick="toggleEdit()">✏️ 编辑</button>
  </div>
</div>
<div id="toast"></div>
<div class="main" id="app"></div>
<script>
const KB = {kd_json};
const ENTERPRISES = {ents_json};
let ENT = "{enterprise}";
let editMode = false;
let ORIG = JSON.parse(JSON.stringify(KB));
let autoSaveTimer = null;
let dirty = false;

// ── 自动保存 ──
function markDirty() {{
  dirty = true;
  document.getElementById('autoSaveDot').innerHTML = '🟡 未保存';
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveKB(true), 3000);
}}

function toast(msg, type='ok') {{
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show '+type;
  setTimeout(() => t.className = '', 2000);
}}

async function saveKB(silent) {{
  if (!dirty && silent) return;
  try {{
    KB.updated_at = new Date().toISOString();
    const resp = await fetch('/save', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{enterprise:ENT,data:KB}})}});
    if (resp.ok) {{
      ORIG = JSON.parse(JSON.stringify(KB)); dirty = false;
      document.getElementById('autoSaveDot').innerHTML = '🟢 已保存';
      if (!silent) toast('✅ 已保存');
    }} else {{ if (!silent) toast('❌ 保存失败', 'err'); }}
  }} catch(e) {{ if (!silent) toast('❌ 网络错误', 'err'); }}
}}

// ── 切换企业 ──
async function switchEnterprise(key) {{
  await saveKB(true);
  ENT = key;
  const resp = await fetch('/load?enterprise='+encodeURIComponent(key));
  const data = await resp.json();
  Object.assign(KB, data);
  ORIG = JSON.parse(JSON.stringify(KB));
  dirty = false;
  editMode = false;
  document.body.classList.remove('edit');
  document.getElementById('editBtn').textContent = '✏️ 编辑';
  document.getElementById('editBtn').classList.remove('active');
  render();
  toast('已切换到 '+key, 'info');
}}

function toggleEdit() {{
  editMode = !editMode;
  document.body.classList.toggle('edit', editMode);
  const b = document.getElementById('editBtn');
  b.textContent = editMode ? '✅ 完成' : '✏️ 编辑';
  b.classList.toggle('active', editMode);
  if (!editMode) {{ KB = JSON.parse(JSON.stringify(ORIG)); dirty = false; render(); }}
}}

function cancelEdit() {{
  KB = JSON.parse(JSON.stringify(ORIG)); dirty = false;
  toggleEdit();
  document.getElementById('autoSaveDot').innerHTML = '🟢 已保存';
}}

// ── 渲染 ──
function render() {{
  const p = KB.profile || {{}};
  const persona = KB.persona || {{}};
  const products = KB.products || [];
  const mats = KB.materials || {{}};
  const comp = KB.competitive || {{}};
  const iq = KB.iq_memory || {{}};

  // 洞察
  const ins = [];
  if (products.length) ins.push(`🎯 ${{products[0].name}}卖到${{(products[0].target_markets||[]).slice(0,2).join('/')}}，定价${{products[0].pricing?products[0].pricing.fob:'?'}}`);
  if (comp.competitors&&comp.competitors.length) ins.push(`🧠 ${{comp.competitors[0].name}}弱点：${{comp.competitors[0].weakness||'?'}}`);
  const miss = [];
  if (mats.sample&&mats.sample.status!='ready') miss.push('样品');
  if (mats.case_study&&mats.case_study.status!='ready') miss.push('案例');
  if (mats.video&&mats.video.status!='ready') miss.push('视频');
  if (miss.length) ins.push('⚠️ 缺'+miss.join('/')+'，问了'+iq.total_interactions+'次');

  let html = '<div class="insights">'+ins.map(s=>'<div class="insight">'+s+'</div>').join('')+'</div><div class="grid">';

  // 产品
  html += '<div class="card"><div class="card-head">📦 产品<button class="btn-add edit-only" onclick="addProduct()">+ 添加</button></div><div class="card-body"><table>';
  html += '<tr><th>ID</th><th>名称</th><th>定价</th><th>目标市场</th><th class="edit-only"></th></tr>';
  products.forEach((pr,i)=>{{
    html += '<tr><td class="view-only">'+pr.id+'</td><td class="edit-only"><input value="'+pr.id+'" oninput="KB.products['+i+'].id=this.value;markDirty()" style="width:90px"></td>';
    html += '<td>'+(editMode?'<input value="'+pr.name+'" oninput="KB.products['+i+'].name=this.value;markDirty()">':'<strong>'+pr.name+'</strong>')+'</td>';
    html += '<td>'+(editMode?'<input value="'+(pr.pricing?pr.pricing.fob:'')+'" oninput="if(!KB.products['+i+'].pricing)KB.products['+i+'].pricing={{}};KB.products['+i+'].pricing.fob=this.value;markDirty()" style="width:110px">':(pr.pricing?pr.pricing.fob:'—'))+'</td>';
    html += '<td>'+(editMode?'<input value="'+(pr.target_markets||[]).join(', ')+'" oninput="KB.products['+i+'].target_markets=this.value.split(/,\\s*/);markDirty()">':(pr.target_markets||[]).join(', '))+'</td>';
    html += '<td class="edit-only"><button class="btn-del" onclick="KB.products.splice('+i+',1);markDirty();render()">×</button></td></tr>';
  }});
  if (!products.length) html += '<tr><td colspan="5" class="empty">暂无产品，点击编辑模式添加</td></tr>';
  html += '</table></div></div>';

  // 画像
  html += '<div class="card"><div class="card-head">👤 买家画像</div><div class="card-body">';
  const ct = persona.country || {{}};
  const mx = Math.max(...Object.values(ct),1);
  Object.entries(ct).slice(0,8).forEach(([c,w])=>{{
    html += '<div class="bar"><div class="bar-flag">'+c+'</div><div class="bar-track"><div class="bar-fill" style="width:'+Math.round(w/mx*100)+'%"></div></div><div class="bar-pct">'+Math.round(w*100)+'%</div>';
    html += '<div class="edit-only" style="width:60px"><input value="'+Math.round(w*100)+'" oninput="KB.persona.country.'+c+'=parseFloat(this.value)/100;markDirty()" style="font-size:12px;padding:3px 6px"></div></div>';
  }});
  html += '<div style="margin-top:10px;font-size:13px">买家类型: '+Object.keys(persona.buyer_type||{{}}).join(' · ')+'</div>';
  html += '<div style="font-size:12px;color:var(--sub);margin-top:4px">v'+(persona.version||0)+' · '+(persona.evolution||[]).length+'次进化</div>';
  html += '</div></div>';

  // 竞争
  html += '<div class="card"><div class="card-head">🧠 竞争情报<button class="btn-add edit-only" onclick="addCompetitor()">+ 添加</button></div><div class="card-body">';
  html += (editMode?'<textarea oninput="KB.competitive.positioning=this.value;markDirty()" style="margin-bottom:8px">'+(comp.positioning||'')+'</textarea>':'<p style="font-size:13px;color:var(--sub);margin-bottom:8px">'+(comp.positioning||'—')+'</p>');
  (comp.competitors||[]).forEach((c,i)=>{{
    html += '<div class="comp-row"><strong>'+(editMode?'<input value="'+c.name+'" oninput="KB.competitive.competitors['+i+'].name=this.value;markDirty()">':c.name)+'</strong>';
    html += '<div style="font-size:12px;color:var(--sub);margin-top:4px">弱点: '+(editMode?'<input value="'+(c.weakness||'')+'" oninput="KB.competitive.competitors['+i+'].weakness=this.value;markDirty()">':(c.weakness||'—'))+'</div>';
    html += '<div style="font-size:12px;color:var(--sub)">优势: '+(editMode?'<input value="'+(c.advantage||'')+'" oninput="KB.competitive.competitors['+i+'].advantage=this.value;markDirty()">':(c.advantage||'—'))+'</div>';
    html += '<div class="edit-only"><button class="btn-del" onclick="KB.competitive.competitors.splice('+i+',1);markDirty();render()">×</button></div></div>';
  }});
  html += '</div></div>';

  // 物料
  html += '<div class="card"><div class="card-head">📋 物料</div><div class="card-body"><table>';
  const labels = {{catalog:'目录',price:'报价',spec:'规格',certificate:'认证',sample:'样品',case_study:'案例',video:'视频'}};
  ['catalog','price','spec','certificate','sample','case_study','video'].forEach(mt => {{
    const m = mats[mt] || {{}};
    const icon = m.status=='ready'?'✅':'⬜';
    html += '<tr><td style="width:30px">'+icon+'</td><td>'+(editMode?'<input value="'+(m.name||labels[mt])+'" oninput="if(!KB.materials.'+mt+')KB.materials.'+mt+'={{}};KB.materials.'+mt+'.name=this.value;markDirty()">':(m.name||labels[mt]))+'</td>';
    html += '<td>'+(editMode?'<select onchange="KB.materials.'+mt+'.status=this.value;markDirty()"><option value="ready" '+(m.status=='ready'?'selected':'')+'>✅ 就绪</option><option value="missing" '+(m.status!='ready'?'selected':'')+'>⬜ 缺失</option></select>':(m.status=='ready'?'就绪':'缺失'))+'</td></tr>';
  }});
  html += '</table></div></div>';

  // 策略+IQ
  html += '<div class="card"><div class="card-head">🎯 切入策略<button class="btn-add edit-only" onclick="addAngle()">+ 添加</button></div><div class="card-body">';
  (comp.entry_angles||[]).forEach((a,i)=>{{
    html += '<div style="font-size:13px;padding:5px 0;display:flex;align-items:center;gap:8px;border-bottom:1px solid #fafbfc">';
    html += '<span style="flex:1">'+(editMode?'<input value="'+a+'" oninput="KB.competitive.entry_angles['+i+']=this.value;markDirty()">':a)+'</span>';
    html += '<button class="btn-del edit-only" onclick="KB.competitive.entry_angles.splice('+i+',1);markDirty();render()">×</button></div>';
  }});
  if (!(comp.entry_angles||[]).length) html += '<div class="empty">暂无策略</div>';
  html += '</div></div>';

  html += '<div class="card"><div class="card-head">💬 买家常问 ('+(iq.total_interactions||0)+'次)</div><div class="card-body">';
  (iq.common_questions||[]).forEach(q=>html+='<div class="iq-item"><span>'+q.question+'</span><span>×'+q.count+'</span></div>');
  if (!(iq.common_questions||[]).length) html += '<div class="empty">暂无互动</div>';
  html += '</div></div>';

  html += '</div>';
  document.getElementById('app').innerHTML = html;
}}

function addProduct(){{ if(!KB.products)KB.products=[]; KB.products.push({{id:'p-'+Date.now(),name:'新产品',category:'',specs:{{}},pricing:{{fob:'—',moq:0}},target_markets:[],certifications:[]}}); markDirty(); render(); }}
function addCompetitor(){{ if(!KB.competitive.competitors)KB.competitive.competitors=[]; KB.competitive.competitors.push({{name:'新竞品',weakness:'',advantage:''}}); markDirty(); render(); }}
function addAngle(){{ if(!KB.competitive.entry_angles)KB.competitive.entry_angles=[]; KB.competitive.entry_angles.push('新策略'); markDirty(); render(); }}

render();
</script></body></html>"""

class KBHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/load'):
            from urllib.parse import parse_qs, urlparse
            qs = parse_qs(urlparse(self.path).query)
            ent = qs.get('enterprise', ['solarunis.com'])[0]
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from dc_kb_engine import KBEngine
            kb = KBEngine()
            data = kb.ensure(ent)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode())
            return

        # 默认: 渲染编辑器
        from urllib.parse import parse_qs, urlparse
        qs = parse_qs(urlparse(self.path).query)
        ent = qs.get('enterprise', ['solarunis.com'])[0]
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from dc_kb_engine import KBEngine
        kb = KBEngine()
        data = kb.ensure(ent)
        enterprises = list_enterprises()
        html = render(data, ent, enterprises)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(html.encode('utf-8'))

    def do_POST(self):
        if self.path == '/save':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            ent = body.get('enterprise', 'solarunis.com')
            data = body.get('data', {})
            slug = ''.join(c for c in ent.lower() if c.isalnum())
            kb_dir = KB_DIR / slug
            kb_dir.mkdir(parents=True, exist_ok=True)
            kb_file = kb_dir / "kb.json"
            data['updated_at'] = _now()
            data['enterprise'] = ent
            kb_file.write_text(json.dumps(data, ensure_ascii=False, indent=2))
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


def main():
    print(f"🧠 DealClaw KB Editor v2")
    print(f"   http://localhost:{PORT}")
    server = HTTPServer(('0.0.0.0', PORT), KBHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 已停止")
        server.server_close()

if __name__ == '__main__':
    main()
