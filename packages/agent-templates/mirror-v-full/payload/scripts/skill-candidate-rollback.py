#!/usr/bin/env python3
"""Rollback a promoted skill candidate.

Reverses a promotion decision made via the Daily Session Review pipeline.
Given a candidate name, this script:
  1. Finds the candidate in `memory/skill-candidates.md`
  2. Reverts its status: promoted → draft (or --to shadow)
  3. Finds matching approval decisions in `memory/daily-session-review/approvals/*.json`
  4. Adds a rollback event to the most recent matching approval file
  5. Notes (but does not delete) any generated proposal artifacts

Usage:
  # Dry-run preview
  python3 scripts/skill-candidate-rollback.py --name "my-candidate" --dry-run

  # Execute rollback
  python3 scripts/skill-candidate-rollback.py --name "my-candidate"

  # Rollback to shadow instead of draft
  python3 scripts/skill-candidate-rollback.py --name "my-candidate" --to shadow

  # Rollback a candidate promoted on a specific date
  python3 scripts/skill-candidate-rollback.py --name "my-candidate" --date 2026-06-24 --dry-run

  # Show what candidates are eligible for rollback
  python3 scripts/skill-candidate-rollback.py --list
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

WORKSPACE = Path(__file__).resolve().parents[1]
SKILL_CANDIDATES_PATH = WORKSPACE / "memory" / "skill-candidates.md"
APPROVALS_DIR = WORKSPACE / "memory" / "daily-session-review" / "approvals"
SKILL_PROPOSALS_DIR = WORKSPACE / "memory" / "skill-proposals"
MEMORY_PROPOSALS_DIR = WORKSPACE / "memory" / "proposals"

VALID_STATUSES = {"draft", "shadow", "promoted", "rejected"}
ROLLBACKABLE_STATUSES = {"promoted", "rejected"}  # Can rollback from these


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def trim(text: str, n: int = 80) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def slug(text: str) -> str:
    text = (text or "candidate").lower()
    text = re.sub(r"[^a-z0-9\u4e00-\u9fa5]+", "-", text).strip("-")
    return text[:80] or "candidate"


# ── Parse skill-candidates.md (reuse logic from skill-dashboard.py) ────────

def _parse_yaml_block(text: str) -> dict | None:
    candidate: dict = {
        "name": "",
        "status": "draft",
        "trigger": "",
        "created_at": "",
        "last_updated": "",
        "steps": "",
        "tools_used": "",
        "failure_modes": "",
        "safety_boundaries": "",
        "validation": "",
        "examples": "",
        "source_reflections": "",
        "requires_user_approval": True,
    }
    scalar_keys = {
        "name", "status", "trigger", "created_at", "last_updated",
        "steps", "tools_used", "failure_modes",
        "safety_boundaries", "validation", "examples",
        "source_reflections",
    }
    current_list_key: Optional[str] = None

    for line in text.splitlines():
        line_s = line.rstrip()
        m = re.match(r"^(\w[\w_]*)\s*:\s*(.*)$", line_s)
        if m:
            key = m.group(1)
            value = m.group(2).strip()
            if not value and key in {"steps", "tools_used", "failure_modes",
                                      "safety_boundaries", "validation",
                                      "examples", "source_reflections"}:
                current_list_key = key
                continue
            if key in scalar_keys:
                candidate[key] = value
                current_list_key = None
            elif key == "requires_user_approval":
                candidate["requires_user_approval"] = value.lower() == "true"
                current_list_key = None
            else:
                current_list_key = None
            continue

        lm = re.match(r"^\s+-\s+(.*)$", line_s)
        if lm and current_list_key:
            item = lm.group(1).strip()
            existing = candidate.get(current_list_key, "")
            if existing:
                candidate[current_list_key] = existing + "; " + item
            else:
                candidate[current_list_key] = item
            continue

    if not candidate.get("name"):
        return None
    return candidate


def parse_skill_candidates() -> list[dict]:
    if not SKILL_CANDIDATES_PATH.exists():
        return []
    text = SKILL_CANDIDATES_PATH.read_text(encoding="utf-8")
    candidates = []
    blocks = re.split(r"^###\s+", text, flags=re.MULTILINE)
    for block in blocks:
        yaml_match = re.search(r"```yaml\s*\n(.*?)```", block, re.DOTALL)
        if not yaml_match:
            continue
        yaml_text = yaml_match.group(1)
        candidate = _parse_yaml_block(yaml_text)
        if candidate:
            heading = block.split("\n")[0].strip()
            if heading and not candidate.get("name"):
                candidate["name"] = heading
            candidates.append(candidate)
    return candidates


def find_candidate(name: str) -> Optional[dict]:
    """Find a candidate by name (case-insensitive substring match)."""
    candidates = parse_skill_candidates()
    matches = []
    q = name.lower().strip()
    for c in candidates:
        c_name = str(c.get("name", "")).lower().strip()
        if q in c_name or c_name in q:
            matches.append(c)

    if len(matches) == 1:
        return matches[0]
    elif len(matches) > 1:
        print(f"Multiple candidates match '{name}':", file=sys.stderr)
        for m in matches:
            m_name = m.get("name", "?")
            m_status = m.get("status", "draft")
            print(f"  - {m_name} ({m_status})", file=sys.stderr)
        return None
    return None


# ── Approval file operations ──────────────────────────────────────────────

def find_approval_decisions(candidate_name: str, date_filter: Optional[str] = None) -> list[dict]:
    """Find all approval decisions related to this candidate.

    Returns list of dicts with: date, key, status, kind, artifact, at, filepath.
    """
    if not APPROVALS_DIR.exists():
        return []

    decisions = []
    cand_name_lower = candidate_name.lower().strip()

    for f in sorted(APPROVALS_DIR.glob("*.json")):
        if f.name.startswith("."):
            continue
        if date_filter and f.stem != date_filter:
            continue

        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue

        date = data.get("date", f.stem)
        candidates = data.get("candidates", {})

        for key, meta in candidates.items():
            title = str(meta.get("title", "")).lower()
            rec = str(meta.get("recommendation", "")).lower()
            status = meta.get("status", "pending")

            # Match by title containing candidate name or vice versa
            if cand_name_lower in title or title in cand_name_lower or cand_name_lower in rec:
                if status != "pending":
                    decisions.append({
                        "date": date,
                        "key": key,
                        "title": meta.get("title", "?"),
                        "status": status,
                        "artifact": meta.get("artifact", ""),
                        "decidedAt": meta.get("decidedAt", ""),
                        "filepath": str(f),
                    })

    decisions.sort(key=lambda d: d.get("decidedAt", d.get("date", "")), reverse=True)
    return decisions


def add_rollback_event(approval_path: str, key: str, old_status: str,
                       new_status: str, artifact: str, note: str) -> bool:
    """Append a rollback event to an approval file's events array.

    Also updates the candidate status back to 'pending' in the candidates dict.
    """
    try:
        data = json.loads(Path(approval_path).read_text(encoding="utf-8"))
    except Exception:
        return False

    # Update the candidate status back to pending
    candidates = data.get("candidates", {})
    if key in candidates:
        candidates[key]["status"] = "pending"
        candidates[key]["decidedAt"] = None
        candidates[key]["artifact"] = None
        # Add a rollback field to track the reversal
        candidates[key]["_rollback_from"] = old_status
        candidates[key]["_rollback_to"] = new_status
        candidates[key]["_rollback_at"] = now_iso()

    # Append rollback event
    rollback_event = {
        "at": now_iso(),
        "type": "rollback",
        "key": key,
        "old_kind": old_status,
        "new_status": new_status,
        "artifact_reverted": artifact if artifact else None,
        "note": note,
    }
    data.setdefault("events", []).append(rollback_event)

    Path(approval_path).write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return True


# ── Main rollback logic ────────────────────────────────────────────────────

def update_candidate_status_in_file(candidate_name: str, new_status: str) -> bool:
    """Update the status line for a candidate in skill-candidates.md."""
    if not SKILL_CANDIDATES_PATH.exists():
        print(f"Error: {SKILL_CANDIDATES_PATH} not found", file=sys.stderr)
        return False

    text = SKILL_CANDIDATES_PATH.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    original_text = text

    changed = False
    new_lines = []
    in_yaml = False
    found_name = False
    status_updated = False

    for line in lines:
        # Detect entry into this candidate's YAML block
        if re.search(rf"^name:\s*{re.escape(candidate_name)}\s*$", line.rstrip()):
            in_yaml = True
            found_name = True

        if in_yaml and found_name and not status_updated:
            m = re.match(r"^status:\s*(draft|shadow|promoted|rejected)\s*$", line.rstrip())
            if m:
                new_lines.append(f"status: {new_status}\n")
                status_updated = True
                changed = True
                continue

        # Detect end of YAML block
        if in_yaml and re.match(r"^```\s*$", line.rstrip()):
            if found_name and not status_updated:
                new_lines.append(f"status: {new_status}\n")
                status_updated = True
                changed = True
                new_lines.append(line)
                in_yaml = False
                continue
            else:
                in_yaml = False

        new_lines.append(line)

    if not changed:
        print(f"Warning: Could not locate status line for '{candidate_name}'", file=sys.stderr)
        return False

    new_text = "".join(new_lines)
    if new_text == original_text:
        print(f"Warning: No changes made for '{candidate_name}'", file=sys.stderr)
        return False

    SKILL_CANDIDATES_PATH.write_text(new_text, encoding="utf-8")
    return True


def list_rollbackable_candidates():
    """Print candidates that are eligible for rollback (promoted/rejected)."""
    candidates = parse_skill_candidates()
    eligible = [c for c in candidates if c.get("status", "draft") in ROLLBACKABLE_STATUSES]

    if not eligible:
        print("No rollback-eligible candidates found in skill-candidates.md")
        print("(only 'promoted' or 'rejected' candidates can be rolled back)")
        return

    print(f"\n{'#':>3}  {'Status':^14}  {'Name':<50}")
    print(f"{'-'*3}  {'-'*14}  {'-'*50}")
    for i, c in enumerate(eligible, 1):
        status = c.get("status", "?")
        name = c.get("name", "?")
        badge = "✅" if status == "promoted" else "❌"
        print(f"{i:3d}  {badge} {status:<11}  {name}")

    print(f"\n{len(eligible)} candidate(s) eligible for rollback.")
    print(f"Usage: python3 scripts/skill-candidate-rollback.py --name '<name>' [--dry-run]")


def execute_rollback(name: str, target_status: str, date_filter: Optional[str],
                     dry_run: bool, reason: str) -> bool:
    """Execute or preview a rollback.

    Returns True if rollback was successful (or would be in dry-run).
    """
    # Step 1: Find candidate
    candidate = find_candidate(name)
    if not candidate:
        print(f"Error: Candidate '{name}' not found in {SKILL_CANDIDATES_PATH}", file=sys.stderr)
        return False

    cand_name = candidate.get("name", name)
    old_status = candidate.get("status", "draft")

    if old_status not in ROLLBACKABLE_STATUSES:
        print(f"Error: Candidate '{cand_name}' has status '{old_status}' — "
              f"only {ROLLBACKABLE_STATUSES} can be rolled back.", file=sys.stderr)
        return False

    print(f"\n{'[DRY RUN] ' if dry_run else ''}Rollback: '{cand_name}'")
    print(f"  Current status: {old_status}")
    print(f"  Target status:  {target_status}")
    if reason:
        print(f"  Reason: {trim(reason)}")
    print()

    # Step 2: Find approval decisions
    decisions = find_approval_decisions(cand_name, date_filter)
    if decisions:
        print(f"  Found {len(decisions)} approval decision(s):")
        for d in decisions:
            print(f"    - [{d['date']}] {d['status']} → {trim(d.get('artifact', 'no artifact'), 80)}")
    else:
        print(f"  No matching approval decisions found in {APPROVALS_DIR}")
        print()

    # Step 3: Show what will change
    print(f"\n  --- Changes ---")
    print(f"  1. skill-candidates.md: '{cand_name}' status: {old_status} → {target_status}")
    if decisions:
        latest = decisions[0]
        print(f"  2. {latest['filepath']}: add rollback event + reset candidate to 'pending'")
        if latest.get("artifact"):
            print(f"     Artifact (not deleted): {latest['artifact']}")
    else:
        print(f"  2. No approval file to update (candidate not found in any approval file)")

    if dry_run:
        print(f"\n  ⚠️  DRY RUN — no changes made.")
        print(f"  Run without --dry-run to apply.")
        return True

    # Step 4: Apply changes
    errors = []

    # Update skill-candidates.md
    if not update_candidate_status_in_file(cand_name, target_status):
        errors.append("Failed to update skill-candidates.md")

    # Update approval files
    for d in decisions:
        success = add_rollback_event(
            d["filepath"],
            d["key"],
            old_status=d["status"],
            new_status=target_status,
            artifact=d.get("artifact", ""),
            note=f"Rollback from {d['status']} to {target_status}. Reason: {reason or 'manual rollback'}",
        )
        if not success:
            errors.append(f"Failed to add rollback event to {d['filepath']}")

    if errors:
        print(f"\n  ❌ Rollback had {len(errors)} error(s):")
        for e in errors:
            print(f"  - {e}")
        return False

    print(f"\n  ✅ Rollback successful.")
    print(f"  - '{cand_name}' status: {old_status} → {target_status} in skill-candidates.md")
    if decisions:
        print(f"  - Added rollback events to {len(decisions)} approval file(s)")
        if decisions[0].get("artifact"):
            print(f"  - Note: Artifact file NOT deleted: {decisions[0]['artifact']}")
            print(f"    (delete manually if no longer needed)")

    return True


def main():
    parser = argparse.ArgumentParser(
        description="Rollback a promoted/rejected skill candidate",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  %(prog)s --name "my-candidate" --dry-run     # Preview rollback
  %(prog)s --name "my-candidate"               # Execute rollback to draft
  %(prog)s --name "my-candidate" --to shadow   # Rollback to shadow
  %(prog)s --name "my-candidate" --date 2026-06-24 --dry-run
  %(prog)s --list                              # Show rollbackable candidates
        """,
    )
    parser.add_argument("--name", type=str, default=None,
                        help="Candidate name (case-insensitive partial match)")
    parser.add_argument("--to", type=str, default="draft",
                        choices=list(VALID_STATUSES),
                        help="Target status (default: draft)")
    parser.add_argument("--date", type=str, default=None,
                        help="Approval date to roll back (YYYY-MM-DD). "
                             "If omitted, the most recent matching decision is used.")
    parser.add_argument("--reason", type=str, default="",
                        help="Reason for rollback (logged in audit event)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview changes without applying them")
    parser.add_argument("--list", action="store_true",
                        help="List all candidates eligible for rollback")

    args = parser.parse_args()

    if args.list:
        list_rollbackable_candidates()
        sys.exit(0)

    if not args.name:
        parser.error("--name is required (or use --list)")

    success = execute_rollback(
        name=args.name,
        target_status=args.to,
        date_filter=args.date,
        dry_run=args.dry_run,
        reason=args.reason,
    )
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
