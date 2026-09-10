#!/usr/bin/env python3
"""
Daily Session Review / Skill Extraction MVP.

Reads OpenClaw session JSONL files for a target date, creates a compact report:
- touched sessions
- user asks / assistant replies
- tool failures / incidents
- candidate workflows worth turning into skills/memory/TODOs

Default date: yesterday in Asia/Shanghai.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import glob
from difflib import SequenceMatcher
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

TZ = dt.timezone(dt.timedelta(hours=8))
WORKSPACE = Path(os.environ.get("WORKSPACE", "/home/openclaw/makaron-openclaw/.openclaw-local/workspace"))
SESSION_DIR = Path(os.environ.get("SESSION_DIR", os.path.expanduser("~/.openclaw/agents/makaron/sessions")))
OUT_DIR = WORKSPACE / "memory" / "daily-session-review"
REFLECTIONS_DIR = WORKSPACE / "memory" / "reflections"
SKILL_CANDIDATES_PATH = WORKSPACE / "memory" / "skill-candidates.md"
LIVE_SKILL_DIRS = [Path(os.path.expanduser("~/.agents/skills")), Path(os.path.expanduser("~/.openclaw/skills"))]

SENSITIVE_RE = re.compile(
    r"("
    r"mk_live_[A-Za-z0-9_\-]+"
    r"|sk-[A-Za-z0-9_\-]+"
    r"|Bearer\s+[A-Za-z0-9._~+/=\-]+"
    r"|PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*[:=]\s*[\"']?[^\"'\s,&}]+"
    r"|[?&]?[A-Za-z0-9_.\-]*token=[^&\s\"'<>}]+"
    r")",
    re.I,
)
MSG_ID_RE = re.compile(r"\[message_id:\s*([^\]]+)\]")
CHAT_ID_RE = re.compile(r"(oc_[a-zA-Z0-9]+|user:ou_[a-zA-Z0-9]+|ou_[a-zA-Z0-9]+)")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

KEYWORDS = {
    "skill_candidate": ["skill", "技能", "提炼", "沉淀", "流程", "SOP", "自动", "dashboard", "监控", "stalled", "worker", "cron", "总结"],
    "incident": ["stalled", "卡住", "慢", "报错", "失败", "漏", "重启", "timeout", "error", "orphan", "blocked"],
    "decision": ["设成默认", "以后", "不要", "先不", "保留", "确认", "决定", "规则", "默认"],
    "deliverable": ["已发送", "完成", "文档", "视频", "链接", "dashboard", "生成", "交付"],
}

# Do not ask Tianyi to approve a skill that already exists. Keep this small and
# explicit for deterministic candidates; broader semantic dedupe belongs in the
# next review pipeline iteration.
EXISTING_SKILL_CANDIDATES = {
    "feishu-channel-card-workflow": [
        "~/.agents/skills/feishu-channel-cards/SKILL.md",
        str(WORKSPACE / ".agents/skills/feishu-channel-cards/SKILL.md"),
    ],
    # Tianyi: already handled; do not keep asking for approval.
    "remote-browser-cdp-workflow": [
        "~/.agents/skills/remote-browser-cdp/SKILL.md",
        str(WORKSPACE / ".agents/skills/remote-browser-cdp/SKILL.md"),
    ],
}

# Explicitly rejected / skipped candidates. These are not just "not yet"; do
# not resurface them in nightly approval cards unless Tianyi asks to revisit.
SUPPRESSED_SKILL_CANDIDATES = {
    "feishu-doc-comment-event-sop": "Skipped by Tianyi on 2026-06-15; not needed, do not repeat.",
}

# Skill approvals should be high-signal. A single session can be important, but
# it should not be promoted into the approval card unless Tianyi explicitly asked
# for skill extraction/proposal creation; otherwise hold it for repeat evidence.
MIN_SKILL_PROMOTION_REPEAT_COUNT = 2
ONE_OFF_SCORE_CAP = 2.4
REFLECTION_REPEAT_LOOKBACK_DAYS = 45
MIN_REFLECTION_REPEAT_COUNT = 2
RECENT_APPROVAL_DEDUPE_DAYS = 7
EXPLICIT_SKILL_PROMOTION_RE = re.compile(
    r"("
    r"提炼成\s*skill|沉淀成\s*skill|做成\s*skill|创建\s*skill|生成\s*skill"
    r"|提炼成\s*技能|沉淀成\s*技能|做成\s*技能|创建\s*技能|生成\s*技能"
    r"|skill\s+proposal|write\s+(?:a\s+)?skill\s+proposal|create\s+(?:a\s+)?skill"
    r")",
    re.I,
)

REFLECTION_REPEAT_PATTERNS = [
    {
        "id": "db-schema-assumption",
        "label": "Database schema assumption",
        "keywords": ["column", "schema", "field", "table", "mapping", "数据库", "字段", "表结构"],
        "trigger": "Before a task reads or writes database records and the schema is not freshly verified.",
        "reusable": "A repeatable verification gate for database/API work: inspect schema first, then perform the operation.",
    },
    {
        "id": "task-status-not-updated",
        "label": "Task status update after completion",
        "keywords": ["status", "not updated", "backlog", "task status", "待办", "状态", "完成后"],
        "trigger": "After completing heartbeat/TODO/project work that has an external status marker.",
        "reusable": "A closing checklist that updates the task record, writes evidence, and prevents stale work queues.",
    },
    {
        "id": "missing-reflection",
        "label": "Reflection capture after meaningful work",
        "keywords": ["reflection", "forgot", "missing", "not written", "反思", "复盘", "没有写"],
        "trigger": "After non-trivial work, repeated workflows, failures, or explicit user corrections.",
        "reusable": "A lightweight end-of-task learning workflow that records one reusable lesson without touching durable memory.",
    },
    {
        "id": "heartbeat-gap",
        "label": "Heartbeat gap recovery",
        "keywords": ["gap", "interrupted", "blank", "no record", "heartbeat", "中断", "空白"],
        "trigger": "When heartbeat or background automation has a gap, missed run, or unexplained silent interval.",
        "reusable": "A recovery routine for explaining the gap, checking task state, and escalating repeated misses.",
    },
    {
        "id": "silent-tool-switch",
        "label": "Tool failure reporting before fallback",
        "keywords": ["silent", "tool failed", "unreported", "switch", "failed", "failure", "失败", "切换", "没报告"],
        "trigger": "When a tool fails and the agent needs to retry, change tools, or use a fallback path.",
        "reusable": "A communication rule for surfacing failure, impact, and fallback before continuing.",
    },
    {
        "id": "read-before-exec",
        "label": "Read before modifying implementation",
        "keywords": ["read", "file", "confirm", "structure", "before modify", "读取", "修改前", "先看"],
        "trigger": "Before editing code, config, docs, memory, or workflow files.",
        "reusable": "A pre-edit inspection habit that reduces false assumptions and protects unrelated user changes.",
    },
    {
        "id": "rule-exists-not-executed",
        "label": "Existing rule enforcement",
        "keywords": ["rule exists", "known but", "not executed", "upgrade", "规则", "没执行"],
        "trigger": "When a known rule exists but was skipped, misunderstood, or only partially applied.",
        "reusable": "A rule-promotion workflow that turns repeated misses into stronger triggers or candidate skills.",
    },
    {
        "id": "blocked-task-not-surfaced",
        "label": "Blocked task surfacing",
        "keywords": ["blocked", "waiting", "needs confirmation", "cannot close", "阻塞", "等待确认"],
        "trigger": "When work cannot close without user input, external state, credentials, or missing access.",
        "reusable": "A blocker-reporting workflow that keeps pending tasks visible instead of letting them accumulate silently.",
    },
]


def now_local() -> dt.datetime:
    return dt.datetime.now(TZ)


def candidate_already_has_skill(key: str) -> bool:
    return any(Path(os.path.expanduser(p)).exists() for p in EXISTING_SKILL_CANDIDATES.get(key, []))


def candidate_is_suppressed(key: str) -> bool:
    return key in SUPPRESSED_SKILL_CANDIDATES


def proposal_slug_for_title(title: str) -> str:
    """Match proposal filename slugging used by approval-card scripts."""
    return re.sub(r"[^a-z0-9\u4e00-\u9fa5]+", "-", str(title or "").lower()).strip("-")[:80] or "candidate"


def load_recent_review_candidate_titles(day: dt.date, lookback_days: int = RECENT_APPROVAL_DEDUPE_DAYS) -> set[str]:
    """Return candidate titles that already appeared in recent daily review reports/cards.

    This prevents old Knight-reflection repeats from resurfacing every midnight as
    fresh approval-card suggestions. The daily report can still mention them as
    historical/held items, but the interactive card should only contain genuinely
    new candidates.
    """
    seen: set[str] = set()
    for i in range(1, lookback_days + 1):
        p = OUT_DIR / f"{(day - dt.timedelta(days=i)).isoformat()}.json"
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        for c in d.get("candidates") or []:
            title = str(c.get("title") or "").strip()
            if title:
                seen.add(title)
    return seen


def candidate_has_existing_proposal(c: dict[str, Any]) -> str | None:
    """Detect approval artifacts already created for the same candidate title."""
    title = str(c.get("title") or "").strip()
    if not title:
        return None
    slug = proposal_slug_for_title(title)
    patterns = [
        str(WORKSPACE / "memory" / "proposals" / f"*-memory-{slug}.md"),
        str(WORKSPACE / "memory" / "proposals" / f"*{slug}.md"),
        str(WORKSPACE / "memory" / "skill-proposals" / f"*{slug}.md"),
    ]
    for pattern in patterns:
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[0]
    return None


SKILL_DEDUPE_STOPWORDS = {
    "the", "and", "for", "with", "from", "into", "when", "need", "needs", "using", "use",
    "skill", "candidate", "workflow", "workflows", "sop", "tool", "tools", "agent", "agents",
    "review", "daily", "session", "sessions", "future", "reusable", "trigger", "status",
}
_LIVE_SKILL_CACHE: list[dict[str, str]] | None = None


def _strip_yaml_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] in {'"', "'"} and value[-1] == value[0]:
        return value[1:-1]
    return value


def _extract_frontmatter_field(lines: list[str], field: str) -> str:
    """Extract a simple YAML frontmatter scalar/block field without a YAML dependency."""
    prefix = f"{field}:"
    for i, line in enumerate(lines):
        if not line.startswith(prefix):
            continue
        value = line[len(prefix):].strip()
        if value in {"|", ">", "|-", ">-", "|+", ">+"}:
            block: list[str] = []
            for nxt in lines[i + 1:]:
                if nxt and not nxt.startswith((" ", "\t", "- ")) and re.match(r"^[A-Za-z_][A-Za-z0-9_-]*\s*:", nxt):
                    break
                block.append(nxt.strip())
            return trim(" ".join(x for x in block if x), 1000)
        return _strip_yaml_scalar(value)
    return ""


def parse_skill_metadata(path: Path) -> dict[str, str] | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None

    frontmatter = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            frontmatter = parts[1]
    lines = frontmatter.splitlines()[:80]
    name = _extract_frontmatter_field(lines, "name") or path.parent.name
    description = _extract_frontmatter_field(lines, "description")
    return {"name": name.strip(), "description": description.strip(), "path": str(path)}


def load_live_skills() -> list[dict[str, str]]:
    """Scan installed user/OpenClaw skill directories for SKILL.md metadata."""
    global _LIVE_SKILL_CACHE
    if _LIVE_SKILL_CACHE is not None:
        return _LIVE_SKILL_CACHE

    skills: list[dict[str, str]] = []
    seen: set[str] = set()
    for root in LIVE_SKILL_DIRS:
        if not root.exists():
            continue
        for path in sorted(root.glob("*/SKILL.md")):
            real = str(path.resolve())
            if real in seen:
                continue
            seen.add(real)
            meta = parse_skill_metadata(path)
            if meta and meta.get("name"):
                skills.append(meta)
    _LIVE_SKILL_CACHE = skills
    return skills


def normalize_for_match(text: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", text.lower()).strip()


def keyword_tokens(text: str) -> set[str]:
    normalized = normalize_for_match(text)
    tokens: set[str] = set()
    for token in normalized.split():
        if len(token) <= 2 or token in SKILL_DEDUPE_STOPWORDS:
            continue
        # cheap singularization for names like card/cards without pulling in a stemmer
        if token.endswith("s") and len(token) > 4:
            token = token[:-1]
        tokens.add(token)
    return tokens


def skill_duplicate_match(candidate: dict[str, Any], live_skills: list[dict[str, str]] | None = None) -> dict[str, Any] | None:
    """Return the strongest installed-skill overlap for a candidate, if significant."""
    if candidate.get("recommendation") != "skill_candidate":
        return None
    live_skills = live_skills if live_skills is not None else load_live_skills()
    candidate_name = " ".join(str(candidate.get(k, "")) for k in ("key", "title"))
    candidate_pattern = " ".join(
        str(candidate.get(k, "")) for k in ("key", "title", "why", "trigger", "reusable")
    )
    cand_name_norm = normalize_for_match(candidate_name)
    cand_name_tokens = keyword_tokens(candidate_name)
    cand_pattern_tokens = keyword_tokens(candidate_pattern)

    best: dict[str, Any] | None = None
    for skill in live_skills:
        skill_name = skill.get("name", "")
        skill_desc = skill.get("description", "")
        skill_name_norm = normalize_for_match(skill_name)
        skill_name_tokens = keyword_tokens(skill_name)
        skill_all_tokens = keyword_tokens(f"{skill_name} {skill_desc}")
        if not skill_name_norm:
            continue

        name_ratio = SequenceMatcher(None, cand_name_norm, skill_name_norm).ratio()
        name_shared = cand_name_tokens & skill_name_tokens
        name_union = cand_name_tokens | skill_name_tokens
        name_overlap = len(name_shared) / len(name_union) if name_union else 0.0
        pattern_shared = cand_pattern_tokens & skill_all_tokens
        pattern_overlap = len(pattern_shared) / len(cand_pattern_tokens) if cand_pattern_tokens else 0.0

        reason = ""
        strength = 0.0
        if cand_name_norm == skill_name_norm or skill_name_norm in cand_name_norm:
            strength = 1.0
            reason = "installed skill name is contained in candidate name"
        elif name_ratio >= 0.82:
            strength = name_ratio
            reason = f"skill-name similarity {name_ratio:.2f}"
        elif len(name_shared) >= 2 and name_overlap >= 0.50:
            strength = 0.80 + min(name_overlap, 1.0) * 0.1
            reason = f"shared name keywords: {', '.join(sorted(name_shared))}"
        elif len(pattern_shared) >= 4 and pattern_overlap >= 0.42:
            strength = 0.65 + min(pattern_overlap, 1.0) * 0.1
            reason = f"shared pattern keywords: {', '.join(sorted(pattern_shared)[:8])}"

        if reason and (best is None or strength > float(best.get("strength", 0))):
            best = {
                "name": skill_name,
                "path": skill.get("path", ""),
                "description": skill_desc,
                "reason": reason,
                "strength": round(strength, 2),
            }
    return best


def is_subagent_key(key: str) -> bool:
    """Return True if the session key belongs to a sub-agent spawn.

    Sub-agent sessions contain assistant_texts that are full of bootstrap
    instructions, tool outputs, and internal context — not the original user
    request.  Excluding them from evidence extraction avoids false keyword
    matches and noisy evidence snippets.
    """
    return key.startswith("agent:makaron:subagent:")


def parse_ts(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return t.astimezone(TZ)
    except Exception:
        return None


def redact(text: str) -> str:
    return SENSITIVE_RE.sub("【REDACTED】", text)


def trim(text: str, n: int = 500) -> str:
    text = redact(re.sub(r"\s+", " ", text).strip())
    return text if len(text) <= n else text[: n - 1] + "…"


def slugify_key(text: str, fallback: str = "candidate") -> str:
    slug = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", text.lower()).strip("-")
    return slug[:80] or fallback


def read_text_safe(path: Path) -> tuple[str, str | None]:
    try:
        return path.read_text(encoding="utf-8", errors="replace"), None
    except Exception as exc:
        return "", f"{path}: {type(exc).__name__}: {exc}"


def iter_jsonl_safe(path: Path):
    try:
        with path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except Exception:
        return


def parse_markdown_yaml_candidates(path: Path = SKILL_CANDIDATES_PATH) -> tuple[list[dict[str, Any]], list[str]]:
    """Parse memory/skill-candidates.md without adding a YAML dependency."""
    text, err = read_text_safe(path)
    if err:
        return [], [err]
    entries: list[dict[str, Any]] = []
    current_heading = ""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("### "):
            current_heading = line[4:].strip()
            i += 1
            continue
        if line.strip() != "```yaml":
            i += 1
            continue

        block: list[str] = []
        i += 1
        while i < len(lines) and lines[i].strip() != "```":
            block.append(lines[i])
            i += 1

        parsed: dict[str, Any] = {}
        current_key: str | None = None
        for raw in block:
            if not raw.strip():
                continue
            scalar = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", raw)
            if scalar:
                current_key = scalar.group(1)
                value = scalar.group(2).strip()
                parsed[current_key] = [] if value == "" else _strip_yaml_scalar(value)
                continue
            item = re.match(r"^\s*-\s*(.*)$", raw)
            if item and current_key:
                if not isinstance(parsed.get(current_key), list):
                    parsed[current_key] = []
                parsed[current_key].append(_strip_yaml_scalar(item.group(1).strip()))

        name = str(parsed.get("name") or current_heading).strip()
        if name:
            parsed["name"] = name
            entries.append(parsed)
        i += 1
    return entries, []


def reflection_pattern_key(row: dict[str, Any]) -> str | None:
    text = " ".join(
        str(row.get(k, "") or "")
        for k in ("what_failed", "next_time", "context", "task_type")
    ).lower()
    tags = row.get("tags")
    if isinstance(tags, list):
        text += " " + " ".join(str(x).lower() for x in tags)
    for pattern in REFLECTION_REPEAT_PATTERNS:
        if any(kw.lower() in text for kw in pattern["keywords"]):
            return str(pattern["id"])

    normalized = normalize_for_match(" ".join(str(row.get(k, "") or "") for k in ("next_time", "what_failed")))
    tokens = [t for t in normalized.split() if t not in SKILL_DEDUPE_STOPWORDS and len(t) > 2]
    if len(tokens) < 4:
        return None
    return "phrase:" + "-".join(tokens[:8])


def load_reflection_repeat_signals(day: dt.date) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    if not REFLECTIONS_DIR.exists():
        return [], [f"{REFLECTIONS_DIR}: reflections directory not found"]
    try:
        files = sorted(REFLECTIONS_DIR.glob("*.jsonl"))
    except Exception as exc:
        return [], [f"{REFLECTIONS_DIR}: {type(exc).__name__}: {exc}"]

    cutoff = day - dt.timedelta(days=REFLECTION_REPEAT_LOOKBACK_DAYS - 1)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for path in files:
        for row in iter_jsonl_safe(path):
            created = parse_ts(str(row.get("created_at") or ""))
            row_date = created.date() if created else None
            if row_date and (row_date < cutoff or row_date > day):
                continue
            key = reflection_pattern_key(row)
            if key:
                grouped[key].append(row)

    signals: list[dict[str, Any]] = []
    by_id = {p["id"]: p for p in REFLECTION_REPEAT_PATTERNS}
    for key, rows in grouped.items():
        if len(rows) < MIN_REFLECTION_REPEAT_COUNT:
            continue
        pattern = by_id.get(key)
        label = pattern["label"] if pattern else key.replace("phrase:", "Repeated reflection phrase: ")
        trigger = pattern["trigger"] if pattern else "When this same lesson appears across multiple Knight reflections."
        reusable = pattern["reusable"] if pattern else "A repeated Knight reflection indicates a workflow or rule worth reviewing for promotion."
        confidences = [int(r.get("confidence")) for r in rows if str(r.get("confidence", "")).isdigit()]
        signals.append({
            "key": key,
            "label": label,
            "count": len(rows),
            "confidence_avg": round(sum(confidences) / len(confidences), 2) if confidences else None,
            "trigger": trigger,
            "reusable": reusable,
            "examples": [
                trim(" | ".join(str(r.get(k, "") or "") for k in ("context", "what_failed", "next_time")), 320)
                for r in rows[:3]
            ],
        })
    signals.sort(key=lambda x: (-int(x["count"]), str(x["label"])))
    return signals, warnings


def iter_content_blocks(content: Any) -> list[dict[str, Any]]:
    """Normalize OpenClaw message content across transcript schema versions.

    Older transcripts mostly store content as a list of typed dict blocks. Newer
    tool/runtime messages can contain plain strings (or a single dict), which
    previously crashed the nightly review with `'str' object has no attribute get`.
    """
    if content is None:
        return []
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, dict):
        return [content]
    if not isinstance(content, list):
        return [{"type": "text", "text": str(content)}]

    blocks: list[dict[str, Any]] = []
    for item in content:
        if isinstance(item, dict):
            blocks.append(item)
        elif isinstance(item, str):
            blocks.append({"type": "text", "text": item})
        elif item is not None:
            blocks.append({"type": "text", "text": str(item)})
    return blocks


def text_from_content(content: Any) -> str:
    parts: list[str] = []
    for c in iter_content_blocks(content):
        typ = c.get("type")
        if typ in ("text", "input_text", "output_text"):
            parts.append(str(c.get("text", "")))
        elif typ == "toolCall":
            parts.append(f"[tool:{c.get('name', 'unknown')}] {json.dumps(c.get('input', {}), ensure_ascii=False)[:300]}")
    return "\n".join(parts)


def load_index() -> dict[str, Any]:
    p = SESSION_DIR / "sessions.json"
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def session_key_for_id(index: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, val in index.items():
        if isinstance(val, dict) and val.get("sessionId"):
            out[str(val["sessionId"])] = key
    return out


def iter_jsonl(path: Path):
    with path.open(errors="ignore") as f:
        for line in f:
            try:
                yield json.loads(line)
            except Exception:
                continue


def classify_text(text: str) -> set[str]:
    low = text.lower()
    cats = set()
    for cat, kws in KEYWORDS.items():
        if any(k.lower() in low for k in kws):
            cats.add(cat)
    return cats


def candidate_session_files() -> list[tuple[str, Path]]:
    """Return canonical session transcript files.

    Include active `<uuid>.jsonl` and reset snapshots `<uuid>.jsonl.reset.*`.
    Exclude checkpoint/trajectory/bak files because they duplicate transcript content.
    """
    files: list[tuple[str, Path]] = []
    for path in sorted(SESSION_DIR.iterdir()):
        name = path.name
        if not path.is_file():
            continue
        if ".checkpoint." in name or ".trajectory" in name or ".bak" in name:
            continue
        sid = None
        if name.endswith(".jsonl"):
            sid = name[:-6]
        else:
            m = re.match(r"^([0-9a-f-]{36})\.jsonl\.reset\.", name, re.I)
            if m:
                sid = m.group(1)
        if sid and UUID_RE.match(sid):
            files.append((sid, path))
    return files


# Only these IDs may be presented as Tianyi in a report. Keep the default scoped to
# the owner ID known to this runtime; deployments with more than one owner identity
# can set DAILY_REVIEW_OWNER_OPEN_IDS="ou_xxx,ou_yyy".
OWNER_OPEN_IDS = {
    item.strip().removeprefix("user:")
    for item in os.environ.get(
        "DAILY_REVIEW_OWNER_OPEN_IDS",
        "ou_cb133fd4414f0607e8b46a3195c7b9d8",
    ).split(",")
    if item.strip()
}


def direct_sender_id(session_key: str) -> str | None:
    match = re.search(r":direct:(user:)?(ou_[A-Za-z0-9]+)$", session_key)
    return match.group(2) if match else None


def direct_sender_label(session_key: str, user_texts: list[dict[str, str]]) -> str:
    """Return an attribution label without guessing a DM sender's identity.

    Session keys carry an immutable Feishu open_id but not always a display name.
    A direct chat must therefore never default to Tianyi merely because it is a DM.
    """
    sender_id = direct_sender_id(session_key)
    if sender_id in OWNER_OPEN_IDS:
        return "Tianyi"

    # Some inbound transcripts preserve a human display name before the colon.
    # Use it only when it is not an opaque ID; otherwise retain the verifiable ID.
    for item in user_texts:
        text = str(item.get("text") or "")
        match = re.search(r"\[message_id:[^\]]+\]\s+([^:\n]{1,80}):", text)
        if match:
            candidate = match.group(1).strip()
            if candidate and not re.fullmatch(r"(?:user:)?ou_[A-Za-z0-9]+", candidate):
                return candidate

    return f"未识别发起人（{sender_id or '未知 ID'}）"


def should_skip_session(key: str, index_info: dict[str, Any] | None = None) -> bool:
    # Keep general V/Makaron ops review clean; private companion reviews have separate pipeline.
    low_key = key.lower()
    if "companion" in low_key or ":telegram:direct:" in low_key:
        return True
    if isinstance(index_info, dict):
        channel = str(index_info.get("lastChannel") or index_info.get("deliveryContext", {}).get("channel") or "").lower()
        chat_type = str(index_info.get("chatType") or "").lower()
        if channel == "telegram" and chat_type == "direct":
            return True
    return False


def collect_for_date(day: dt.date) -> dict[str, Any]:
    index = load_index()
    id_to_key = session_key_for_id(index)
    info_by_sid = {str(v.get("sessionId")): v for v in index.values() if isinstance(v, dict) and v.get("sessionId")}
    sessions: list[dict[str, Any]] = []

    for sid, path in candidate_session_files():
        key = id_to_key.get(sid, sid)
        if should_skip_session(key, info_by_sid.get(sid)):
            continue
        messages = []
        counts = Counter()
        first_ts = None
        last_ts = None
        categories = Counter()
        tool_names = Counter()
        user_texts = []
        assistant_texts = []
        failures = []

        for rec in iter_jsonl(path):
            ts = parse_ts(rec.get("timestamp"))
            if not ts or ts.date() != day:
                continue
            if first_ts is None or ts < first_ts:
                first_ts = ts
            if last_ts is None or ts > last_ts:
                last_ts = ts

            typ = rec.get("type")
            if typ == "message":
                msg = rec.get("message") or {}
                role = msg.get("role", "unknown")
                text = text_from_content(msg.get("content") or [])
                text = redact(text)
                counts[role] += 1
                cats = classify_text(text)
                for c in cats:
                    categories[c] += 1
                if role == "user" and text.strip():
                    user_texts.append({"time": ts.isoformat(timespec="minutes"), "text": trim(text, 650)})
                elif role == "assistant" and text.strip():
                    # Sub-agent assistant texts are full of bootstrap/context noise; skip entirely.
                    if is_subagent_key(key):
                        pass
                    # Assistant messages containing only tool calls are less useful; keep final-looking text.
                    elif not text.strip().startswith("[tool:") or "失败" in text or "error" in text.lower():
                        assistant_texts.append({"time": ts.isoformat(timespec="minutes"), "text": trim(text, 650)})
                elif role == "toolResult" and text.strip():
                    low = text.lower()
                    if any(w in low for w in ["error", "failed", "exception", "aborted", "forbidden", "timeout", "stalled"]):
                        failures.append({"time": ts.isoformat(timespec="minutes"), "text": trim(text, 650)})

                for c in iter_content_blocks(msg.get("content")):
                    if c.get("type") == "toolCall":
                        tool_names[str(c.get("name", "unknown"))] += 1

            elif typ in ("model_change", "thinking_level_change", "custom", "custom_message"):
                counts[typ] += 1

        if first_ts:
            combined_preview = "\n".join([x.get("text", "") for x in user_texts + assistant_texts + failures])
            private_markers = [
                "COMPANION-01",
                "V🍑",
                "exclusive secret lover",
                "[Telegram",
                "Telegram TianyiC",
                "companion-01-hourly-heartbeat",
            ]
            if any(marker in combined_preview for marker in private_markers):
                continue
            # Keep sessions with either user messages or meaningful assistant/tool failures.
            if user_texts or assistant_texts or failures:
                sessions.append({
                    "sessionId": sid,
                    "sessionKey": key,
                    "initiator": direct_sender_label(key, user_texts) if ":direct:" in key else None,
                    "first": first_ts.isoformat(timespec="minutes"),
                    "last": last_ts.isoformat(timespec="minutes") if last_ts else first_ts.isoformat(timespec="minutes"),
                    "counts": dict(counts),
                    "categories": dict(categories),
                    "tools": dict(tool_names.most_common(8)),
                    "user_texts": user_texts[-8:],
                    "assistant_texts": assistant_texts[-5:],
                    "failures": failures[-5:],
                })

    return {"date": day.isoformat(), "sessions": sessions}


def infer_candidates(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Infer transferable skill candidates, not incident/project-status items.

    A real skill candidate must satisfy at least two of:
    - reusable across projects/channels
    - procedural workflow or API/tool integration
    - has a clear trigger for future agents
    - reduces repeated reasoning/coding

    Bug follow-ups, monitoring items, model config drift, and one-off project tasks should be
    reported elsewhere, not as skill candidates.
    """
    candidates: dict[str, dict[str, Any]] = {}

    def bounded_score(value: int | float) -> int:
        """Normalize a dimension score onto the required 1-5 scale."""
        return max(1, min(5, int(round(value))))

    def repeat_count_for(c: dict[str, Any]) -> int:
        raw = c.get("repeat_count")
        if isinstance(raw, (int, float)):
            return max(1, int(raw))
        if isinstance(raw, str) and raw.strip().isdigit():
            return max(1, int(raw.strip()))
        reflection_count = c.get("reflection_repeat_count")
        if isinstance(reflection_count, (int, float)):
            return max(1, int(reflection_count))
        sessions = c.get("sessions") or []
        if isinstance(sessions, list):
            unique_sessions = {str(x) for x in sessions if x}
            if unique_sessions:
                return len(unique_sessions)
        source_refs = c.get("source_reflections") or []
        if isinstance(source_refs, list) and source_refs:
            return len({str(x) for x in source_refs if x}) or 1
        return 1

    def explicit_skill_promotion_requested(c: dict[str, Any]) -> bool:
        if c.get("explicit_candidate_file"):
            return True
        text = " ".join(
            [str(c.get(k, "")) for k in ("title", "why", "trigger", "reusable")]
            + [str(e) for e in (c.get("evidence") or [])]
        )
        return bool(EXPLICIT_SKILL_PROMOTION_RE.search(text))

    def score_operational_value(c: dict[str, Any]) -> int:
        text = " ".join(str(c.get(k, "")) for k in ("title", "why", "reusable", "trigger")).lower()
        score = 3
        rec = c.get("recommendation", "")
        if rec == "skill_candidate":
            score += 1
        elif rec == "memory":
            score += 0  # memory candidates are valuable but don't score like skills
        elif rec == "system_rule":
            score += 2  # system rules are high-impact
        if c.get("source") in {"knight_reflections", "skill_candidates_md"}:
            score += 1
        if any(k in text for k in ["automation", "自动", "workflow", "sop", "api", "tool", "integration", "cross-project", "dashboard", "approval", "交付", "long-running"]):
            score += 1
        if any(k in text for k in ["one-off", "single project", "manual review", "status only"]):
            score -= 1
        return bounded_score(score)

    def score_trigger_clarity(c: dict[str, Any]) -> int:
        trigger = str(c.get("trigger", "")).strip()
        low = trigger.lower()
        if not trigger or trigger in {"—", "unknown"}:
            return 1
        score = 2
        if len(trigger) >= 40:
            score += 1
        if any(k in low for k in ["need to", "when", "if", "asks", "daily", "weekly", "需要"]):
            score += 1
        if any(k in low for k in ["feishu", "browser", "card", "doc", "review", "approval", "报告", "评论"]):
            score += 1
        if any(k in low for k in ["maybe", "unclear", "general", "various"]):
            score -= 1
        return bounded_score(score)

    def score_risk(c: dict[str, Any]) -> int:
        # Higher is safer: 5 = low risk, 1 = high risk.
        text = " ".join(str(c.get(k, "")) for k in ("title", "why", "reusable", "trigger")).lower()
        score = 5
        if any(k in text for k in ["browser", "logged-in", "admin", "customer", "external", "send/update", "feishu card", "event subscription"]):
            score -= 1
        if any(k in text for k in ["payment", "wallet", "credential", "delete", "production", "prod", "dns", "token", "approval"]):
            score -= 1
        if any(k in text for k in ["personal", "private", "sensitive", "customer-facing"]):
            score -= 1
        return bounded_score(score)

    def score_reflection_repeats(c: dict[str, Any]) -> int:
        repeat_count = int(c.get("reflection_repeat_count") or 0)
        score = repeat_count
        if c.get("source") == "knight_reflections":
            score += 1
        if c.get("explicit_candidate_file"):
            score += 1
        return bounded_score(score or 1)

    def score_candidate(c: dict[str, Any]) -> None:
        repeat_count = repeat_count_for(c)
        scores = {
            "repeat_count": bounded_score(repeat_count),
            "operational_value": score_operational_value(c),
            "trigger_clarity": score_trigger_clarity(c),
            "reflection_repeats": score_reflection_repeats(c),
            "risk": score_risk(c),
        }
        combined = (
            scores["repeat_count"] * 0.25
            + scores["operational_value"] * 0.25
            + scores["trigger_clarity"] * 0.2
            + scores["reflection_repeats"] * 0.15
            + scores["risk"] * 0.15
        )
        scores["combined"] = round(combined, 2)
        c["repeat_count"] = repeat_count
        c["scores"] = scores
        c["score_breakdown"] = (
            f"repeat_count={scores['repeat_count']} ({repeat_count} signal(s)) ×0.25 + "
            f"operational_value={scores['operational_value']} ×0.25 + "
            f"trigger_clarity={scores['trigger_clarity']} ×0.2 + "
            f"reflection_repeats={scores['reflection_repeats']} ×0.15 + "
            f"risk={scores['risk']} ×0.15 = {scores['combined']}"
        )

    def add(
        key: str,
        title: str,
        why: str,
        rec: str,
        evidence: str,
        *,
        trigger: str,
        reusable: str,
        session_key: str | None = None,
    ):
        # Suppressed candidates are explicit human decisions. Installed-skill
        # duplicates are handled later so they can be recorded and explained.
        if rec == "skill_candidate" and candidate_is_suppressed(key):
            return
        c = candidates.setdefault(
            key,
            {
                "key": key,
                "title": title,
                "why": why,
                "trigger": trigger,
                "reusable": reusable,
                "recommendation": rec,
                "sessions": [],
                "evidence": [],
            },
        )
        if session_key and session_key not in c["sessions"]:
            c["sessions"].append(session_key)
        if evidence and len(c["evidence"]) < 4:
            c["evidence"].append(evidence)

    def as_list(value: Any) -> list[str]:
        if isinstance(value, list):
            return [str(x) for x in value if str(x).strip()]
        if value in (None, "", "[]"):
            return []
        return [str(value)]

    reflection_signals, reflection_warnings = load_reflection_repeat_signals(dt.date.fromisoformat(data["date"]))
    skill_file_entries, skill_file_warnings = parse_markdown_yaml_candidates()
    data["candidate_scoring_inputs"] = {
        "reflection_repeat_signals": len(reflection_signals),
        "skill_candidates_md_entries": len(skill_file_entries),
        "warnings": reflection_warnings + skill_file_warnings,
    }
    data["reflection_repeat_signals"] = reflection_signals[:12]

    for signal in reflection_signals:
        key = f"knight-reflection-{slugify_key(str(signal.get('key', 'repeat')))}"
        # Use classification from PATTERN_MAP if available, else fall back to skill_candidate
        classification = str(signal.get("classification", "skill_candidate") or "skill_candidate").strip()
        if classification not in {"skill_candidate", "memory", "system_rule"}:
            classification = "skill_candidate"
        add(
            key,
            f"Knight reflection repeat: {signal['label']}",
            f"Knight reflections repeated this pattern {signal['count']} times in the last {REFLECTION_REPEAT_LOOKBACK_DAYS} days.",
            classification,
            f"reflection-repeat ×{signal['count']}: {signal['examples'][0] if signal.get('examples') else signal['label']}",
            trigger=str(signal.get("trigger") or "When the repeated reflection pattern appears again."),
            reusable=str(signal.get("reusable") or "Repeated reflections are a promotion signal for a reusable workflow."),
        )
        c = candidates[key]
        c["source"] = "knight_reflections"
        c["reflection_repeat_count"] = int(signal.get("count") or 1)
        c["repeat_count"] = int(signal.get("count") or 1)
        c["reflection_signal"] = signal
        for example in signal.get("examples", [])[1:4]:
            if len(c["evidence"]) < 4:
                c["evidence"].append(f"reflection-repeat: {example}")

    for entry in skill_file_entries:
        status = str(entry.get("status") or "draft").strip().lower()
        if status in {"promoted", "rejected"}:
            continue
        name = str(entry.get("name") or "Unnamed skill candidate").strip()
        key = f"skill-candidates-md-{slugify_key(name)}"
        steps = as_list(entry.get("steps"))
        validation = as_list(entry.get("validation"))
        examples = as_list(entry.get("examples"))
        source_reflections = as_list(entry.get("source_reflections"))
        reusable_parts = []
        if steps:
            reusable_parts.append("Steps: " + "; ".join(steps[:3]))
        if validation:
            reusable_parts.append("Validation: " + "; ".join(validation[:2]))
        add(
            key,
            name,
            "Explicit reusable workflow recorded in memory/skill-candidates.md for nightly promotion review.",
            "skill_candidate",
            examples[0] if examples else f"memory/skill-candidates.md status={status}",
            trigger=str(entry.get("trigger") or "When this recorded candidate workflow is needed again."),
            reusable=" ".join(reusable_parts) or "Recorded candidate workflow awaiting data-driven promotion decision.",
        )
        c = candidates[key]
        c["source"] = "skill_candidates_md"
        c["explicit_candidate_file"] = True
        c["skill_candidate_status"] = status or "draft"
        c["source_reflections"] = source_reflections
        c["repeat_count"] = max(1, len(source_reflections), len(examples))
        for ref in source_reflections[:3]:
            if len(c["evidence"]) < 4:
                c["evidence"].append(f"source_reflection: {ref}")

    for s in data["sessions"]:
        sk = s["sessionKey"]
        user_source = [x["text"] for x in s.get("user_texts", [])]
        if is_subagent_key(sk):
            # Sub-agent assistant_texts are bootstrap/context noise; only use the original spawner user request.
            source_texts = user_source
        else:
            source_texts = user_source + [x["text"] for x in s.get("assistant_texts", [])]
        combined = " ".join(source_texts)
        low = combined.lower()

        # Good skill: one project learned a Feishu card interaction pattern that can power
        # reports, approvals, long-running task progress, dashboard alerts, and delivery UX.
        if any(k in low for k in ["channel sdk", "feishu card", "card json", "卡片 2.0", "报告 dsl", "interactive card", "updatecard", "cardaction"]):
            add(
                "feishu-channel-card-workflow",
                "Feishu Channel SDK cards / report-card DSL",
                "A concrete reusable capability: use Channel SDK/Feishu card JSON to present long-running tasks, reports, approvals, and deliverables as structured interactive cards instead of plain text.",
                "skill_candidate",
                f"{sk}: {trim(combined, 340)}",
                trigger="Need to send/update a Feishu card for task progress, report delivery, approval, or customer-facing status.",
                reusable="Not Makaron-specific: applies to dashboard alerts, TikTok reports, payroll flows, A2A reports, doc reviews, and any project needing structured Feishu UX.",
                session_key=sk,
            )

        # Good skill: remote browser/CDP setup is a reusable operational capability.
        if any(k in low for k in ["playwright extension", "cdp", "chrome", "browser use", "专用 profile", "openclaw-cdp-profile"]):
            add(
                "remote-browser-cdp-workflow",
                "Remote browser automation via dedicated Chrome/CDP profile",
                "A reusable workflow for connecting V/OpenClaw to a logged-in browser without exposing the user's personal Chrome profile.",
                "skill_candidate",
                f"{sk}: {trim(combined, 340)}",
                trigger="Need to operate a logged-in web service from V, especially B站/X/Feishu admin/customer tools, while keeping personal Chrome isolated.",
                reusable="Cross-project browser automation capability for research, dashboards, admin setup, competitor search, and customer ops.",
                session_key=sk,
            )

        # Good skill: document/knowledge work pattern, if based on a repeatable interface.
        if ("飞书" in combined and any(k in low for k in ["comment", "评论", "事件订阅", "developer console", "文档评论"])):
            add(
                "feishu-doc-comment-event-sop",
                "Feishu doc comment @V event subscription SOP",
                "A repeatable setup/troubleshooting workflow for making @V respond to Feishu document comments via app event subscription.",
                "skill_candidate",
                f"{sk}: {trim(combined, 340)}",
                trigger="Need V to react to Feishu doc comments/replies or diagnose why doc-comment events are not arriving.",
                reusable="Applies to document review, requirements discussion, async feedback loops, and customer collaboration docs across projects.",
                session_key=sk,
            )

        # Meta-skill: how to run this review. Keep as candidate only when user explicitly discusses skill extraction.
        if any(k in combined for k in ["提炼成skill", "提炼成 skill", "沉淀成skill", "Skill的话", "技能总结"]):
            add(
                "daily-session-skill-extraction-rubric",
                "Daily session review skill-extraction rubric",
                "The review itself needs a reusable rubric: extract transferable capabilities, not bugs/status; ask for approval before creating skills.",
                "skill_candidate",
                f"{sk}: {trim(combined, 340)}",
                trigger="Daily/weekly review of session logs asks what should become a skill.",
                reusable="Improves every future review by separating skills from memory, project TODOs, incident follow-ups, and one-off facts.",
                session_key=sk,
            )

    scored = list(candidates.values())
    for c in scored:
        score_candidate(c)

    DIRECT_SOURCES = {"knight_reflections", "skill_candidates_md"}

    live_skills = load_live_skills()
    duplicate_skill_candidates: list[dict[str, Any]] = []
    historical_review_candidates: list[dict[str, Any]] = []
    recent_titles = load_recent_review_candidate_titles(dt.date.fromisoformat(data["date"]))
    deduped: list[dict[str, Any]] = []
    direct_ingest: list[dict[str, Any]] = []

    for c in scored:
        duplicate = skill_duplicate_match(c, live_skills)
        existing_proposal = candidate_has_existing_proposal(c)
        appeared_recently = str(c.get("title") or "") in recent_titles
        source = str(c.get("source") or "")

        if duplicate:
            c["promotion_status"] = "duplicate_existing_skill"
            c["duplicate_of"] = duplicate
            c["duplicate_guard"] = (
                f"Skipped because it overlaps an installed skill: {duplicate.get('name', 'unknown')} "
                f"({duplicate.get('reason', 'similar pattern')})."
            )
            duplicate_skill_candidates.append(c)
        elif source in DIRECT_SOURCES:
            # Knight reflection repeats and skill-candidates.md entries are direct
            # data sources that carry inherent repeat evidence. They bypass the
            # historical dedup gate so they remain visible in every daily review
            # until Tianyi explicitly promotes, rejects, or suppresses them.
            if existing_proposal:
                c["promotion_status"] = "already_proposed_or_recently_reviewed"
                c["historical_review_guard"] = (
                    f"Direct ingest — already has an approval artifact ({existing_proposal}). "
                    f"Still included for visibility."
                )
                historical_review_candidates.append(c)
            else:
                c["promotion_status"] = "direct_ingest_active"
                if appeared_recently:
                    c["recurrence_note"] = (
                        f"Continuing repeat signal (also appeared in a review within the last {RECENT_APPROVAL_DEDUPE_DAYS} days)."
                    )
            direct_ingest.append(c)
        elif existing_proposal or appeared_recently:
            c["promotion_status"] = "already_proposed_or_recently_reviewed"
            c["historical_review_guard"] = (
                f"Skipped because this candidate already has an approval artifact ({existing_proposal})"
                if existing_proposal
                else f"Skipped because this candidate appeared in a daily review within the last {RECENT_APPROVAL_DEDUPE_DAYS} days."
            )
            historical_review_candidates.append(c)
        else:
            deduped.append(c)

    data["duplicate_skill_candidates"] = duplicate_skill_candidates
    data["historical_review_candidates"] = historical_review_candidates
    data["direct_ingest_candidates"] = direct_ingest

    promotable: list[dict[str, Any]] = []
    held_one_off: list[dict[str, Any]] = []

    # Direct ingest candidates always enter promotable — their repeat count
    # already exceeds the promotion threshold by definition. The one-off guard
    # applies only to session-extracted candidates.
    for c in direct_ingest:
        if c.get("promotion_status") == "direct_ingest_active":
            c["promotion_status"] = "ready_for_approval"
            promotable.append(c)

    for c in deduped:
        if (
            c.get("recommendation") == "skill_candidate"
            and repeat_count_for(c) < MIN_SKILL_PROMOTION_REPEAT_COUNT
            and not explicit_skill_promotion_requested(c)
        ):
            scores = c.get("scores") or {}
            if isinstance(scores, dict) and "combined" in scores:
                scores["combined"] = min(float(scores["combined"]), ONE_OFF_SCORE_CAP)
            c["promotion_status"] = "held_for_repeat_evidence"
            c["one_off_guard"] = (
                "Held out of nightly approval because it appeared in only one session "
                "and Tianyi did not explicitly ask to create/promote a skill."
            )
            c["score_breakdown"] = f"{c.get('score_breakdown', '—')} · one-off guard cap ≤ {ONE_OFF_SCORE_CAP}"
            held_one_off.append(c)
        else:
            c["promotion_status"] = "ready_for_approval"
            promotable.append(c)

    data["held_one_off_candidates"] = held_one_off
    promotable.sort(
        key=lambda c: (
            -float(c.get("scores", {}).get("combined", 0)),
            -int(c.get("repeat_count", 0)),
            str(c.get("title", "")),
        )
    )
    return promotable


