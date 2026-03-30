"""Tests for input validation in PayClient."""

import pytest

from payskill.client import _validate_address, _validate_amount
from payskill.errors import PayValidationError

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


class TestValidateAmount:
    def test_valid_direct_amount(self) -> None:
        _validate_amount(1_000_000, minimum=1_000_000)

    def test_below_minimum(self) -> None:
        with pytest.raises(PayValidationError, match="below minimum"):
            _validate_amount(500_000, minimum=1_000_000)

    def test_zero(self) -> None:
        with pytest.raises(PayValidationError):
            _validate_amount(0, minimum=1_000_000)

    def test_negative(self) -> None:
        with pytest.raises(PayValidationError):
            _validate_amount(-1, minimum=1_000_000)

    def test_exact_minimum(self) -> None:
        _validate_amount(5_000_000, minimum=5_000_000)
