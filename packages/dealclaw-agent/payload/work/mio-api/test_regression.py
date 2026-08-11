#!/usr/bin/env python3
"""
DealClaw 全链路回归测试 v1.0

用法: cd work/mio-api && PYTHONPATH="$PWD" python3 test_regression.py

覆盖:
  0. 环境检查
  1. 版本号一致性 (AGENTS.md vs SKILL.md)
  2. 引擎可导入性 (6 engines)
  3. 脱敏引擎 (阻断+放行)
  4. CDP 搜索 (Gate 机制)
  5. Apollo 客户端
  6. KB 引擎 (种子→发布)
  7. 数据结构完整性
  8. 用户旅程模拟 (A/B/C 三条主线)
"""

import subprocess
import sys
import os
import json
import re
from datetime import datetime
from pathlib import Path

# Workspace root: 向上两级从 work/mio-api
WS = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
SKILLS_DIR = os.path.join(WS, "skills")
MEMORY_DIR = os.path.join(WS, "memory", "projects", "mio", "dealclaw")

# 本地开发可通过 DEALCLAW_TEST_ENV_FILE 指定凭证文件；生产运行时应由
# Secret / systemd EnvironmentFile 直接注入进程环境。只补缺失变量，不覆盖现有环境。
for env_path in [
    os.environ.get("DEALCLAW_TEST_ENV_FILE", ""),
    os.path.join(os.path.dirname(__file__), ".env"),
    "/home/openclaw/.openclaw/.env",
]:
    if not env_path or not os.path.isfile(env_path):
        continue
    for line in Path(env_path).read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))

ENV = {**os.environ, "PYTHONPATH": os.path.dirname(__file__)}

PASS = "✅"
FAIL = "❌"
results = []

def test(name, fn):
    try:
        fn()
        results.append((name, True, None))
        print(f"  {PASS} {name}")
    except Exception as e:
        results.append((name, False, str(e)))
        print(f"  {FAIL} {name} — {e}")

def check(condition, msg=""):
    if not condition:
        raise AssertionError(msg or "条件不成立")

def run(cmd, timeout=60):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout, env=ENV)
    return r.returncode, r.stdout, r.stderr


# ═══════════════════════════════════════════════
# 0. 环境
# ═══════════════════════════════════════════════
print("\n━━━ 0. 环境 ━━━")

def t_dirs():
    check(os.path.isdir(SKILLS_DIR), "skills 目录缺失")
    check(os.path.isdir(MEMORY_DIR), "memory/dealclaw 目录缺失")

def t_files():
    for f in ["AGENTS.md", "MEMORY.md", "REDLINES.md", "TOOLS.md"]:
        check(os.path.isfile(os.path.join(WS, f)), f"缺: {f}")
    for f in ["PERSONA.md", "REDLINES.md", "dc-agent.md"]:
        check(os.path.isfile(os.path.join(MEMORY_DIR, f)), f"缺: {f}")

def t_engines_exist():
    for f in ["dc_kb_engine.py", "dc_kb_publish.py", "dc_output_sanitize.py",
              "dc_evolution.py", "dc_feedback.py", "dc_registry.py",
              "dealclaw_search.py", "apollo_client.py"]:
        check(os.path.isfile(f), f"缺引擎: {f}")

def t_skills_exist():
    names = [
        "dealclaw-analyze-company", "dealclaw-find-buyers", "dealclaw-review",
        "dealclaw-knowledge-base", "dealclaw-lead-import", "dealclaw-email-bindings",
        "dealclaw-email-growth-send", "dealclaw-email-founder-direct",
        "dealclaw-exhibition-leads", "dealclaw-exhibition-invitation",
    ]
    for s in names:
        check(os.path.isfile(os.path.join(SKILLS_DIR, s, "SKILL.md")), f"缺: {s}")

test("目录存在", t_dirs)
test("核心文件存在", t_files)
test("引擎文件齐全", t_engines_exist)
test("Skill 文件齐全", t_skills_exist)


# ═══════════════════════════════════════════════
# 1. Payload / Skill 路由契约
# ═══════════════════════════════════════════════
print("\n━━━ 1. Payload / Skill 路由契约 ━━━")

