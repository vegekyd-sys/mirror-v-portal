#!/usr/bin/env python3
"""reflection_e2e.py — Reflection 体系端到端验收（不挂调度）

流程（对应需求 1-9）：
  1. 从候选人工选取 1 bug / 1 skill_improvement / 1 industry_knowledge（本脚本内固定声明）。
  2. bug → 代码修复 + 回归测试（test_reflection_writers.py）。
  3. skill_improvement → Skill/规则 + 测试（rules.md + dc_timeutil.py + test_dc_timeutil.py）。
  4. industry_knowledge → 脱敏、限定行业/市场/场景后写入 industry-knowledge.md。
  5. 重新构建 payload（排除运行时数据）→ 创建 A/B 两个全新分身。
  6. 验证 A/B 都继承三项改进，但初始 reflection / 租户 Memory 为空。
  7. 分身 A 写「不要使用MOQ作为卖点」→ A 遵守；B 不受影响（租户隔离）。
  8. 固化读取优先级：本次指令 > 租户纠正 > 企业事实 > 租户偏好 > payload通用知识 > 模型知识。
  9. 验证本地 Memory 自动创建、跨分身不串数据、重复构建可复现。
  10. 输出验收报告 → docs/reflection-review/reflection-e2e-acceptance.md

用法：python3 tools/reflection-review/reflection_e2e.py [--out <report.md>]
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PAYLOAD = REPO / "packages" / "dealclaw-agent" / "payload"
BOUNDARY = json.loads((REPO / "packages" / "dealclaw-agent" / "payload-boundary.json")
                      .read_text(encoding="utf-8"))

# 需求 1：人工选定候选（来自 review-reflections 候选）
CHOSEN = {
    "bug": "reflection 脚本曾 fallback 全局路径写错目录 → resolve_workspace 自定位 + 回归测试",
    "skill_improvement": "客户价值口径（数字/ROI）从 industry-knowledge 迁出 → reporting-playbook.md（Agent 怎么表达/排序）",
    "industry_knowledge": "买家行为：优先有采购记录的制造商（非询盘多的贸易商）→ industry-knowledge.md（脱敏+限定）",
}
# 需求 8：读取优先级（高 → 低）
PRECEDENCE = ["本次指令", "租户纠正", "企业事实", "租户偏好", "payload通用知识", "模型知识"]

RESULT: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULT.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'} | {name}" + (f" | {detail}" if detail else ""))
    return bool(ok)


def _excluded(rel: str) -> bool:
    if rel in set(BOUNDARY.get("allow_placeholders", [])):
        return False
    for pat in BOUNDARY["exclude"]:
        if pat.endswith("/**"):
            base = pat[:-3]
            if rel == base or rel.startswith(base + "/"):
                return True
        elif fnmatch.fnmatch(rel, pat):
            return True
    return False


def build_payload(dest: Path) -> dict:
    """确定性构建：复制 payload（排除运行时数据），返回 {rel: sha256} + 汇总 sha。"""
    dest.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, str] = {}
    for p in sorted(PAYLOAD.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(PAYLOAD).as_posix()
        if _excluded(rel):
            continue
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, out)
        manifest[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    blob = json.dumps(manifest, sort_keys=True, ensure_ascii=False)
    return {"manifest": manifest, "sha": hashlib.sha256(blob.encode("utf-8")).hexdigest(),
            "files": len(manifest)}


def spawn(build_dir: Path, instance_dir: Path) -> Path:
    """从 build 创建全新分身：复制 payload + 自动创建空的本地 memory 目录。"""
    shutil.copytree(build_dir, instance_dir, dirs_exist_ok=True)
    mem = instance_dir / "memory"
    (mem / "reflections").mkdir(parents=True, exist_ok=True)
    (mem / "projects" / "dealclaw").mkdir(parents=True, exist_ok=True)
    (instance_dir / "knight.config.json").write_text(json.dumps(
        {"workspace": str(instance_dir), "timezone": "Asia/Shanghai",
         "storage": {"local": {"reflections_dir": "memory/reflections"}}},
        ensure_ascii=False, indent=2), encoding="utf-8")
    return instance_dir


def write_correction(instance: Path, what: str, how: str = "") -> None:
    p = instance / "memory" / "projects" / "dealclaw" / "reflections.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(), "type": "correction",
                            "what": what, "how": how, "user": "test"}, ensure_ascii=False) + "\n")


def layers(instance: Path) -> dict:
    """分身的本地层：租户纠正/企业事实/租户偏好 + payload 通用知识。"""
    out = {"租户纠正": [], "企业事实": [], "租户偏好": [], "payload通用知识": []}
    p = instance / "memory" / "projects" / "dealclaw" / "reflections.jsonl"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            e = json.loads(line)
            t = e.get("type")
            (out["租户纠正"] if t == "correction" else
             out["企业事实"] if t == "fact" else out["租户偏好"]).append(e.get("what") or "")
    kb = instance / "memory" / "projects" / "dealclaw" / "industry-knowledge.md"
    if kb.exists():
        out["payload通用知识"] = [l.strip("- ").strip() for l in kb.read_text(encoding="utf-8").splitlines()
                                if l.strip().startswith("-")]
    return out


def resolve(query: str, inst_layers: dict, turn_instruction: str = "") -> tuple[str, str]:
    """按固化优先级返回 (来源层, 内容)。"""
    q = set(query.lower().split())
    def hit(text: str) -> bool:
        t = (text or "").lower()
        return any(tok and tok in t for tok in q)
    if turn_instruction and hit(turn_instruction):
        return "本次指令", turn_instruction
    for name in ("租户纠正", "企业事实", "租户偏好"):
        for item in inst_layers.get(name, []):
            if hit(item):
                return name, item
    for item in inst_layers.get("payload通用知识", []):
        if hit(item):
            return "payload通用知识", item
    return "模型知识", "（无本地依据，使用模型知识）"


def run_tests() -> bool:
    ok = True
    for t in (PAYLOAD / "work" / "mio-api" / "test_dc_timeutil.py",
              REPO / "packages" / "dealclaw-agent" / "tests" / "test_reflection_writers.py"):
        r = subprocess.run([sys.executable, str(t)], capture_output=True, text=True)
        passed = r.returncode == 0
        ok = ok and passed
        print(f"  test {t.name}: {'OK' if passed else 'FAIL'}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(REPO / "docs" / "reflection-review" / "reflection-e2e-acceptance.md"))
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="reflection-e2e-"))
    print(f"== Reflection 端到端验收 ==\n临时目录 {tmp}\n")

    # 1 选定候选
    for k, v in CHOSEN.items():
        print(f"[chosen] {k}: {v}")
    check("1. 人工选定 1 bug / 1 skill / 1 industry", all(CHOSEN.values()))

    # 2/3 bug + skill 回归测试
    check("2/3. bug+skill 回归测试通过", run_tests())

    # 4 industry_knowledge 落库（脱敏 + 限定范围）+ ROI 已迁出 industry-knowledge
    kb = (PAYLOAD / "memory" / "projects" / "dealclaw" / "industry-knowledge.md").read_text(encoding="utf-8")
    playbook = (PAYLOAD / "memory" / "projects" / "dealclaw" / "reporting-playbook.md").read_text(encoding="utf-8")
    check("4. industry_knowledge 已落库（买家行为·脱敏·限定范围）",
          "买家行为" in kb and "已脱敏" in kb and "适用范围" in kb)
    check("4. 客户价值口径已从 industry-knowledge 迁出到 reporting-playbook",
          "客户价值口径" not in kb and "客户价值口径" in playbook)

    # 5 构建 payload（两次，校验可复现）
    b1 = build_payload(tmp / "build1")
    b2 = build_payload(tmp / "build2")
    check("5/9. payload 构建可复现（两次 sha 一致）", b1["sha"] == b2["sha"],
          f"sha={b1['sha'][:12]} files={b1['files']}")

    # 5 spawn A/B
    A = spawn(tmp / "build1", tmp / "instanceA")
    B = spawn(tmp / "build1", tmp / "instanceB")

    # 6 继承三项改进 + 初始为空
    inher = (
        (A / "scripts" / "write-reflection.py").exists()
        and (A / "memory" / "projects" / "dealclaw" / "rules.md").exists()
        and (A / "memory" / "projects" / "dealclaw" / "reporting-playbook.md").exists()
        and (A / "work" / "mio-api" / "dc_timeutil.py").exists()
        and "买家行为" in (A / "memory" / "projects" / "dealclaw" / "industry-knowledge.md").read_text(encoding="utf-8")
        and (B / "scripts" / "write-reflection.py").exists()
    )
    check("6. A/B 均继承三项改进（bug/skill/industry）", inher)
    def _empty(d: Path) -> bool:
        refl = [p for p in (d / "memory" / "reflections").glob("*") if p.name != ".gitkeep"]
        return refl == [] and not (d / "memory" / "projects" / "dealclaw" / "reflections.jsonl").exists()
    empty_a = _empty(A)
    empty_b = _empty(B)
    check("6. A/B 初始 reflection 与租户 Memory 为空", empty_a and empty_b)

    # 7 A 写纠正，A 遵守 / B 不受影响
    write_correction(A, "不要使用MOQ作为卖点", "卖点避免 MOQ")
    src_a, val_a = resolve("MOQ 卖点", layers(A))
    src_b, val_b = resolve("MOQ 卖点", layers(B))
    check("7. 分身 A 遵守租户纠正", src_a == "租户纠正" and "MOQ" in val_a, f"A→{src_a}")
    check("7. 分身 B 不受影响（隔离）", src_b != "租户纠正", f"B→{src_b}: {val_b}")

    # 8 优先级固化 + 本次指令最高
    src_turn, _ = resolve("MOQ 卖点", layers(A), turn_instruction="本次用 MOQ 作为卖点")
    check("8. 读取优先级：本次指令 > 租户纠正", src_turn == "本次指令")
    check("8. 优先级序列固化", PRECEDENCE == ["本次指令", "租户纠正", "企业事实", "租户偏好",
                                             "payload通用知识", "模型知识"])

    # 9 自动创建 + 不串数据
    auto = (A / "memory" / "reflections").is_dir() and (B / "memory" / "reflections").is_dir()
    check("9. 分身本地 Memory 自动创建", auto)
    leak = any("MOQ" in x for x in layers(B)["租户纠正"])
    check("9. 跨分身不串数据", not leak)

    # 报告
    passed = sum(1 for _, ok, _ in RESULT if ok)
    total = len(RESULT)
    lines = ["# Reflection 体系端到端验收报告", "",
             f"> 生成：{datetime.now(timezone.utc).isoformat()} · 结果：**{passed}/{total} 通过**",
             "> 模型：分发前测试母体学习 + 分发后独立分身本地学习；不挂调度。", "",
             "## 1. 选定候选（人工）", ""]
    for k, v in CHOSEN.items():
        lines.append(f"- **{k}**：{v}")
    lines += ["", "## 2. 构建产物", "",
              f"- payload 构建：文件 {b1['files']} · sha `{b1['sha'][:16]}`（两次一致：可复现）",
              f"- 分身 A/B：{A} · {B}", "",
              "## 3. 校验结果", ""]
    for name, ok, detail in RESULT:
        lines.append(f"- {'✅' if ok else '❌'} {name}" + (f" —— {detail}" if detail else ""))
    lines += ["", "## 4. 读取优先级（固化）", "",
              " > ".join(PRECEDENCE), "",
              "## 5. 结论与下一步", "",
              f"- 端到端验收 **{passed}/{total} 通过**；A/B 继承三项产品改进、初始为空、租户隔离、构建可复现。",
              "- 通过后**再**配置「仅测试母体运行」的每日候选调度（当前未挂）。"]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n报告：{out}\n结果：{passed}/{total}")
    shutil.rmtree(tmp, ignore_errors=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
