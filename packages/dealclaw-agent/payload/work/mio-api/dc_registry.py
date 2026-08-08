#!/usr/bin/env python3
"""
DC-Registry — 引擎 & 技能注册表

每引擎/技能一条记录: 名称、版本、文件、依赖、统计。
任何新引擎创建时调用 registry.register() 自动登记。

用法:
  python3 dc_registry.py show              # 完整注册表
  python3 dc_registry.py engines           # 仅引擎
  python3 dc_registry.py stats             # 使用统计
"""

import json, os, sys
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
REGISTRY_FILE = DATA_DIR / "registry.json"


def _now():
    return datetime.now(timezone.utc).isoformat()


class Registry:
    def __init__(self):
        os.makedirs(str(DATA_DIR), exist_ok=True)
        self._entries = self._load()

    def _load(self):
        if REGISTRY_FILE.exists():
            return json.loads(REGISTRY_FILE.read_text())
        return {"engines": {}, "skills": {}}

    def _save(self):
        REGISTRY_FILE.write_text(json.dumps(self._entries, ensure_ascii=False, indent=2))

    def register_engine(self, name, filepath, description="", depends_on=None, version="1.0"):
        """注册一个引擎。depends_on: [engine_names]"""
        entry = {
            "name": name,
            "type": "engine",
            "file": filepath,
            "description": description,
            "depends_on": depends_on or [],
            "version": version,
            "registered_at": _now(),
            "stats": {"calls": 0, "errors": 0, "last_called": None},
        }
        # 保留已有统计
        if name in self._entries["engines"]:
            entry["stats"] = self._entries["engines"][name].get("stats", entry["stats"])
        self._entries["engines"][name] = entry
        self._save()

    def register_skill(self, name, skill_path, description="", depends_on=None, version="1.0",
                       author="", triggers=None):
        """注册一个技能。triggers: [触发词列表]"""
        entry = {
            "name": name,
            "type": "skill",
            "path": skill_path,
            "description": description,
            "depends_on": depends_on or [],
            "version": version,
            "author": author,
            "triggers": triggers or [],
            "registered_at": _now(),
            "stats": {"calls": 0, "success_count": 0, "last_called": None},
        }
        if name in self._entries["skills"]:
            entry["stats"] = self._entries["skills"][name].get("stats", entry["stats"])
        self._entries["skills"][name] = entry
        self._save()

    # ── 使用统计 ──

    def record_call(self, name, success=True):
        """记录一次调用。每次 engine/skill 被使用后调用。"""
        for cat in ("engines", "skills"):
            if name in self._entries.get(cat, {}):
                s = self._entries[cat][name]["stats"]
                s["calls"] += 1
                if not success:
                    s["errors"] += 1
                s["last_called"] = _now()
                self._save()
                return

    def bump_version(self, name, new_version, change=""):
        """版本升级"""
        for cat in ("engines", "skills"):
            if name in self._entries.get(cat, {}):
                old = self._entries[cat][name]["version"]
                self._entries[cat][name]["version"] = new_version
                if "version_history" not in self._entries[cat][name]:
                    self._entries[cat][name]["version_history"] = []
                self._entries[cat][name]["version_history"].append({
                    "from": old, "to": new_version,
                    "at": _now(), "change": change[:120],
                })
                self._save()
                return

    # ── 查询 ──

    def get_engine(self, name):
        return self._entries.get("engines", {}).get(name)

    def get_skill(self, name):
        return self._entries.get("skills", {}).get(name)

    def list_engines(self):
        return list(self._entries.get("engines", {}).values())

    def list_skills(self):
        return list(self._entries.get("skills", {}).values())

    def dependency_graph(self):
        """返回引擎依赖图: {engine → [依赖的引擎]}"""
        return {name: e.get("depends_on", [])
                for name, e in self._entries.get("engines", {}).items()}

    def top_used(self, n=5, category="engines"):
        """使用最多的 N 个引擎/技能"""
        entries = self._entries.get(category, {}).values()
        ranked = sorted(entries, key=lambda e: e.get("stats", {}).get("calls", 0), reverse=True)
        return ranked[:n]

    def show(self):
        return {
            "updated": _now(),
            "engines": {name: {"v": e["version"], "calls": e["stats"]["calls"],
                               "deps": e["depends_on"], "desc": e["description"]}
                        for name, e in self._entries.get("engines", {}).items()},
            "skills": {name: {"v": s["version"], "calls": s["stats"]["calls"],
                              "author": s.get("author",""), "triggers": s.get("triggers",[])[:5]}
                       for name, s in self._entries.get("skills", {}).items()},
        }


# ── 全局单例 ──
_registry = None

def get_registry():
    global _registry
    if _registry is None:
        _registry = Registry()
    return _registry


