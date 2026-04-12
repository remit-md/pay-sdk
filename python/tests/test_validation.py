"""Tests for input validation helpers."""

import pytest

from payskill.errors import PayValidationError
from payskill.wallet import _to_micro, _validate_address

VALID_ADDR = "0x" + "a1" * 20


class TestValidateAddress:
    def test_valid_address(self) -> None:
        _validate_address(VALID_ADDR)

    def test_missing_prefix(self) -> None:
        with pytest.raises(PayValidationError, match="Invalid Ethereum address"):
            _validate_address("a1" * 20)

    def test_too_short(self) -> None:
        with pytest.raises(PayValidationError):
            _validate_address("0x1234")

    def test_too_long(self) -> None:
        with pytest.raises(PayValidationError):
            _validate_address("0x" + "a1" * 21)

    def test_non_hex(self) -> None:
        with pytest.raises(PayValidationError):
            _validate_address("0x" + "zz" * 20)

    def test_empty(self) -> None:
        with pytest.raises(PayValidationError):
            _validate_address("")


class TestToMicro:
    def test_dollar_amount(self) -> None:
        assert _to_micro(1.0) == 1_000_000

    def test_integer_dollar(self) -> None:
        assert _to_micro(5) == 5_000_000

    def test_micro_dict(self) -> None:
        assert _to_micro({"micro": 5_000_000}) == 5_000_000

    def test_zero(self) -> None:
        assert _to_micro(0) == 0

    def test_negative_raises(self) -> None:
        with pytest.raises(PayValidationError, match="positive"):
            _to_micro(-1.0)

    def test_nan_raises(self) -> None:
        with pytest.raises(PayValidationError):
            _to_micro(float("nan"))

    def test_negative_micro_raises(self) -> None:
        with pytest.raises(PayValidationError, match="non-negative"):
            _to_micro({"micro": -1})
