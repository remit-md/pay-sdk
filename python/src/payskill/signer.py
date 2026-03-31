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

from eth_account import Account


class Signer(ABC):
    """Abstract signer interface."""

    @property
    @abstractmethod
    def address(self) -> str:
        """The signer's Ethereum address (0x-prefixed, checksummed)."""

    @abstractmethod
    def sign(self, hash_bytes: bytes) -> bytes:
        """Sign a 32-byte hash and return 65-byte signature (r || s || v)."""


class CliSigner(Signer):
    """Signs via the `pay sign` CLI subprocess."""

    def __init__(self, command: str = "pay", address: str = "") -> None:
        self.command = command
        self._address = address
        if not self._address:
            try:
                result = subprocess.run(
                    [self.command, "address"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode == 0:
                    self._address = result.stdout.strip()
            except Exception:
                self._address = ""

    @property
    def address(self) -> str:
        return self._address

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
    """Signs with a raw private key using eth_account. Dev/testing only."""

    def __init__(self, key: str | None = None) -> None:
        self._key = key or os.environ.get("PAYSKILL_KEY", "")
        if not self._key:
            msg = "No key provided and PAYSKILL_KEY not set"
            raise ValueError(msg)
        self._account = Account.from_key(self._key)

    @property
    def address(self) -> str:
        return str(self._account.address)

    def sign(self, hash_bytes: bytes) -> bytes:
        """Sign a 32-byte hash with ECDSA. Returns 65-byte r||s||v signature."""
        signed = self._account.unsafe_sign_hash(hash_bytes)
        # Construct 65-byte signature: r (32 bytes) || s (32 bytes) || v (1 byte)
        r_bytes = int(signed.r).to_bytes(32, "big")
        s_bytes = int(signed.s).to_bytes(32, "big")
        v_bytes = bytes([int(signed.v)])
        return bytes(r_bytes + s_bytes + v_bytes)


class CallbackSigner(Signer):
    """Delegates signing to a user-provided callback."""

    def __init__(
        self,
        callback: Callable[[bytes], bytes],
        address: str = "",
    ) -> None:
        self._callback = callback
        self._address = address

    @property
    def address(self) -> str:
        return self._address

    def sign(self, hash_bytes: bytes) -> bytes:
        return self._callback(hash_bytes)


def create_signer(mode: str = "cli", **kwargs: object) -> Signer:
    """Factory for creating signers.

    Args:
        mode: "cli" (default), "raw", or "custom"
        **kwargs: Passed to the signer constructor.
            - cli: command (str), address (str)
            - raw: key (str)
            - custom: callback (Callable[[bytes], bytes]), address (str)
    """
    if mode == "cli":
        return CliSigner(
            command=str(kwargs.get("command", "pay")),
            address=str(kwargs.get("address", "")),
        )
    if mode == "raw":
        return RawKeySigner(key=kwargs.get("key"))  # type: ignore[arg-type]
    if mode == "custom":
        callback = kwargs.get("callback")
        if callback is None:
            msg = "custom signer requires a callback"
            raise ValueError(msg)
        return CallbackSigner(
            callback=callback,  # type: ignore[arg-type]
            address=str(kwargs.get("address", "")),
        )
    msg = f"Unknown signer mode: {mode}"
    raise ValueError(msg)
