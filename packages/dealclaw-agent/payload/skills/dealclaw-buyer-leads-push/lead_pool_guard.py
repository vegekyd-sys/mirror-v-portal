#!/usr/bin/env python3
"""Compatibility entry point for the unified company lead pool guard."""

from pathlib import Path
import runpy


SCRIPT = Path(__file__).resolve().parent / "scripts" / "lead_pool_guard.py"

if not SCRIPT.is_file():
    raise SystemExit(f"Bundled implementation not found: {SCRIPT}")

runpy.run_path(str(SCRIPT), run_name="__main__")
