"""Tests for signer module."""

import pytest

from payskill.signer import (
    CallbackSigner,
    CliSigner,
    RawKeySigner,
    create_signer,
)


class TestCallbackSigner:
    def test_delegates_to_callback(self) -> None:
        sig = b"\x01" * 65
        signer = CallbackSigner(callback=lambda h: sig)
        assert signer.sign(b"\x00" * 32) == sig


class TestCreateSigner:
    def test_cli_mode(self) -> None:
        signer = create_signer("cli")
        assert isinstance(signer, CliSigner)

    def test_raw_mode_no_key(self) -> None:
        with pytest.raises(ValueError, match="No key"):
            create_signer("raw")

    def test_raw_mode_with_key(self) -> None:
        signer = create_signer("raw", key="0x" + "ab" * 32)
        assert isinstance(signer, RawKeySigner)

    def test_custom_mode(self) -> None:
        signer = create_signer("custom", callback=lambda h: b"\x00" * 65)
        assert isinstance(signer, CallbackSigner)

    def test_custom_mode_no_callback(self) -> None:
        with pytest.raises(ValueError, match="callback"):
            create_signer("custom")

    def test_unknown_mode(self) -> None:
        with pytest.raises(ValueError, match="Unknown"):
            create_signer("unknown")