# ── 自注册: 启动时扫描并自动登记所有引擎 ──
def auto_register():
    reg = get_registry()
    engine_dir = Path(__file__).resolve().parent

    engines = {
        "dc_ls_store": ("dc_ls_store.py", "线索存储+去重+标注+偏好", ["dc_audit", "dc_customer_import"], "2.5"),
        "dc_iq_engine": ("dc_iq_engine.py", "意图识别→状态迁移→自动回复", ["dc_ls_store", "dc_kb_engine", "dc_send_log", "dc_audit"], "2.2"),
        "dc_kb_engine": ("dc_kb_engine.py", "六模块统一知识库", ["dc_audit"], "2.0"),
        "dc_send_log": ("dc_send_log.py", "发送日志+投递追踪+退订检查", ["dc_audit"], "1.1"),
        "dc_copy_engine": ("dc_copy_engine.py", "多语言开发信+渠道适配", [], "2.1"),
        "dc_audit": ("dc_audit.py", "审计日志", [], "1.0"),
        "dc_customer_import": ("dc_customer_import.py", "历史客户导入+标签提取+画像学习", ["dc_kb_engine"], "1.1"),
        "dc_dashboard": ("dc_dashboard.py", "日报+漏斗+看板", ["dc_send_log", "dc_ls_store", "dc_kb_engine"], "2.0"),
        "dc_circuit": ("dc_circuit.py", "熔断降级", [], "1.0"),
        "dc_degrade": ("dc_degrade.py", "降级决策矩阵", ["dc_error_log"], "1.0"),
        "dc_error_log": ("dc_error_log.py", "结构化错误日志", [], "1.0"),
        "dc_health": ("dc_health.py", "系统健康检查", [], "1.0"),
        "dc_morning_report": ("dc_morning_report.py", "每日早报+漏斗", ["dc_ls_store", "dc_send_log", "dc_audit"], "1.0"),
        "dc_registry": ("dc_registry.py", "引擎/技能注册表", [], "1.0"),
    }

    for name, (file, desc, deps, ver) in engines.items():
        if (engine_dir / file).exists():
            reg.register_engine(name, file, description=desc, depends_on=deps, version=ver)

    # 技能注册（从 SKILL.md 扫描）
    skills_dir = Path(__file__).resolve().parents[2] / "skills"
    skill_map = {
        "dc-ls": ("dc-lead-search", "买家搜索与匹配", ["dc_ls_store", "dc_customer_import"], "2.5", "田耕郡",
                  ["找买家", "搜买家", "搜客户", "线索挖掘"]),
        "dc-copy": ("dc-copy", "开发信生成", ["dc_copy_engine", "dc_kb_engine"], "2.0", "田耕郡",
                   ["写开发信", "开发信", "邮件模板"]),
        "dc-iq": ("dc-iq", "询盘智能处理", ["dc_iq_engine"], "2.1", "田耕郡",
                 ["自动回复", "买家回复", "IQ"]),
        "dc-os": ("dc-high-value-strategy", "高价值策略分析", [], "2.0", "田耕郡",
                  ["策略", "切入", "竞品分析"]),
        "dc-kb": ("dc-knowledge-base", "知识库管理", ["dc_kb_engine"], "2.0", "田耕郡",
                  ["知识库", "物料", "产品库"]),
        "dc-cbie": ("dc-company-buyer-intelligence", "企业买方情报", [], "1.7", "田耕郡",
                    ["企业画像", "CBIE", "公司分析"]),
    }
    for name, (folder, desc, deps, ver, author, triggers) in skill_map.items():
        path = skills_dir / folder / "SKILL.md"
        if path.exists():
            reg.register_skill(name, str(path), description=desc, depends_on=deps,
                              version=ver, author=author, triggers=triggers)


# ── CLI ──
if __name__ == "__main__":
    auto_register()
    reg = get_registry()

    if len(sys.argv) < 2 or sys.argv[1] == "show":
        print(json.dumps(reg.show(), ensure_ascii=False, indent=2))
    elif sys.argv[1] == "engines":
        for e in reg.list_engines():
            print(f"  {e['name']:25s} v{e['version']}  calls:{e['stats']['calls']}  → {e['description']}")
    elif sys.argv[1] == "skills":
        for s in reg.list_skills():
            print(f"  {s['name']:25s} v{s['version']}  calls:{s['stats']['calls']}  → {s['description']}")
    elif sys.argv[1] == "stats":
        print("🔥 最多使用的引擎:")
        for e in reg.top_used(5):
            print(f"  {e['name']:25s} {e['stats']['calls']:4d} calls  {e['stats']['errors']} errors")
        print("\n🔗 依赖图:")
        for name, deps in reg.dependency_graph().items():
            if deps:
                print(f"  {name} → {' → '.join(deps)}")