def infer_reflection(data: dict[str, Any], candidates: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Build a short, evidence-based daily self-reflection for Tianyi.

    This is intentionally heuristic: the nightly cron needs a stable, compact
    reflection even when no human manually writes one. Avoid pretending to know
    intent; only infer from transcript categories, tool failures, and candidate
    signals collected above.
    """
    sessions = data.get("sessions", [])
    total_user = sum(s.get("counts", {}).get("user", 0) for s in sessions)
    total_failures = sum(len(s.get("failures", [])) for s in sessions)
    category_counts = Counter()
    for s in sessions:
        category_counts.update(s.get("categories", {}))

    direct_ingest = data.get("direct_ingest_candidates") or []
    direct_active = [c for c in direct_ingest if c.get("promotion_status") == "direct_ingest_active"]
    scoring_inputs = data.get("candidate_scoring_inputs") or {}

    positives: list[str] = []
    risks: list[str] = []
    tomorrow: list[str] = []
    decisions: list[str] = []

    if category_counts.get("deliverable", 0):
        positives.append(f"有交付/完成信号 {category_counts['deliverable']} 条，说明今天不是只讨论，确实推进了可交付结果。")
    if category_counts.get("decision", 0):
        positives.append(f"捕捉到决策/规则信号 {category_counts['decision']} 条，适合沉淀成后续执行约束。")
    if direct_active:
        positives.append(f"持续监控到 {len(direct_active)} 个 Knight 重复反射模式，说明有跨日期的高频学习信号。")
    if candidates:
        positives.append(f"识别到 {len(candidates)} 个可升级候选，说明有把重复流程沉淀下来的机会。")
    if not positives:
        positives.append("今天没有明显强信号候选；保持低噪音比硬提炼更重要。")

    if total_failures:
        risks.append(f"发现 {total_failures} 条失败/异常片段；报告完成前必须把失败来源和影响范围说清楚。")
    if category_counts.get("incident", 0):
        risks.append(f"出现 {category_counts['incident']} 条事故/风险信号；不能只写结果，要写验证缺口。")
    if total_user and len(sessions) > 1:
        risks.append("当天信息分散在多个 session；只看当前会话会漏决策，需要跨 session 扫描。")
    if not risks:
        risks.append("未扫描到明显事故片段；仍需在报告里保留“数据来源/可能遗漏”口径。")

    tomorrow.append("午夜报告先列事实和证据，再下判断；不把脚本跑过等同于真实完成。")
    if len(sessions) > 1:
        tomorrow.append("复盘默认跨 session 看当天高信号会话、项目 TODO、决策句和工具错误。")
    if candidates:
        tomorrow.append("候选项先给 Tianyi 批准：skill / memory / todo / skip，不自动写入长期规则。")
    if total_failures:
        tomorrow.append("遇到失败先重试或换源验证；仍失败就明确标 [blocked]，不要静默吞掉。")

    if candidates:
        for i, c in enumerate(candidates[:3], 1):
            decisions.append(f"候选 {i}《{c.get('title', '未命名')}》：是否升级为 {c.get('recommendation', 'todo')}？")
    else:
        decisions.append("暂无强候选需要拍板。")

    return {
        "what_went_well": positives[:3],
        "risks_or_misses": risks[:3],
        "tomorrow_rules": tomorrow[:4],
        "needs_tianyi": decisions[:3],
    }


def session_title(s: dict[str, Any]) -> str:
    key = s["sessionKey"]
    if ":direct:" in key:
        return f"Feishu DM / {s.get('initiator') or direct_sender_label(key, s.get('user_texts') or [])}"
    if ":group:" in key:
        m = re.search(r":group:([^:]+)$", key)
        return f"Group {m.group(1) if m else key[-16:]}"
    if ":cron:" in key:
        return "Cron / heartbeat"
    return key[:80]


def render_report(data: dict[str, Any], candidates: list[dict[str, Any]], reflection: dict[str, list[str]] | None = None) -> str:
    sessions = data["sessions"]
    total_user = sum(s.get("counts", {}).get("user", 0) for s in sessions)
    total_assistant = sum(s.get("counts", {}).get("assistant", 0) for s in sessions)
    total_failures = sum(len(s.get("failures", [])) for s in sessions)
    tools = Counter()
    cats = Counter()
    for s in sessions:
        tools.update(s.get("tools", {}))
        cats.update(s.get("categories", {}))

    lines = [
        f"# Daily Session Review — {data['date']}",
        "",
        "## Summary",
        "",
        f"- Sessions touched: **{len(sessions)}**",
        f"- User messages: **{total_user}**",
        f"- Assistant messages: **{total_assistant}**",
        f"- Tool/error snippets: **{total_failures}**",
        f"- Top tools: {', '.join(f'{k}×{v}' for k,v in tools.most_common(8)) or '—'}",
        "",
        "## High-signal sessions",
        "",
    ]

    scoring_inputs = data.get("candidate_scoring_inputs") or {}
    if scoring_inputs:
        lines[9:9] = [
            f"- Knight reflection repeat signals: **{scoring_inputs.get('reflection_repeat_signals', 0)}**",
            f"- Explicit skill-candidates.md entries: **{scoring_inputs.get('skill_candidates_md_entries', 0)}**",
        ]
        warnings = scoring_inputs.get("warnings") or []
        if warnings:
            lines[11:11] = [f"- Scoring input warnings: {'; '.join(str(w) for w in warnings[:3])}"]

    if reflection:
        lines += [
            "## V Daily Reflection",
            "",
            "### What went well",
        ]
        lines += [f"- {x}" for x in reflection.get("what_went_well", [])]
        lines += ["", "### Risks / misses",]
        lines += [f"- {x}" for x in reflection.get("risks_or_misses", [])]
        lines += ["", "### Tomorrow rules",]
        lines += [f"- {x}" for x in reflection.get("tomorrow_rules", [])]
        lines += ["", "### Needs Tianyi",]
        lines += [f"- {x}" for x in reflection.get("needs_tianyi", [])]
        lines.append("")

    ranked = sorted(sessions, key=lambda s: (len(s.get("failures", []))*3 + sum(s.get("categories", {}).values()) + s.get("counts", {}).get("user", 0)), reverse=True)
    for s in ranked[:12]:
        lines += [
            f"### {session_title(s)}",
            f"- Session key: `{s['sessionKey']}`",
            f"- Time: {s['first']} → {s['last']}",
            f"- Counts: {s.get('counts', {})}",
        ]
        if s.get("user_texts"):
            lines.append("- User asks:")
            for x in s["user_texts"][-4:]:
                lines.append(f"  - {x['time']}: {x['text']}")
        if s.get("assistant_texts"):
            lines.append("- Assistant outputs:")
            for x in s["assistant_texts"][-3:]:
                lines.append(f"  - {x['time']}: {x['text']}")
        if s.get("failures"):
            lines.append("- Incidents / tool errors:")
            for x in s["failures"][-3:]:
                lines.append(f"  - {x['time']}: {x['text']}")
        lines.append("")

    lines += [
        "## Skill / Memory / TODO candidates",
        "",
    ]
    if not candidates:
        lines.append("No strong candidates found by deterministic scan. Manual review recommended.")
    else:
        for i, c in enumerate(candidates, 1):
            lines += [
                f"### {i}. {c['title']}",
                f"- Why skill-worthy: {c['why']}",
                f"- Future trigger: {c.get('trigger', '—')}",
                f"- Reusable abstraction: {c.get('reusable', '—')}",
                f"- Recommendation: **{c['recommendation']}**",
                f"- Source: `{c.get('source', 'session_scan')}`",
                f"- Score: **{c.get('scores', {}).get('combined', '—')}** — {c.get('score_breakdown', '—')}",
                "- Evidence:",
            ]
            for e in c.get("evidence", []):
                lines.append(f"  - {e}")
            lines.append("")

    held_one_off = data.get("held_one_off_candidates") or []
    if held_one_off:
        lines += [
            "## Held one-off signals",
            "",
            "These matched a skill heuristic but were **not** sent to approval because they appeared in only one session and lacked an explicit skill-promotion request.",
            "",
        ]
        for i, c in enumerate(held_one_off[:5], 1):
            lines += [
                f"### {i}. {c['title']}",
                f"- Guard: {c.get('one_off_guard', 'held for repeat evidence')}",
                f"- Score after cap: **{c.get('scores', {}).get('combined', '—')}** — {c.get('score_breakdown', '—')}",
            ]
            if c.get("evidence"):
                lines.append(f"- Evidence: {c['evidence'][0]}")
            lines.append("")

    duplicate_skill_candidates = data.get("duplicate_skill_candidates") or []
    if duplicate_skill_candidates:
        lines += [
            "## Skipped duplicates of installed skills",
            "",
            "These matched a skill heuristic but were **not** sent to approval because an installed skill already covers the pattern.",
            "",
        ]
        for i, c in enumerate(duplicate_skill_candidates[:8], 1):
            dup = c.get("duplicate_of") or {}
            lines += [
                f"### {i}. {c['title']}",
                f"- Duplicate of: `{dup.get('name', 'unknown')}`",
                f"- Match: {dup.get('reason', 'similar pattern')} (strength {dup.get('strength', '—')})",
            ]
            if dup.get("path"):
                lines.append(f"- Skill path: `{dup['path']}`")
            if c.get("evidence"):
                lines.append(f"- Evidence: {c['evidence'][0]}")
            lines.append("")

    historical_review_candidates = data.get("historical_review_candidates") or []
    if historical_review_candidates:
        lines += [
            "## Skipped already-proposed / recently-reviewed candidates",
            "",
            "These are real recurring signals, but they were **not** sent to today's approval card because they already appeared recently or already have a proposal artifact.",
            "",
        ]
        for i, c in enumerate(historical_review_candidates[:8], 1):
            lines += [
                f"### {i}. {c['title']}",
                f"- Guard: {c.get('historical_review_guard', 'already reviewed')}",
            ]
            if c.get("evidence"):
                lines.append(f"- Evidence: {c['evidence'][0]}")
            lines.append("")

    direct_ingest_candidates = data.get("direct_ingest_candidates") or []
    if direct_ingest_candidates:
        lines += [
            "## Direct ingest: Knight reflections / skill-candidates.md",
            "",
            "These come directly from repeated Knight reflection patterns or explicit entries in `memory/skill-candidates.md`. They bypass the single-session gate and remain visible nightly until promoted, rejected, or suppressed.",
            "",
        ]
        for i, c in enumerate(direct_ingest_candidates, 1):
            status_note = ""
            if c.get("promotion_status") == "already_proposed_or_recently_reviewed":
                status_note = f" — {c.get('historical_review_guard', 'already proposed')}"
            elif c.get("promotion_status") == "ready_for_approval":
                status_note = " — ready_for_approval"
            lines += [
                f"### {i}. {c['title']}",
                f"- Source: `{c.get('source', 'direct')}`",
                f"- Repeat count: **{c.get('repeat_count', c.get('reflection_repeat_count', '—'))}**",
                f"- Status: {c.get('promotion_status', '—')}{status_note}",
                f"- Why skill-worthy: {c['why']}",
                f"- Future trigger: {c.get('trigger', '—')}",
                f"- Reusable abstraction: {c.get('reusable', '—')}",
                f"- Score: **{c.get('scores', {}).get('combined', '—')}** — {c.get('score_breakdown', '—')}",
            ]
            if c.get("recurrence_note"):
                lines.append(f"- ⚠️ {c['recurrence_note']}")
            if c.get("evidence"):
                lines.append("- Evidence:")
                for e in c["evidence"][:3]:
                    lines.append(f"  - {e}")
            lines.append("")

    lines += [
        "## Proposed next actions",
        "",
        "- Reply `1 skill` / `1 memory` / `1 todo` / `skip 1`; `skill` writes a Skill proposal only.",
        "- Actual installed skill creation / skill-creator use requires a separate explicit Tianyi confirmation after proposal review.",
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="YYYY-MM-DD, default: yesterday Asia/Shanghai")
    ap.add_argument("--send", action="store_true", help="send short Feishu DM summary")
    ap.add_argument("--notify-user", default="ou_cb133fd4414f0607e8b46a3195c7b9d8")
    args = ap.parse_args()

    if args.date:
        day = dt.date.fromisoformat(args.date)
    else:
        day = (now_local() - dt.timedelta(days=1)).date()

    data = collect_for_date(day)
    candidates = infer_candidates(data)
    reflection = infer_reflection(data, candidates)
    report = render_report(data, candidates, reflection)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUT_DIR / f"{day.isoformat()}.md"
    json_path = OUT_DIR / f"{day.isoformat()}.json"
    report_path.write_text(report, encoding="utf-8", errors="replace")
    json_path.write_text(json.dumps({"data": data, "candidates": candidates, "reflection": reflection}, ensure_ascii=False, indent=2), encoding="utf-8", errors="replace")

    print(json.dumps({
        "ok": True,
        "date": day.isoformat(),
        "sessions": len(data["sessions"]),
        "candidates": len(candidates),
        "held_one_off_candidates": len(data.get("held_one_off_candidates") or []),
        "duplicate_skill_candidates": len(data.get("duplicate_skill_candidates") or []),
        "direct_ingest_candidates": len(data.get("direct_ingest_candidates") or []),
        "historical_review_candidates": len(data.get("historical_review_candidates") or []),
        "reflection_repeat_signals": (data.get("candidate_scoring_inputs") or {}).get("reflection_repeat_signals", 0),
        "skill_candidates_md_entries": (data.get("candidate_scoring_inputs") or {}).get("skill_candidates_md_entries", 0),
        "reflection": reflection,
        "report": str(report_path),
        "json": str(json_path),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
