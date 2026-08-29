#!/usr/bin/env python3
"""Compatibility entry point for enterprise profile review validation."""

from pathlib import Path
import runpy


SCRIPT = Path(__file__).resolve().parent / "scripts" / "profile_confirmation_validator.py"

if not SCRIPT.is_file():
    raise SystemExit(f"Bundled implementation not found: {SCRIPT}")

runpy.run_path(str(SCRIPT), run_name="__main__")