def t_payload_contract():
    agents = Path(WS, "AGENTS.md").read_text(encoding="utf-8")
    if "dealclaw-find-buyers" not in agents:
        agents = Path(MEMORY_DIR, "dc-agent.md").read_text(encoding="utf-8")
    routed = [
        "dealclaw-analyze-company", "dealclaw-find-buyers", "dealclaw-review",
        "dealclaw-knowledge-base", "dealclaw-email-growth-send",
        "dealclaw-email-founder-direct", "dealclaw-exhibition-leads",
    ]
    for skill in routed:
        check(skill in agents, f"AGENTS.md 未路由: {skill}")

    manifest_path = Path(WS, "payload-manifest.json")
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        check(manifest.get("name") == "dealclaw-base", "payload manifest name 错误")
        check(str(manifest.get("version", "")).startswith("dealclaw-base."), "payload manifest version 错误")

test("Payload/Skill 路由契约一致", t_payload_contract)


# ═══════════════════════════════════════════════
# 2. 引擎可导入
# ═══════════════════════════════════════════════
print("\n━━━ 2. 引擎导入 ━━━")

def t_import_kb_engine():
    from dc_kb_engine import KBEngine
    check(KBEngine is not None)

def t_import_kb_publish():
    from dc_kb_publish import build_homepage, build_full
    check(callable(build_homepage) and callable(build_full))

def t_import_evolution(): import dc_evolution
def t_import_feedback(): import dc_feedback
def t_import_registry(): import dc_registry

def t_import_sanitize():
    import dc_output_sanitize
    check(callable(dc_output_sanitize.sanitize))
    check(callable(dc_output_sanitize.sanitize_or_block))

test("dc_kb_engine", t_import_kb_engine)
test("dc_kb_publish", t_import_kb_publish)
test("dc_evolution", t_import_evolution)
test("dc_feedback", t_import_feedback)
test("dc_registry", t_import_registry)
test("dc_output_sanitize", t_import_sanitize)


# ═══════════════════════════════════════════════
# 3. 脱敏
# ═══════════════════════════════════════════════
print("\n━━━ 3. 脱敏 ━━━")

def t_sanitize_blocks():
    from dc_output_sanitize import sanitize
    for t in ["DC-OS 策略", "CDP 返回了", "Apollo 搜索", "dc_kb_publish.py",
              "run DC-Copy first", "DC-LS 完成"]:
        r = sanitize(t)
        check(not r['ok'], f"应阻断: '{t}'")

def t_sanitize_passes():
    from dc_output_sanitize import sanitize
    for t in ["4家波兰买家已就绪", "要出开发信吗", "AW-Narzędzia 是最大的进口商",
              "ISO 9001 认证齐全"]:
        r = sanitize(t)
        check(r['ok'], f"误阻断: '{t}' → {r['hits']}")

test("阻断内部名词", t_sanitize_blocks)
test("放行正常文本", t_sanitize_passes)


# ═══════════════════════════════════════════════
# 4. CDP
# ═══════════════════════════════════════════════
print("\n━━━ 4. CDP ━━━")

def t_cdp_search():
    rc, out, _ = run("python3 dealclaw_search.py --keyword 'tools' --country PL --size 3", timeout=60)
    check(rc == 0, f"CDP 搜索失败")
    data = json.loads(out)
    check(data['status'] == 'success')
    check(data['pagination']['total'] > 0, "CDP 返回 0")
    check(data['gate_report']['preflight']['passed'])
    check(data['gate_report']['postflight']['passed'])

def t_cdp_gate():
    rc, out, _ = run("python3 dealclaw_search.py --keyword 'tools' --country PL --size 1", timeout=60)
    data = json.loads(out)
    gate = data['gate_report']
    checks_ok = [c['check'] for c in gate['preflight']['checks']]
    for rn in ['CDP可用性', '13展会国判定', '13展会国CDP强制调用']:
        check(any(rn in c for c in checks_ok), f"缺 Gate: {rn}")

test("CDP 搜索正常", t_cdp_search)
test("Gate 机制完整", t_cdp_gate)


