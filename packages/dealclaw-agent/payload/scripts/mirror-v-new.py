#!/usr/bin/env python3
"""Create a Mirror V instance profile and deploy command.

Non-interactive by default when args are passed; if required fields are missing,
it prompts in TTY. It does not deploy unless --execute-deploy is passed.
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE_DIR = ROOT / "config" / "mirror-v" / "instances"
DEFAULT_WORKSPACE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspace"


def ask(label: str, default: str | None = None) -> str:
    if not sys.stdin.isatty():
        if default is not None:
            return default
        raise SystemExit(f"missing required argument: {label}")
    suffix = f" [{default}]" if default is not None else ""
    val = input(f"{label}{suffix}: ").strip()
    return val or (default or "")


def yesno(label: str, default: bool) -> bool:
    if not sys.stdin.isatty():
        return default
    d = "Y/n" if default else "y/N"
    val = input(f"{label} [{d}]: ").strip().lower()
    if not val:
        return default
    return val in {"y", "yes", "true", "1", "是", "对"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance-id")
    ap.add_argument("--name")
    ap.add_argument("--host")
    ap.add_argument("--region")
    ap.add_argument("--instance", dest="cloud_instance_id")
    ap.add_argument("--workspace", default=DEFAULT_WORKSPACE)
    ap.add_argument("--memory-bundle", choices=["v001-full", "minimal", "project-overlay"], default=None)
    ap.add_argument("--skill-bundle", choices=["v001-full", "basic", "custom"], default=None)
    ap.add_argument("--inject-keys", dest="inject_keys", action="store_true", default=None)
    ap.add_argument("--no-inject-keys", dest="inject_keys", action="store_false")
    ap.add_argument("--install-browser", dest="install_browser", action="store_true", default=None)
    ap.add_argument("--no-install-browser", dest="install_browser", action="store_false")
    ap.add_argument("--checklist", dest="checklist", action="store_true", default=None)
    ap.add_argument("--no-checklist", dest="checklist", action="store_false")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--execute-deploy", action="store_true")
    args = ap.parse_args()

    iid = args.instance_id or ask("Mirror instance id", "mirror-v-002")
    name = args.name or ask("Display name", iid.replace("-", " ").title())
    host = args.host or ask("Target host/IP")
    region = args.region or ask("Tencent region", "ap-singapore")
    cloud_iid = args.cloud_instance_id or ask("Tencent Lighthouse instance id", "<lhins-id>")
    memory = args.memory_bundle or ask("Memory bundle (v001-full/minimal/project-overlay)", "v001-full")
    skills = args.skill_bundle or ask("Skill bundle (v001-full/basic/custom)", "v001-full")
    inject = args.inject_keys if args.inject_keys is not None else yesno("Inject runtime keys", True)
    browser = args.install_browser if args.install_browser is not None else yesno("Install/provision browser", True)
    checklist = args.checklist if args.checklist is not None else yesno("Run post-deploy checklist", True)

    profile = {
        "schema_version": "mirror-v-instance.v1",
        "instance": {"id": iid, "display_name": name, "baseline": "v001-full"},
        "target": {
            "provider": "tencent_lighthouse",
            "instance_id": cloud_iid,
            "region": region,
            "host": host,
            "workspace": args.workspace,
        },
        "overlay": {
            "memory_bundle": memory,
            "skill_bundle": skills,
            "inject_keys": inject,
            "runtime_keys": "full" if inject else "none",
            "install_browser": browser,
            "post_deploy_checklist": checklist,
        },
    }

    out = args.out or (PROFILE_DIR / f"{iid}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n")

    cmd = [
        sys.executable,
        "scripts/mirror-v-deploy.py",
        "--profile",
        str(out),
        "--instance-id",
        iid,
        "--name",
        name,
        "--host",
        host,
        "--region",
        region,
        "--instance",
        cloud_iid,
        "--use-selected-payload",
    ]
    if not inject:
        cmd.append("--no-inject-keys")
    if browser:
        cmd.append("--install-browser")
    if checklist:
        cmd.append("--checklist")
    if args.execute_deploy:
        cmd.append("--execute")

    print(json.dumps({"profile": str(out), "deploy_command": " ".join(shlex.quote(x) for x in cmd)}, ensure_ascii=False, indent=2))
    if args.execute_deploy:
        return subprocess.call(cmd, cwd=str(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
