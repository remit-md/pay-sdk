"""Tests for error types."""

from payskill.errors import (
    PayError,
    PayInsufficientFundsError,
    PayNetworkError,
    PayServerError,
    PayValidationError,
)


class TestErrorHierarchy:
    def test_all_inherit_from_pay_error(self) -> None:
        assert issubclass(PayValidationError, PayError)
        assert issubclass(PayNetworkError, PayError)
        assert issubclass(PayServerError, PayError)
        assert issubclass(PayInsufficientFundsError, PayError)

    def test_validation_error_fields(self) -> None:
        err = PayValidationError("bad input", field="amount")
        assert err.code == "validation_error"
        assert err.field == "amount"
        assert "bad input" in str(err)

    def test_server_error_status(self) -> None:
        err = PayServerError("not found", status_code=404)
        assert err.status_code == 404
        assert err.code == "server_error"

    def test_network_error(self) -> None:
        err = PayNetworkError("connection refused")
        assert err.code == "network_error"

    def test_insufficient_funds_hint(self) -> None:
        err = PayInsufficientFundsError("not enough", balance=5.0, required=10.0)
        assert err.code == "insufficient_funds"
        assert err.balance == 5.0
        assert err.required == 10.0
        assert "create_fund_link" in str(err)

    def test_base_error_code(self) -> None:
        err = PayError("generic")
        assert err.code == "pay_error"
