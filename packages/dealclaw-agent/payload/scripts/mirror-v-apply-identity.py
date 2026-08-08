#!/usr/bin/env python3
"""Apply Mirror V identity overlay to core docs in a payload directory."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_DIR = ROOT / "config" / "mirror-v" / "templates"
CORE_TEMPLATES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "BOOTSTRAP.md"]


def render(text: str, values: dict[str, str]) -> str:
    for k, v in values.items():
        text = text.replace("{{" + k + "}}", v)
    return text


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload", type=Path, required=True)
    ap.add_argument("--profile", type=Path)
    ap.add_argument("--instance-id")
    ap.add_argument("--display-name")
    ap.add_argument("--baseline", default="v001-full")
    ap.add_argument("--owner", default="Tianyi / Versa")
    ap.add_argument("--memory-bundle", default="v001-full")
    ap.add_argument("--skill-bundle", default="v001-full")
    args = ap.parse_args()

    profile = {}
    if args.profile and args.profile.exists():
        profile = json.loads(args.profile.read_text())
    instance = profile.get("instance", {})
    overlay = profile.get("overlay", {})
    values = {
        "instance_id": args.instance_id or instance.get("id") or "mirror-v-instance",
        "display_name": args.display_name or instance.get("display_name") or instance.get("id") or "Mirror V Instance",
        "baseline": args.baseline or instance.get("baseline") or "v001-full",
        "owner": args.owner,
        "memory_bundle": args.memory_bundle or overlay.get("memory_bundle") or "v001-full",
        "skill_bundle": args.skill_bundle or overlay.get("skill_bundle") or "v001-full",
    }

    if not args.payload.exists():
        raise SystemExit(f"payload dir missing: {args.payload}")
    written = []
    for name in CORE_TEMPLATES:
        tpl = TEMPLATE_DIR / (name + ".tpl")
        if not tpl.exists():
            raise SystemExit(f"template missing: {tpl}")
        out = args.payload / name
        out.write_text(render(tpl.read_text(), values), encoding="utf-8")
        written.append(str(out))
    print(json.dumps({"identity_overlay": values, "written": written}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
