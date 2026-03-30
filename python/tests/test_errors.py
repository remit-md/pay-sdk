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
        assert str(err) == "bad input"

    def test_server_error_status(self) -> None:
        err = PayServerError("not found", status_code=404)
        assert err.status_code == 404
        assert err.code == "server_error"

    def test_network_error(self) -> None:
        err = PayNetworkError("connection refused")
        assert err.code == "network_error"
