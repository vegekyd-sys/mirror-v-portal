from __future__ import annotations

import os
import stat
from pathlib import Path


class SecretResolutionError(RuntimeError):
    pass


def resolve_secret(secret_ref: str) -> str:
    """Resolve an email credential without storing it in account records.

    Supported references:
      env:VARIABLE_NAME
      file:/absolute/path
    """
    if secret_ref.startswith("env:"):
        name = secret_ref[4:].strip()
        if not name:
            raise SecretResolutionError("empty environment variable name")
        value = os.getenv(name)
        if not value:
            raise SecretResolutionError(f"secret environment variable {name!r} is not set")
        return value.strip()

    if secret_ref.startswith("file:"):
        path = Path(secret_ref[5:]).expanduser()
        if not path.is_absolute():
            raise SecretResolutionError("secret file reference must be an absolute path")
        if not path.is_file():
            raise SecretResolutionError("secret file does not exist")
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            raise SecretResolutionError("secret file must not be readable by group or others")
        value = path.read_text(encoding="utf-8").strip()
        if not value:
            raise SecretResolutionError("secret file is empty")
        return value

    raise SecretResolutionError("secret_ref must use env:NAME or file:/absolute/path")