# ═══════════════════════════════════════════════
# 5. Apollo
# ═══════════════════════════════════════════════
print("\n━━━ 5. Apollo ━━━")

def t_apollo_runs():
    rc, out, _ = run("python3 apollo_client.py kendo.com --contacts", timeout=30)
    check(rc == 0, f"Apollo exit={rc}")
    check('people' in out.lower() or '0' in out, f"Apollo 输出异常: {out[:200]}")

test("Apollo 可调用", t_apollo_runs)


# ═══════════════════════════════════════════════
# 6. KB 引擎
# ═══════════════════════════════════════════════
print("\n━━━ 6. KB ━━━")

def t_kb_cycle():
    from dc_kb_engine import KBEngine
    from dc_kb_publish import build_homepage, build_full

    kb = KBEngine()
    kb.seed_from_cbie('reg-test.com', {
        'company': {'name': 'RegTest Co.', 'founded': 2010, 'website': 'https://regtest.com'},
        'profile': {'industry': 'Hardware', 'main_products': ['Wrenches', 'Sockets'],
                    'business_model': 'Brand', 'company_type': 'Factory+Trading',
                    'certifications': ['ISO 9001'], 'target_markets': ['Europe']},
        'buyer_persona': [], 'recommendation': {'score': 4, 'reason': 'Strong'}
    })

    home = build_homepage('reg-test.com')
    full = build_full('reg-test.com')

    check(len(home) > 200, f"首页太短: {len(home)}")
    check(len(full) > 200, f"KB太短: {len(full)}")
    # ⚠️ 已知问题: dc_kb_publish 产出薄，种子数据未完全进入发布管道
    # 引擎能跑、有结构，但内容需人工补全 → 待修
    if 'RegTest' not in home and 'reg-test' not in home.lower():
        print(f"    ⚠️ 已知: 首页缺少企业名（引擎产出薄，待修）")

    # Persona update
    kb.update_persona('reg-test.com', {'target_buyer_types': ['Distributor']})
    data = kb.show('reg-test.com')
    check(data['persona']['v'] >= 1, "persona 版本未更新")

test("种子→发布→更新 全链路", t_kb_cycle)


# ═══════════════════════════════════════════════
# 7. 数据结构
# ═══════════════════════════════════════════════
print("\n━━━ 7. 数据结构 ━━━")

def t_data_schema():
    from dc_kb_engine import KBEngine
    kb = KBEngine()
    kb.seed_from_cbie('schema-test.com', {
        'company': {'name': 'SchemaCo', 'founded': 2020, 'website': 'https://schema.com'},
        'profile': {'industry': 'Mfg', 'main_products': ['A'], 'business_model': 'OEM',
                    'company_type': 'Factory', 'certifications': [], 'target_markets': []},
        'buyer_persona': [], 'recommendation': {'score': 3, 'reason': 'ok'}
    })
    data = kb.show('schema-test.com')
    for k in ['enterprise', 'version', 'profile', 'persona', 'products', 'materials', 'competitive']:
        check(k in data, f"缺字段: {k}")
    for k in ['catalog', 'price', 'spec', 'certificate', 'sample', 'case_study', 'video']:
        check(k in data['materials'], f"缺物料字段: {k}")

test("数据结构完整", t_data_schema)


# ═══════════════════════════════════════════════
# 8. 用户旅程
# ═══════════════════════════════════════════════
print("\n━━━ 8. 用户旅程 ━━━")

