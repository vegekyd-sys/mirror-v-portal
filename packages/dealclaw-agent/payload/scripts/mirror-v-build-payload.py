#!/usr/bin/env python3
"""Build a Mirror V payload from baseline + selectable memory/skill bundles.

This turns overlay choices into a physical payload archive. It operates on an
already-materialized baseline payload directory (default: V001 dry-run payload)
and writes a selected payload directory + tar.zst archive.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASELINE_PROFILE = ROOT / "config" / "mirror-v" / "profiles" / "v001-full.json"
DEFAULT_SOURCE_PAYLOAD = ROOT / "work" / "mirror-v" / "dry-run-output" / "payload"
DEFAULT_OUT_ROOT = ROOT / "work" / "mirror-v" / "generated"
CORE_DOCS = {"AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "PROJECTS.md", "HEARTBEAT.md", "TOOLS.md"}


def run(cmd: list[str], cwd: Path | None = None) -> str:
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise SystemExit(f"Command failed ({p.returncode}): {' '.join(cmd)}\nSTDOUT:\n{p.stdout}\nSTDERR:\n{p.stderr}")
    return p.stdout


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def norm(pat: str) -> str:
    return pat.strip().lstrip("./")


def match_one(path: str, pat: str) -> bool:
    path = path.strip().lstrip("./")
    pat = norm(pat)
    if pat == "<baseline>":
        return True
    if pat.endswith("/**"):
        base = pat[:-3]
        return path == base or path.startswith(base + "/")
    return fnmatch.fnmatch(path, pat) or path == pat or path.startswith(pat.rstrip("/") + "/")


def any_match(path: str, patterns: list[str]) -> bool:
    return any(match_one(path, p) for p in patterns)


def list_files(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())


def merged_files(source_payload: Path, overlay_root: Path) -> list[str]:
    files = set(list_files(source_payload))
    # Operational scripts/templates may not exist in the VSync golden snapshot.
    # They are part of Mirror V product runtime and are overlaid from the current workspace.
    for prefix in ["scripts", "config/mirror-v"]:
        root = overlay_root / prefix
        if root.exists():
            for p in root.rglob("*"):
                if p.is_file():
                    files.add(str(p.relative_to(overlay_root)))
    return sorted(files)


def load_bundle(profile: dict[str, Any], kind: str, name: str) -> dict[str, Any]:
    bundles = profile.get("selectable", {}).get(kind, {})
    if name not in bundles:
        raise SystemExit(f"unknown {kind}: {name}; available={','.join(sorted(bundles))}")
    return bundles[name]


def selected_files(files: list[str], memory_bundle: dict[str, Any], skill_bundle: dict[str, Any]) -> tuple[list[str], list[str]]:
    include: list[str] = []
    exclude: list[str] = []
    include += memory_bundle.get("include", [])
    exclude += memory_bundle.get("exclude", [])
    include += skill_bundle.get("include", [])
    exclude += skill_bundle.get("exclude", [])

    selected: list[str] = []
    excluded: list[str] = []
    for f in files:
        if f in CORE_DOCS and any_match(f, include):
            inc = True
        else:
            inc = any_match(f, include)
        exc = any_match(f, exclude)
        if inc and not exc:
            selected.append(f)
        elif inc and exc:
            excluded.append(f)
    return selected, excluded


def copy_selected(source: Path, dest: Path, files: list[str]) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for rel in files:
        src = source / rel
        dst = dest / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def copy_selected_with_overlay(source: Path, overlay_root: Path, dest: Path, files: list[str]) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for rel in files:
        src = source / rel
        if not src.exists():
            src = overlay_root / rel
        if not src.exists():
            raise SystemExit(f"selected file missing from source and overlay: {rel}")
        dst = dest / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def classify(path: str) -> str:
    if path.startswith("memory/"):
        return "memory"
    if path.startswith("skills/"):
        return "skills"
    if path in CORE_DOCS:
        return "core_docs"
    return "other"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline-profile", type=Path, default=DEFAULT_BASELINE_PROFILE)
    ap.add_argument("--source-payload", type=Path, default=DEFAULT_SOURCE_PAYLOAD)
    ap.add_argument("--instance-id", required=True)
    ap.add_argument("--memory-bundle", default="v001-full")
    ap.add_argument("--skill-bundle", default="v001-full")
    ap.add_argument("--profile", type=Path, help="optional mirror instance profile for identity overlay")
    ap.add_argument("--display-name", help="display name for identity overlay")
    ap.add_argument("--owner", default="Tianyi / Versa")
    ap.add_argument("--skip-identity-overlay", action="store_true")
    ap.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    profile = json.loads(args.baseline_profile.read_text())
    if not args.source_payload.exists():
        raise SystemExit(f"source payload missing: {args.source_payload}")
    memory = load_bundle(profile, "memory_bundle", args.memory_bundle)
    skills = load_bundle(profile, "skill_bundle", args.skill_bundle)
    files = merged_files(args.source_payload, ROOT)
    selected, excluded = selected_files(files, memory, skills)

    out_dir = args.out_root / args.instance_id / "payload"
    archive = args.out_root / args.instance_id / f"{args.instance_id}-payload.tar.zst"
    manifest = args.out_root / args.instance_id / "payload-manifest.json"
    selected_txt = args.out_root / args.instance_id / "selected-files.txt"
    excluded_txt = args.out_root / args.instance_id / "excluded-files.txt"

    counts: dict[str, int] = {}
    for f in selected:
        k = classify(f)
        counts[k] = counts.get(k, 0) + 1

    plan = {
        "schema": "mirror-v-payload-manifest.v1",
        "instance_id": args.instance_id,
        "baseline_profile": str(args.baseline_profile),
        "source_payload": str(args.source_payload),
        "memory_bundle": args.memory_bundle,
        "skill_bundle": args.skill_bundle,
        "source_file_count": len(files),
        "selected_file_count": len(selected),
        "excluded_file_count": len(excluded),
        "counts_by_kind": counts,
        "payload_dir": str(out_dir),
        "archive": str(archive),
    }

    print(json.dumps(plan, ensure_ascii=False, indent=2))
    if args.dry_run:
        return 0

    archive.parent.mkdir(parents=True, exist_ok=True)
    copy_selected_with_overlay(args.source_payload, ROOT, out_dir, selected)
    if not args.skip_identity_overlay:
        overlay_cmd = [
            sys.executable,
            str(ROOT / "scripts" / "mirror-v-apply-identity.py"),
            "--payload",
            str(out_dir),
            "--instance-id",
            args.instance_id,
            "--baseline",
            "v001-full",
            "--owner",
            args.owner,
            "--memory-bundle",
            args.memory_bundle,
            "--skill-bundle",
            args.skill_bundle,
        ]
        if args.profile:
            overlay_cmd += ["--profile", str(args.profile)]
        if args.display_name:
            overlay_cmd += ["--display-name", args.display_name]
        run(overlay_cmd)
    run(["tar", "--zstd", "-cf", str(archive), "."], cwd=out_dir)
    plan["archive_sha256"] = sha256(archive)
    plan["archive_bytes"] = archive.stat().st_size
    manifest.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
    selected_txt.write_text("\n".join(selected) + "\n")
    excluded_txt.write_text("\n".join(excluded) + "\n")
    print(json.dumps({"written": str(manifest), "archive_sha256": plan["archive_sha256"], "archive_bytes": plan["archive_bytes"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
