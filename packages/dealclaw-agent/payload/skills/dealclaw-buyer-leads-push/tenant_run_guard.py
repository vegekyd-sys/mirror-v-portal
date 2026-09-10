#!/usr/bin/env python3
"""Compatibility entry point for the tenant-scoped runtime guard."""

from pathlib import Path
import runpy


SCRIPT = Path(__file__).resolve().parent / "scripts" / "tenant_run_guard.py"

if not SCRIPT.is_file():
    raise SystemExit(f"Bundled implementation not found: {SCRIPT}")

runpy.run_path(str(SCRIPT), run_name="__main__")

