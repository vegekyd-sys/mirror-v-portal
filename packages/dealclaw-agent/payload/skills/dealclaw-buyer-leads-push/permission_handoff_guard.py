#!/usr/bin/env python3
"""Compatibility entry point for Feishu permission ownership handoff planning."""

from pathlib import Path
import runpy
import sys


SCRIPT = Path(__file__).resolve().parent / "scripts" / "permission_handoff_guard.py"

if not SCRIPT.is_file():
    raise SystemExit(f"Bundled implementation not found: {SCRIPT}")

sys.path.insert(0, str(SCRIPT.parent))
runpy.run_path(str(SCRIPT), run_name="__main__")
