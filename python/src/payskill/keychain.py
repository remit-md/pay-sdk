"""OS keychain reader -- reads the private key stored by `pay` CLI.

Service: "pay", account: "default".

keyring is an optional dependency. If not installed, returns None.
"""

from __future__ import annotations


def read_from_keychain() -> str | None:
    """Read private key from OS keychain.

    Returns the key as a hex string, or None if keyring is not
    installed or no key is stored.
    """
    try:
        import keyring  # type: ignore[import-untyped]

        return keyring.get_password("pay", "default")  # type: ignore[no-any-return]
    except Exception:
        return None
