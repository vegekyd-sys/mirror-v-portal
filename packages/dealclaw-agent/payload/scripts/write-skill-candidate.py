#!/usr/bin/env python3
"""
write-skill-candidate.py — Append a reusable workflow candidate.

This is the skill-facing companion to Knight reflections:
- write-reflection.py captures task-level lessons
- reflection-analyzer.py detects repeated patterns
- this script records candidate workflows before promotion into real skills
"""

import argparse
from datetime import datetime, timezone
from pathlib import Path


def block(args):
    created_at = datetime.now(timezone.utc).isoformat()
    def lines(value):
        return [x.strip() for x in (value or "").split(";") if x.strip()]

    def yaml_list(items, indent="  "):
        if not items:
            return f"{indent}[]"
        return "\n".join(f"{indent}- {item}" for item in items)

    return f"""\n### {args.name}\n\n```yaml\nname: {args.name}\ncreated_at: {created_at}\ntrigger: {args.trigger}\nsteps:\n{yaml_list(lines(args.steps))}\ntools_used:\n{yaml_list(lines(args.tools_used))}\nfailure_modes:\n{yaml_list(lines(args.failure_modes))}\nsafety_boundaries:\n{yaml_list(lines(args.safety_boundaries))}\nvalidation:\n{yaml_list(lines(args.validation))}\nexamples:\n{yaml_list(lines(args.examples))}\nsource_reflections:\n{yaml_list(lines(args.source_reflections))}\nstatus: {args.status}\nrequires_user_approval: true\n```\n"""


def main():
    parser = argparse.ArgumentParser(description="Append a skill candidate to memory/skill-candidates.md")
    parser.add_argument("--name", required=True)
    parser.add_argument("--trigger", required=True)
    parser.add_argument("--steps", default="", help="Semicolon-separated list")
    parser.add_argument("--tools_used", default="", help="Semicolon-separated list")
    parser.add_argument("--failure_modes", default="", help="Semicolon-separated list")
    parser.add_argument("--safety_boundaries", default="", help="Semicolon-separated list")
    parser.add_argument("--validation", default="", help="Semicolon-separated list")
    parser.add_argument("--examples", default="", help="Semicolon-separated list")
    parser.add_argument("--source_reflections", default="", help="Semicolon-separated list")
    parser.add_argument("--status", default="draft", choices=["draft", "shadow", "promoted", "rejected"])
    args = parser.parse_args()

    path = Path("memory/skill-candidates.md")
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# Skill Candidates — Proposed Reusable Workflows\n\n## Candidates\n", encoding="utf-8")

    with path.open("a", encoding="utf-8") as f:
        f.write(block(args))
    print(f"[knight] skill candidate appended to {path}")


if __name__ == "__main__":
    main()