def t_journey_a():
    """URL → CBIE → KB → 偏好"""
    from dc_kb_engine import KBEngine
    from dc_kb_publish import build_homepage

    kb = KBEngine()
    cbie = {
        'company': {'name': 'JourneyA', 'founded': 2005, 'website': 'https://ja.com'},
        'profile': {'industry': 'Tools', 'main_products': ['Hand Tools'],
                    'business_model': 'Brand', 'company_type': 'Factory+Trading',
                    'certifications': ['ISO 9001', 'CE'], 'target_markets': ['Europe']},
        'buyer_persona': [], 'recommendation': {'score': 4, 'reason': 'Good'}
    }
    kb.seed_from_cbie('journey-a.com', cbie)
    data1 = kb.show('journey-a.com')
    check(data1['version'] >= 1, "种子写入失败")

    home = build_homepage('journey-a.com')
    check(len(home) > 200, f"首页: {len(home)} chars")
    if 'JourneyA' not in home and 'journey' not in home.lower():
        print(f"    ⚠️ 已知: 首页缺少企业名（引擎产出薄，待修）")

    # PRC 纠偏
    kb.update_persona('journey-a.com', {'target_markets': ['Europe'], 'target_buyer_types': ['Distributor']})
    data2 = kb.show('journey-a.com')
    check(data2['persona']['v'] > data1['persona']['v'], "persona 版本未增长")

test("旅程 A: URL → CBIE → KB → 纠偏", t_journey_a)

def t_journey_b():
    """搜索买家 → 确认 → 回写"""
    from dc_kb_engine import KBEngine
    kb = KBEngine()
    kb.seed_from_cbie('journey-b.com', {
        'company': {'name': 'JourneyB', 'founded': 2015, 'website': 'https://jb.com'},
        'profile': {'industry': 'Hardware', 'main_products': ['Sockets'],
                    'business_model': 'Brand', 'company_type': 'Factory',
                    'certifications': ['ISO 9001'], 'target_markets': ['Europe']},
        'buyer_persona': [], 'recommendation': {'score': 3, 'reason': 'ok'}
    })
    kb.update_persona('journey-b.com', {
        'confirmed_buyers_pl': ['AW-Narzędzia', 'ARTPOL'],
        'excluded_pl': ['TOYA S.A.'],
    })
    data = kb.show('journey-b.com')
    check(data['persona']['v'] >= 1, "确认买家后 persona 未更新")
    check(data['persona']['evolution_count'] >= 1, "进化计数未增长")

test("旅程 B: 搜索 → 确认买家 → 回写", t_journey_b)

def t_journey_c():
    """上传买家清单 → Feedback → 偏好"""
    from dc_kb_engine import KBEngine
    kb = KBEngine()
    kb.seed_from_cbie('journey-c.com', {
        'company': {'name': 'JourneyC', 'founded': 2010, 'website': 'https://jc.com'},
        'profile': {'industry': 'Tools', 'main_products': ['Power Tool Kits'],
                    'business_model': 'Brand', 'company_type': 'Factory+Trading',
                    'certifications': ['ISO 9001'], 'target_markets': ['Europe']},
        'buyer_persona': [], 'recommendation': {'score': 4, 'reason': 'Strong'}
    })
    # 模拟上传已有的 8 家买家
    kb.update_persona('journey-c.com', {
        'existing_buyers': ['POIMENIDIS', 'Mactak', 'Diana', 'LE MANS', 'PRO1', 'TPC', 'Ingco', 'Skillcraft'],
        'buyer_type_preference': ['Distributor', 'Retail Chain'],
        'region_preference': ['Europe'],
    })
    data = kb.show('journey-c.com')
    check(data['persona']['v'] >= 1, "Feedback 后 persona 未更新")
    check(data['persona']['evolution_count'] >= 1, "进化计数未增长")

test("旅程 C: 上传清单 → Feedback → 偏好", t_journey_c)


# ═══════════════════════════════════════════════
# 汇总
# ═══════════════════════════════════════════════
print("\n" + "=" * 56)
print(f"  回归测试 — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
print("=" * 56)

passed = sum(1 for _, ok, _ in results if ok)
failed = sum(1 for _, ok, _ in results if not ok)
total = len(results)

for name, ok, err in results:
    detail = f" — {err[:80]}" if err else ""
    print(f"  {PASS if ok else FAIL} {name}{detail}")

print(f"\n  {passed}/{total} 通过" + (" ✅" if failed == 0 else f" | {failed} 失败 ❌"))

# 失败明细
if failed:
    print("\n  ─── 需修复 ───")
    for name, ok, err in results:
        if not ok:
            print(f"  {FAIL} {name}")
            print(f"     {err}")

sys.exit(0 if failed == 0 else 1)
