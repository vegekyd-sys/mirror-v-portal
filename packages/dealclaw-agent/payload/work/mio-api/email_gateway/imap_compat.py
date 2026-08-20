from __future__ import annotations

import imaplib

from .providers import ProviderConfig


def prepare_imap_session(client: imaplib.IMAP4_SSL, provider: ProviderConfig) -> None:
    """Apply provider-specific protocol setup after authentication."""
    if not provider.imap_id_required:
        return
    # NetEase 163 rejects mailbox selection as "Unsafe Login" unless the
    # client identifies itself through the IMAP ID extension.
    imaplib.Commands.setdefault("ID", ("AUTH",))
    status, _ = client._simple_command(  # stdlib has no public ID helper
        "ID", '("name" "DealClaw" "version" "1.0" "vendor" "Versa")'
    )
    if status != "OK":
        raise RuntimeError("IMAP provider rejected client identification")
