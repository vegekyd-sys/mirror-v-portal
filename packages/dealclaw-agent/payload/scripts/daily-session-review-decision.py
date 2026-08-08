#!/usr/bin/env python3
"""Text fallback for Daily Session Review approval decisions.

Examples:
  python3 scripts/daily-session-review-decision.py --date 2026-06-08 --decision "1 skill"
  python3 scripts/daily-session-review-decision.py --date 2026-06-08 --decision "all skip"

This mirrors the Feishu card button behavior but is reliable when card callbacks
or listeners fail. It writes only proposals / TODO state, never formal skills,
and never invokes skill-creator. Actual installed skill creation requires a
separate explicit confirmation from Tianyi.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parents[1]
REVIEW_DIR = WORKSPACE / "memory" / "daily-session-review"
APPROVAL_DIR = REVIEW_DIR / "approvals"
SKILL_PROPOSAL_DIR = WORKSPACE / "memory" / "skill-proposals"
MEMORY_PROPOSAL_DIR = WORKSPACE / "memory" / "proposals"
TODO_PATH = WORKSPACE / "memory" / "projects" / "daily-session-review" / "TODO.md"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slug(text: str) -> str:
    text = (text or "candidate").lower()
    text = re.sub(r"[^a-z0-9\u4e00-\u9fa5]+", "-", text).strip("-")
    return text[:80] or "candidate"


def trim(text: str, n: int = 220) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def sanitize(text: str) -> str:
    text = str(text or "")
    text = re.sub(r"/root/(?:\.openclaw|makaron-openclaw|data)/[^\s\])]+", "[local-path]", text)
    text = re.sub(r"/tmp/[^\s\])]+", "[local-path]", text)
    text = re.sub(r"(token=)[A-Za-z0-9._-]+", r"\1[REDACTED]", text)
    text = re.sub(r"Bearer\s+[A-Za-z0-9._-]+", "Bearer [REDACTED]", text)
    return text


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def candidate_key(candidate: dict, idx: int) -> str:
    return slug(f"{idx + 1}-{candidate.get('title') or 'candidate'}")


def load_review(date: str) -> dict:
    path = REVIEW_DIR / f"{date}.json"
    data = load_json(path, None)
    if not data:
        raise SystemExit(f"review json not found: {path}")
    return data


def state_path(date: str) -> Path:
    return APPROVAL_DIR / f"{date}.json"


def init_state(date: str, review: dict) -> dict:
    existing = load_json(state_path(date), {})
    old = existing.get("candidates") or {}
    candidates = {}
    for idx, c in enumerate(review.get("candidates") or []):
        key = candidate_key(c, idx)
        candidates[key] = {
            "key": key,
            "idx": idx,
            "title": c.get("title"),
            "recommendation": c.get("recommendation"),
            "status": old.get(key, {}).get("status", "pending"),
            "decidedAt": old.get(key, {}).get("decidedAt"),
            "artifact": old.get(key, {}).get("artifact"),
        }
    existing.update({
        "date": date,
        "generatedAt": existing.get("generatedAt") or now_iso(),
        "candidates": candidates,
        "events": existing.get("events") or [],
    })
    return existing


def proposal_body(date: str, c: dict, kind: str) -> str:
    evidence = "\n".join(f"- {sanitize(e)}" for e in (c.get("evidence") or [])) or "- —"
    return f"""# {sanitize(c.get('title'))}

- Source: Daily Session Review {date}
- Type: {kind}
- Recommendation: {sanitize(c.get('recommendation') or '—')}
- Created by: Daily review text fallback
- Created at: {now_iso()}

## Why

{sanitize(c.get('why') or '—')}

## Future trigger

{sanitize(c.get('trigger') or '—')}

## Reusable abstraction

{sanitize(c.get('reusable') or '—')}

## Evidence

{evidence}
"""


def apply_decision(date: str, review: dict, state: dict, key: str, kind: str) -> str | None:
    meta = state["candidates"].get(key)
    if not meta:
        raise SystemExit(f"candidate key not found: {key}")
    c = (review.get("candidates") or [])[meta["idx"]]
    artifact = None
    s = slug(f"{date}-{c.get('title')}")
    if kind == "skill":
        SKILL_PROPOSAL_DIR.mkdir(parents=True, exist_ok=True)
        artifact = SKILL_PROPOSAL_DIR / f"{s}.md"
        if not artifact.exists():
            artifact.write_text(proposal_body(date, c, "skill-proposal"), encoding="utf-8")
    elif kind == "memory":
        MEMORY_PROPOSAL_DIR.mkdir(parents=True, exist_ok=True)
        artifact = MEMORY_PROPOSAL_DIR / f"{date}-memory-{slug(c.get('title'))}.md"
        if not artifact.exists():
            artifact.write_text(proposal_body(date, c, "memory-proposal"), encoding="utf-8")
    elif kind == "todo":
        TODO_PATH.parent.mkdir(parents=True, exist_ok=True)
        marker = f"[[daily-review-{date}-{key}]]"
        text = TODO_PATH.read_text(encoding="utf-8") if TODO_PATH.exists() else "# TODO — Daily Session Review / Skill Extraction\n"
        if marker not in text:
            text += f"\n- [ ] {c.get('title')} — {trim(c.get('recommendation') or 'review candidate', 140)} {marker}\n"
            TODO_PATH.write_text(text, encoding="utf-8")
        artifact = TODO_PATH
    elif kind == "skip":
        artifact = None
    else:
        raise SystemExit(f"unknown kind: {kind}")

    meta["status"] = kind
    meta["decidedAt"] = now_iso()
    meta["artifact"] = str(artifact) if artifact else None
    state.setdefault("events", []).append({
        "at": now_iso(),
        "key": key,
        "kind": kind,
        "artifact": str(artifact) if artifact else None,
        "note": "text fallback decision",
    })
    return str(artifact) if artifact else None


def parse_decision(decision: str) -> tuple[str, str]:
    parts = decision.strip().lower().split()
    if len(parts) != 2:
        raise SystemExit('decision must look like "1 skill" or "all skip"')
    target, kind = parts
    if kind not in {"skill", "memory", "todo", "skip"}:
        raise SystemExit("kind must be one of: skill, memory, todo, skip")
    return target, kind


def main():
    parser = argparse.ArgumentParser(description="Apply Daily Session Review decision from text fallback")
    parser.add_argument("--date", required=True)
    parser.add_argument("--decision", required=True, help='e.g. "1 skill" or "all skip"')
    args = parser.parse_args()

    target, kind = parse_decision(args.decision)
    review = load_review(args.date)
    state = init_state(args.date, review)
    candidates = review.get("candidates") or []

    changed = []
    if target == "all":
        for idx, c in enumerate(candidates):
            key = candidate_key(c, idx)
            artifact = apply_decision(args.date, review, state, key, kind)
            changed.append({"idx": idx + 1, "key": key, "kind": kind, "artifact": artifact})
    else:
        try:
            idx = int(target) - 1
        except ValueError:
            raise SystemExit("target must be a 1-based number or all")
        if idx < 0 or idx >= len(candidates):
            raise SystemExit(f"candidate index out of range: {idx + 1}")
        key = candidate_key(candidates[idx], idx)
        artifact = apply_decision(args.date, review, state, key, kind)
        changed.append({"idx": idx + 1, "key": key, "kind": kind, "artifact": artifact})

    write_json(state_path(args.date), state)
    print(json.dumps({"ok": True, "date": args.date, "changed": changed, "state": str(state_path(args.date))}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
