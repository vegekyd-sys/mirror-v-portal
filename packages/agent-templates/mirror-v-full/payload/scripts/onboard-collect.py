#!/usr/bin/env python3
"""采集落盘器：把一份纯文本原文收进 memory-archive/imports/，脱敏、查重、记账、提交。

冷启动期每天采几份原文（官网、公开报道、主人粘的正文、截图 OCR、飞书文档）。
原文**不能**进 memory_search 的召回池：200 份 × 16 KB ≈ 8000 个 chunk 会把
100 个结论页淹掉。所以实体目录在工作区根的 memory-archive/imports/，
memory/imports 只是软链接（memory-auto-index.py:51 明确跳过 symlink），
照抄 boot.mjs initVReleaseWorkspace() 对 archive/proposals 的做法。
代价：原文搜不到，wiki 页里必须写明原文相对路径，由模型 grep 下钻。

add 一条命令七件事，全部硬执行，不靠模型自觉：
  1 首次调用建实体目录 + memory/imports 软链接（payload 里不能预置 symlink，
    gen-manifest.mjs:18 遇 symlink 直接 throw，只能运行时建）
  2 写 memory-archive/imports/<source>/<YYYY-MM-DD>/<sha8>.md（YAML frontmatter）
    强制剥离二进制：NUL 字节或非 UTF-8 序列 → 拒绝整份、非零退出。
    任何二进制进 workspace 都会永久计入每轮备份（backup.mjs 连 .git 一起 tar，
    删文件不会让备份变小；10/09 的 294 MB / 排队 83 s 就是这么来的）
  3 追加 MANIFEST.json（disposition 状态机：pending → compiled|skipped|duplicate）
  4 追加 pull.log（一行一条，可 grep；被 .gitignore 的 *.log 排除，不入 git）
  5 就地脱敏：复用 librarian-adopt-untracked.py 的 secret 正则，命中的**值**换
    <redacted>，行号记进 MANIFEST。不走夜间 flagged 循环——企业接口文档会被
    `(api_key|secret|token|password)\\s*[:=]` 整片命中，那些页会永远进不了 git。
    （落盘时就脱敏，密文一秒也不落硬盘；MANIFEST 的 sha256 仍是脱敏前原文的，用于查重）
  6 调 onboard-budget.py --pending 做事前闸门，verdict 非 ok（warn 和 stop 都算）就把
    这一份回滚掉、非零退出、打印人话原因——停下问主人，别接着采
  7 git add 具体路径 + commit，再尽力重建索引（失败不致命）

用法：
  onboard-collect.py add --source web|paste|shot|browser|feishu|ai-memory \\
      --url <u> --title <t> [--stdin | --file <本地纯文本文件>]
  onboard-collect.py status [--json]
  onboard-collect.py mark <sha8> --disposition compiled|skipped|duplicate --note "..."

退出码：0 成功 / 2 参数错 / 3 输入不是纯文本或为空 / 4 预算闸门拒绝 / 5 其他失败
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo("Asia/Shanghai")
# ai-memory: 主人从别的 AI 助手（ChatGPT / Claude / DeepSeek / 豆包…）导出或让它复述出来的「关于我的记忆」。
# 个人用户通常没有知识库，这往往是他们唯一现成的记忆来源。
SOURCES = ("web", "paste", "shot", "browser", "feishu", "ai-memory")
DISPOSITIONS = ("compiled", "skipped", "duplicate")
OPENCLAW_MJS = Path("/vercel/sandbox/nexus/runtime/node_modules/openclaw/openclaw.mjs")

# 抄自 librarian-adopt-untracked.py 的 SECRET，拆成 (名字, 正则)，group(1) 是要保留的
# 前缀（键名 / Bearer），其余整段换成 <redacted>。替换后不再命中那条正则，所以这些页
# 不会被夜间 flagged 循环扣住。
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("openai-key", re.compile(r"()sk-[A-Za-z0-9_-]{20,}")),
    ("makaron-key", re.compile(r"()mk_live_[A-Za-z0-9]{8,}")),
    ("github-pat", re.compile(r"()ghp_[A-Za-z0-9]{20,}")),
    ("slack-token", re.compile(r"()xox[bpa]-[A-Za-z0-9-]{10,}")),
    ("aws-akid", re.compile(r"()AKIA[0-9A-Z]{16}")),
    ("bearer", re.compile(r"(Bearer\s+)[A-Za-z0-9._-]{20,}")),
    ("key-value", re.compile(
        r"((?i:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*)['\"]?[A-Za-z0-9/+_.-]{16,}['\"]?")),
    # 下面两条是拿真语料打出来的。81 份飞书文档里，上面那条 key-value 漏了两类，
    # 而漏掉的恰恰是真凭据：
    #   ① 中文标签 ——「账号：xxx」「密码：xxxxxx」，运营 SOP 里最常见的写法
    #   ② 引号里的短值 —— JSON 示例 `"password": "abc123"` 只有 6 字符，够不着 {16,}；
    #      另外 jsapi_ticket / appsecret / access_key 这几个键名原本就不在表里
    # 带引号或带中文标签时值的边界是明确的（引号/行尾），所以可以把门槛降到 4，
    # 不会像裸值那样误伤散文。
    # 值必须是「不含汉字的 ASCII 串」：真凭据不会是汉字，而中文文档里
    # 「账号：管理员账号可以…」这种散文一抓一大把（实测 56 个 wiki 页误杀 4 个）。
    ("cn-label", re.compile(
        r"((?:账号|帐号|账户|密码|口令|密钥|凭据|秘钥)\s*[:：]\s*)[A-Za-z0-9@._+/\-#!$%^&*]{4,}")),
    ("quoted-secret", re.compile(
        r"(['\"](?i:api[_-]?key|app[_-]?secret|access[_-]?key|secret|token|ticket|jsapi[_-]?ticket"
        r"|password|passwd|credential)['\"]\s*:\s*)['\"][^'\"]{4,}['\"]")),
]
# key-value 那条会把「名字里带 token」的**标识符**一起吃掉。实测：81 份飞书文档
# 全部命中，163 处全是 `obj_token:`、`node_token:` 这类文档 ID —— 它们是溯源用的，
# 抹掉之后记忆页就链不回原文了，而真正的凭据一处都没多抓到。
# 所以按**键名**豁免一批公认的标识符。只豁免键名，不豁免值的形态：
# 真出现 `access_token: xxx` 这种仍然照抹。
IDENTIFIER_KEYS = re.compile(
    r"(?i)\b(obj|node|doc|file|folder|space|wiki|block|sheet|record|app|open|union|user|chat|"
    r"message|request|trace|page|csrf|idempotency)[_-]?(token|id)\s*[:=]")
# 别人的私人信息（REDLINES：电话、证件号不进记忆）。2026-10-26 质检在真实飞书
# 导入里抽出 3 份带甲方联系人手机号的原文，上面那几条只认凭据，一处都没挡住。
# 号码两侧不能紧挨字母数字，免得把文档 token 里的数字段误当成号码。
PERSONAL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("cn-mobile", re.compile(r"()(?<![0-9A-Za-z])(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?![0-9A-Za-z])")),
    ("cn-id", re.compile(r"()(?<![0-9A-Za-z])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])")),
]
PEM_BEGIN = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY")
PEM_END = re.compile(r"-----END [A-Z ]*PRIVATE KEY")
REDACTED = "<redacted>"


# ---------- 布局 ----------

def layout(ws: Path) -> dict[str, Path]:
    entity = ws / "memory-archive" / "imports"
    return {"entity": entity, "link": ws / "memory" / "imports",
            "manifest": entity / "MANIFEST.json", "log": entity / "pull.log"}


def ensure_layout(ws: Path) -> list[str]:
    """① 建实体目录 + memory/imports 软链接（照抄 boot.mjs 的 archive/proposals 做法）。"""
    notes: list[str] = []
    p = layout(ws)
    p["entity"].mkdir(parents=True, exist_ok=True)
    keep = p["entity"] / ".gitkeep"
    if not keep.exists():
        keep.write_text("")
    link = p["link"]
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        if os.readlink(link) != "../memory-archive/imports":
            notes.append(f"警告：memory/imports 指向 {os.readlink(link)}，不是 ../memory-archive/imports")
    elif link.exists():
        notes.append("警告：memory/imports 是实体目录（多半是 V001 示范），里面的原文会进 memory_search 召回池；"
                     "本脚本只写 memory-archive/imports/，不动它")
    else:
        link.symlink_to("../memory-archive/imports")
        notes.append("已建软链接 memory/imports -> ../memory-archive/imports")
    return notes


# ---------- 输入清洗与脱敏 ----------

def clean(raw: bytes, origin: str) -> str:
    """② 强制剥离二进制：NUL 或非 UTF-8 → 拒绝整份。其余 C0 控制字符就地剥掉。"""
    if not raw.strip():
        die(3, f"{origin}：空输入，没有可落盘的正文")
    if b"\x00" in raw:
        die(3, f"{origin}：含 NUL 字节，这是二进制（PDF/图片/压缩包？）。"
               "workspace 只收纯文本——二进制会永久计入每轮备份。请先转成文本再喂给我")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        die(3, f"{origin}：不是合法 UTF-8（第 {e.start} 字节）。同上，只收纯文本")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    stripped = re.sub(r"[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    if stripped != text:
        print(f"提示：剥掉了 {len(text) - len(stripped)} 个控制字符", file=sys.stderr)
    return stripped


def redact(text: str) -> tuple[str, list[dict]]:
    """⑤ 就地脱敏：命中的值换 <redacted>，返回 (脱敏后正文, [{line, pattern}])。line 是原文行号。"""
    out: list[str] = []
    hits: list[dict] = []
    in_pem = False
    for no, line in enumerate(text.split("\n"), 1):
        if in_pem:  # PEM 块整块吞掉，只留一行 <redacted>
            hits.append({"line": no, "pattern": "private-key"})
            if PEM_END.search(line):
                in_pem = False
            continue
        if PEM_BEGIN.search(line):
            hits.append({"line": no, "pattern": "private-key"})
            in_pem = not PEM_END.search(line)
            out.append(REDACTED)
            continue
        for name, pat in PATTERNS + PERSONAL_PATTERNS:
            if name == "key-value" and IDENTIFIER_KEYS.search(line):
                continue  # obj_token / node_id 这类标识符，抹了就断了溯源
            line, n = pat.subn(lambda m: m.group(1) + REDACTED, line)
            if n:
                hits.extend({"line": no, "pattern": name} for _ in range(n))
        out.append(line)
    return "\n".join(out), hits


# ---------- 账本 ----------

def load_manifest(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "items": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {"version": 1, "items": data} if isinstance(data, list) else data


def save_manifest(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def append_log(path: Path, event: str, fields: dict) -> None:
    """④ 一行一条，可 grep。title 放最后（可能带空格）。"""
    parts = [now().isoformat(timespec="seconds"), event]
    parts += [f"{k}={v}" for k, v in fields.items() if k != "title"]
    if "title" in fields:
        parts.append(f"title={fields['title']}")
    with path.open("a", encoding="utf-8") as fh:
        fh.write(" ".join(str(x).replace("\n", " ") for x in parts) + "\n")


# ---------- 外部命令 ----------

def git(ws: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=ws,
                          capture_output=True, text=True)


def budget_gate(ws: Path, batch: Path) -> None:
    """⑥ 事前闸门。onboard-budget.py 的契约：verdict ok|warn|stop，warn 和 stop 都要停下问主人。"""
    script = ws / "scripts" / "onboard-budget.py"
    if not script.exists():
        print("警告：scripts/onboard-budget.py 不存在，本次跳过体积闸门", file=sys.stderr)
        return
    r = subprocess.run([sys.executable or "python3", str(script),
                        "--workspace", str(ws), "--pending", str(batch)],
                       cwd=ws, capture_output=True, text=True)
    verdict, reason = "unknown", " ".join((r.stdout + " " + r.stderr).split())[:400]
    try:
        data = json.loads(r.stdout)
        verdict = str(data.get("verdict", "unknown"))
        h = data.get("human") or {}
        reason = "；".join(data.get("reasons") or []) or str(data.get("reason") or "")
        if h:
            reason += f"（workspace {h.get('workspace')} / .git {h.get('git')} / 估算备份 {h.get('est_tgz')}）"
    except (json.JSONDecodeError, TypeError):
        pass
    if verdict != "ok" or r.returncode != 0:
        raise BudgetBlocked(f"体积闸门拦下了这一批（verdict={verdict}）：{reason}")


def reindex(ws: Path) -> str:
    """⑦ 重建索引，哪个存在用哪个；都不存在只提示，不报错。"""
    agent = os.environ.get("NEXUS_AGENT_ID", "mirror-v-full")
    if shutil.which("openclaw"):
        cmd = ["openclaw", "memory", "index", "--agent", agent]
    elif OPENCLAW_MJS.exists() and shutil.which("node"):
        cmd = ["node", str(OPENCLAW_MJS), "memory", "index", "--agent", agent]
    elif (ws / "scripts" / "memory-auto-index.py").exists():
        cmd = [sys.executable or "python3", str(ws / "scripts" / "memory-auto-index.py"),
               "--once", "--workspace", str(ws), "--agent", agent]
    else:
        return "skipped（没有 openclaw，也没有 memory-auto-index.py）"
    try:
        r = subprocess.run(cmd, cwd=ws, capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"failed（{type(e).__name__}，不致命）"
    return "ok" if r.returncode == 0 else f"failed（rc={r.returncode}，不致命）"


# ---------- 子命令 ----------

def cmd_add(a: argparse.Namespace, ws: Path) -> int:
    p = layout(ws)
    for note in ensure_layout(ws):
        print(note)

    origin = a.file if a.file else "stdin"
    raw = Path(a.file).read_bytes() if a.file else sys.stdin.buffer.read()
    text = clean(raw, origin)
    sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
    sha8 = sha256[:8]
    manifest = load_manifest(p["manifest"])
    fetched_at = now().isoformat(timespec="seconds")
    title = " ".join(a.title.split())
    url = " ".join((a.url or "").split())

    # ③ 查重：同 sha256 已存在就不重复落盘，记一条 duplicate 后返回
    twin = next((it for it in manifest["items"]
                 if it.get("sha256") == sha256 and it.get("disposition") != "duplicate"), None)
    if twin:
        manifest["items"].append({"sha8": sha8, "title": title, "url": url, "source": a.source,
                                  "chars": twin.get("chars", 0), "bytes": twin.get("bytes", 0),
                                  "sha256": sha256, "fetched_at": fetched_at,
                                  "disposition": "duplicate", "note": f"与已有 {twin['sha8']} 内容相同",
                                  "duplicate_of": twin["sha8"], "path": twin.get("path"), "redactions": []})
        save_manifest(p["manifest"], manifest)
        append_log(p["log"], "duplicate", {"source": a.source, "sha8": sha8,
                                           "same_as": twin["sha8"], "url": url, "title": title})
        git(ws, "add", "--", str(p["manifest"].relative_to(ws)))
        git(ws, "commit", "-qm", f"chore(onboard): skip duplicate {a.source} {sha8}")
        print(f"重复：这份内容已经在 {twin.get('path')}（{twin['sha8']}），没有重复落盘")
        return 0

    body, hits = redact(text)
    day = now().strftime("%Y-%m-%d")
    batch = p["entity"] / a.source / day
    batch.mkdir(parents=True, exist_ok=True)
    target = batch / f"{sha8}.md"
    front = [f"title: {yaml_str(title)}", f"url: {yaml_str(url)}", f"source: {a.source}",
             f"fetched_at: {yaml_str(fetched_at)}", f"sha256: {sha256}", f"redactions: {len(hits)}"]
    target.write_text("---\n" + "\n".join(front) + "\n---\n\n" + body.strip() + "\n", encoding="utf-8")

    rel = str(target.relative_to(ws))
    entry = {"sha8": sha8, "title": title, "url": url, "source": a.source, "chars": len(body),
             "bytes": len(body.encode("utf-8")), "sha256": sha256, "fetched_at": fetched_at,
             "disposition": "pending", "note": None, "path": rel,
             "redactions": hits}
    manifest["items"].append(entry)
    save_manifest(p["manifest"], manifest)
    append_log(p["log"], "add", {"source": a.source, "sha8": sha8, "chars": len(body),
                                 "redactions": len(hits), "disposition": "pending",
                                 "path": rel, "url": url, "title": title})

    try:
        budget_gate(ws, batch)
    except BudgetBlocked as e:  # 回滚：文件和账本都退回闸门之前
        target.unlink(missing_ok=True)
        manifest["items"] = [it for it in manifest["items"] if it is not entry]
        save_manifest(p["manifest"], manifest)
        append_log(p["log"], "budget-block", {"source": a.source, "sha8": sha8,
                                              "rolled_back": 1, "title": title})
        print(f"没落盘。{e}", file=sys.stderr)
        print("先别继续采了，去问主人要不要清理或换策略。", file=sys.stderr)
        return 4

    staged = [rel, str(p["manifest"].relative_to(ws)), str((p["entity"] / ".gitkeep").relative_to(ws))]
    if p["link"].is_symlink():  # 软链接本身也入 git，和 boot.mjs 对 archive/proposals 的做法一致
        staged.append(str(p["link"].relative_to(ws)))
    add = git(ws, "add", "--", *staged)
    n = len(list(batch.glob("*.md")))
    commit = git(ws, "commit", "-qm", f"chore(onboard): import {a.source} {day} {n} 份\n\n本次：{sha8} {title}")
    state = "已提交" if add.returncode == 0 and commit.returncode == 0 else \
        f"git 失败（{' '.join((add.stderr + ' ' + commit.stderr).split())[:160]}），文件已落盘，等 Librarian 收编"

    print(f"落盘 {rel}")
    print(f"  标题 {title} · {len(body)} 字符 · 脱敏 {len(hits)} 处 · disposition=pending")
    print(f"  {state} · 索引 {reindex(ws)}")
    if hits:
        print("  脱敏行（原文行号）：" + "、".join(f"{h['line']}({h['pattern']})" for h in hits[:12]))
    return 0


def cmd_status(a: argparse.Namespace, ws: Path) -> int:
    p = layout(ws)
    items = load_manifest(p["manifest"])["items"]
    total = len(items)
    disp = {k: 0 for k in ("pending", *DISPOSITIONS)}
    src: dict[str, int] = {}
    chars = nbytes = 0
    for it in items:
        disp[it.get("disposition", "pending")] = disp.get(it.get("disposition", "pending"), 0) + 1
        src[it.get("source", "?")] = src.get(it.get("source", "?"), 0) + 1
        chars += int(it.get("chars") or 0)
        nbytes += int(it.get("bytes") or 0)
    done = total - disp["pending"]
    rate = round(done / total, 3) if total else None
    if a.json:
        print(json.dumps({"total": total, "disposition": disp, "source": src,
                          "digested": done, "digest_rate": rate,
                          "chars": chars, "bytes": nbytes}, ensure_ascii=False))
        return 0
    print(f"导入账本 {p['manifest'].relative_to(ws)}")
    print(f"总数 {total} 份 · 消化率 " + (f"{rate:.0%}（{done}/{total} 已有去向）" if total else "—（还没采过）"))
    print("disposition  " + " · ".join(f"{k} {v}" for k, v in disp.items()))
    print("source       " + (" · ".join(f"{k} {v}" for k, v in sorted(src.items())) or "—"))
    print(f"累计 {chars:,} 字符 / {nbytes:,} 字节（原文在 memory-archive/imports/，不进召回池）")
    if disp["pending"]:
        print(f"还有 {disp['pending']} 份 pending：夜间 Librarian 按 import 队列编译，标完最后一片自动结账（librarian-daily-queue.py stats 看还剩几片）")
    return 0


def cmd_mark(a: argparse.Namespace, ws: Path) -> int:
    p = layout(ws)
    manifest = load_manifest(p["manifest"])
    hit = [it for it in manifest["items"]
           if it.get("sha8") == a.sha8 and it.get("disposition") != "duplicate"]
    if not hit:
        print(f"MANIFEST 里没有 {a.sha8}（或它本身就是一条 duplicate 记录）", file=sys.stderr)
        return 5
    for it in hit:
        it["disposition"] = a.disposition
        it["note"] = a.note
        it["marked_at"] = now().isoformat(timespec="seconds")
    save_manifest(p["manifest"], manifest)
    append_log(p["log"], "mark", {"sha8": a.sha8, "disposition": a.disposition, "note": a.note or ""})
    git(ws, "add", "--", str(p["manifest"].relative_to(ws)))
    git(ws, "commit", "-qm", f"chore(onboard): mark {a.sha8} {a.disposition}")
    print(f"{a.sha8} → {a.disposition}" + (f"（{a.note}）" if a.note else ""))
    return 0


def cmd_rescan(a: argparse.Namespace, ws: Path) -> int:
    """按当前规则把已经归档的原文重新脱敏一遍（规则更新之后用）。只改归档副本，不碰来源。"""
    p = layout(ws)
    manifest = load_manifest(p["manifest"])
    changed: list[str] = []
    for it in manifest["items"]:
        rel = it.get("path")
        if not rel or it.get("disposition") == "duplicate":
            continue
        f = ws / rel
        if not f.exists():
            continue
        text = f.read_text(encoding="utf-8")
        red, hits = redact(text)
        if not hits:
            continue
        f.write_text(red, encoding="utf-8")
        it["redactions"] = (it.get("redactions") or []) + [h for h in hits]
        changed.append(rel)
    if not changed:
        print("没有需要补脱敏的归档原文")
        return 0
    save_manifest(p["manifest"], manifest)
    append_log(p["log"], "rescan", {"files": len(changed)})
    git(ws, "add", "--", str(p["manifest"].relative_to(ws)), *changed)
    git(ws, "commit", "-qm", f"chore(onboard): 按新规则补脱敏 {len(changed)} 份归档原文")
    print(f"补脱敏 {len(changed)} 份：" + "、".join(Path(c).name for c in changed[:10]))
    return 0


# ---------- 杂项 ----------

class BudgetBlocked(Exception):
    pass


def now() -> dt.datetime:
    return dt.datetime.now(TZ)


def yaml_str(v: str) -> str:
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'


def die(code: int, msg: str) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workspace", default=str(ROOT), help="工作区根目录（默认脚本上一级）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    add = sub.add_parser("add", help="采一份原文落盘")
    add.add_argument("--source", required=True, choices=SOURCES)
    add.add_argument("--url", default="", help="原文出处；主人粘的正文可留空")
    add.add_argument("--title", required=True)
    g = add.add_mutually_exclusive_group(required=True)
    g.add_argument("--stdin", action="store_true", help="正文从标准输入读")
    g.add_argument("--file", help="正文从本地纯文本文件读")

    st = sub.add_parser("status", help="打印 MANIFEST 统计")
    st.add_argument("--json", action="store_true")

    mk = sub.add_parser("mark", help="给一条原文记去向")
    mk.add_argument("sha8")
    mk.add_argument("--disposition", required=True, choices=DISPOSITIONS)
    mk.add_argument("--note", default=None)

    sub.add_parser("rescan", help="按当前规则给已归档原文补脱敏")

    a = ap.parse_args()
    ws = Path(a.workspace).resolve()
    if not (ws / "AGENTS.md").exists():
        die(5, f"{ws} 看着不像工作区（没有 AGENTS.md）")
    return {"add": cmd_add, "status": cmd_status, "mark": cmd_mark, "rescan": cmd_rescan}[a.cmd](a, ws)


if __name__ == "__main__":
    raise SystemExit(main())
