"""Signer interface and implementations for the pay SDK.

Three modes:
1. CLI signer (default): subprocess call to `pay sign`
2. Raw key: from PAYSKILL_KEY environment variable (dev/testing only)
3. Custom: user provides a sign(hash) -> signature callback
"""

from __future__ import annotations

import os
import subprocess
from abc import ABC, abstractmethod
from collections.abc import Callable


class Signer(ABC):
    """Abstract signer interface."""

    @abstractmethod
    def sign(self, hash_bytes: bytes) -> bytes:
        """Sign a 32-byte hash and return the signature."""


class CliSigner(Signer):
    """Signs via the `pay sign` CLI subprocess."""

    def __init__(self, command: str = "pay") -> None:
        self.command = command

    def sign(self, hash_bytes: bytes) -> bytes:
        result = subprocess.run(
            [self.command, "sign"],
            input=hash_bytes.hex(),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            msg = f"CLI signer failed: {result.stderr.strip()}"
            raise RuntimeError(msg)
        return bytes.fromhex(result.stdout.strip())


class RawKeySigner(Signer):
    """Signs with a raw private key from environment variable. Dev/testing only."""

    def __init__(self, key: str | None = None) -> None:
        self._key = key or os.environ.get("PAYSKILL_KEY", "")
        if not self._key:
            msg = "No key provided and PAYSKILL_KEY not set"
            raise ValueError(msg)

    def sign(self, hash_bytes: bytes) -> bytes:
        # Actual signing implementation will use eth_account
        # Placeholder: this will be implemented when the server endpoints exist
        raise NotImplementedError("Raw key signing not yet implemented")


class CallbackSigner(Signer):
    """Delegates signing to a user-provided callback."""

    def __init__(self, callback: Callable[[bytes], bytes]) -> None:
        self._callback = callback

    def sign(self, hash_bytes: bytes) -> bytes:
        return self._callback(hash_bytes)


def create_signer(mode: str = "cli", **kwargs: object) -> Signer:
    """Factory for creating signers.

    Args:
        mode: "cli" (default), "raw", or "custom"
        **kwargs: Passed to the signer constructor.
            - cli: command (str)
            - raw: key (str)
            - custom: callback (Callable[[bytes], bytes])
    """
    if mode == "cli":
        return CliSigner(command=str(kwargs.get("command", "pay")))
    if mode == "raw":
        return RawKeySigner(key=kwargs.get("key"))  # type: ignore[arg-type]
    if mode == "custom":
        callback = kwargs.get("callback")
        if callback is None:
            msg = "custom signer requires a callback"
            raise ValueError(msg)
        return CallbackSigner(callback=callback)  # type: ignore[arg-type]
    msg = f"Unknown signer mode: {mode}"
    raise ValueError(msg)
