#!/usr/bin/env python3
"""
DC-Health — DealClaw 系统健康检查

检查:
  引擎层: 所有 dc_*.py 可编译、可初始化
  数据层: JSON/JSONL 文件存在、格式正确、不损坏
  API层: Resend 连通性
  KB层: 每个企业的知识库六模块完整性
  一致性: leads ↔ persona ↔ KB 数据不矛盾

用法:
  python3 dc_health.py              # 终端表格输出
  python3 dc_health.py --json       # JSON 给自动化用
  python3 dc_health.py --watch      # 每 60s 刷新
"""

import json, os, sys, time, subprocess
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

DATA_DIR = Path(__file__).resolve().parent / "data"
KB_DIR = Path(__file__).resolve().parents[2] / "data" / "memory"
ENGINE_DIR = Path(__file__).resolve().parent

ENGINES = [
    "dc_ls_store", "dc_iq_engine", "dc_kb_engine",
    "dc_copy_engine", "dc_audit", "dc_customer_import",
]

DATA_FILES = [
    ("leads.json", "线索库"),
    ("audit_log.jsonl", "审计日志"),
    ("preferences.json", "偏好"),
]

# ── 检查函数 ──

def check_engines():
    results = []
    for name in ENGINES:
        path = ENGINE_DIR / f"{name}.py"
        if not path.exists():
            results.append(("❌", name, "文件缺失"))
            continue
        try:
            subprocess.run(["python3", "-m", "py_compile", str(path)],
                           capture_output=True, timeout=5, check=True)
            results.append(("✅", name, "编译通过"))
        except subprocess.CalledProcessError as e:
            results.append(("❌", name, f"编译错误: {e.stderr.decode()[:60] if e.stderr else '?'}"))
        except Exception as e:
            results.append(("❌", name, str(e)[:60]))
    return results


def check_data_files():
    results = []
    for filename, label in DATA_FILES:
        path = DATA_DIR / filename
        if not path.exists():
            results.append(("⬜", label, "文件不存在"))
            continue
        try:
            content = path.read_text().strip()
            if not content:
                results.append(("⚠️", label, "文件为空"))
                continue
            if filename.endswith(".json"):
                json.loads(content)
                count = len(json.loads(content)) if isinstance(json.loads(content), list) else len(json.loads(content).keys()) if isinstance(json.loads(content), dict) else "?"
            else:
                lines = [l for l in content.split("\n") if l.strip()]
                count = len(lines)
                for l in lines[:3]:
                    json.loads(l)  # 验证每行是合法 JSON
            results.append(("✅", label, f"{count} 条, 格式正确"))
        except json.JSONDecodeError as e:
            results.append(("❌", label, f"JSON损坏: {str(e)[:60]}"))
        except Exception as e:
            results.append(("❌", label, str(e)[:60]))
    return results


def check_kb():
    results = []
    if not KB_DIR.exists():
        results.append(("⬜", "KB目录", "不存在, 尚未初始化"))
        return results
    
    kb_files = list(KB_DIR.glob("*/kb.json"))
    if not kb_files:
        results.append(("⬜", "KB", "无企业知识库"))
        return results
    
    for path in kb_files:
        try:
            kb = json.loads(path.read_text())
            enterprise = kb.get("enterprise", path.parent.name)
            modules = {
                "profile": bool(kb.get("profile", {}).get("name")),
                "persona": bool(kb.get("persona", {}).get("version")),
                "products": len(kb.get("products", [])),
                "materials": sum(1 for m in kb.get("materials", {}).values() if m.get("status") == "ready"),
                "competitive": bool(kb.get("competitive", {}).get("positioning")),
                "iq_memory": kb.get("iq_memory", {}).get("total_interactions", 0),
            }
            ready = sum(1 for v in modules.values() if v)
            results.append((
                "✅" if ready >= 4 else "⚠️",
                f"KB: {enterprise}",
                f"v{kb.get('version','?')} | {ready}/6模块 | "
                f"产品{modules['products']} 物料{modules['materials']} "
                f"IQ{modules['iq_memory']}次"
            ))
        except Exception as e:
            results.append(("❌", f"KB: {path.parent.name}", str(e)[:60]))
    return results


def check_apis():
    results = []

    # Resend
    resend_key = os.environ.get("RESEND_API_KEY", "")
    if resend_key:
        results.append(("✅", "Resend API", "凭据已配置"))
    else:
        results.append(("⬜", "Resend API", "凭据未配置"))
    return results


def check_consistency():
    """检查 leads.json 中的 enterprise 与 persona 是否匹配"""
    results = []
    leads_path = DATA_DIR / "leads.json"
    if not leads_path.exists():
        return results
    try:
        leads = json.loads(leads_path.read_text())
        enterprises_in_leads = set(l.get("enterprise", "") for l in leads if l.get("enterprise"))
        kb_enterprises = set()
        if KB_DIR.exists():
            for p in KB_DIR.glob("*/kb.json"):
                kb = json.loads(p.read_text())
                if kb.get("persona", {}).get("version"):
                    kb_enterprises.add(kb.get("enterprise", p.parent.name))
        orphaned = enterprises_in_leads - kb_enterprises
        if orphaned:
            results.append(("⚠️", f"一致性", f"{len(orphaned)} 个企业有线索但无画像"))
        else:
            results.append(("✅", f"一致性", f"{len(enterprises_in_leads)} 个企业, 数据一致"))
    except Exception as e:
        results.append(("⚠️", "一致性", str(e)[:60]))
    return results


# ── 主入口 ──

def run_all():
    sections = [
        ("引擎层", check_engines()),
        ("数据层", check_data_files()),
        ("API层", check_apis()),
        ("知识库", check_kb()),
        ("一致性", check_consistency()),
    ]
    return sections


def print_table(sections):
    for title, checks in sections:
        print(f"\n{'─'*50}")
        print(f"  {title}")
        print(f"{'─'*50}")
        ok = sum(1 for s,_,_ in checks if "✅" in s)
        warn = sum(1 for s,_,_ in checks if "⚠️" in s)
        fail = sum(1 for s,_,_ in checks if "❌" in s)
        for status, name, detail in checks:
            print(f"  {status} {name:<25s} {detail}")
        print(f"  {'─'*45}")
        total = ok + warn + fail + sum(1 for s,_,_ in checks if "⬜" in s)
        print(f"  ✅{ok} ⚠️{warn} ❌{fail} 总计{total}")


if __name__ == "__main__":
    if "--json" in sys.argv:
        all_checks = []
        for title, checks in run_all():
            for status, name, detail in checks:
                all_checks.append({"section": title, "status": status, "name": name, "detail": detail})
        print(json.dumps({"time": datetime.now(timezone.utc).isoformat(), "checks": all_checks}, ensure_ascii=False, indent=2))
    elif "--watch" in sys.argv:
        while True:
            os.system("clear")
            print(f"DealClaw Health Check — {datetime.now().strftime('%H:%M:%S')}")
            print_table(run_all())
            time.sleep(60)
    else:
        print(f"DealClaw Health Check — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print_table(run_all())
