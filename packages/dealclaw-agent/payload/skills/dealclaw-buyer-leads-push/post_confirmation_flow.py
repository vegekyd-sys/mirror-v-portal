#!/usr/bin/env python3
"""Compatibility entry point for the immediate post-confirmation run flow."""

from pathlib import Path
import runpy
import sys


SCRIPT = Path(__file__).resolve().parent / "scripts" / "post_confirmation_flow.py"

if not SCRIPT.is_file():
    raise SystemExit(f"Bundled implementation not found: {SCRIPT}")

sys.path.insert(0, str(SCRIPT.parent))
runpy.run_path(str(SCRIPT), run_name="__main__")
