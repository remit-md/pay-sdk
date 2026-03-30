"""Structured error types for the pay SDK."""


class PayError(Exception):
    """Base error for all pay SDK errors."""

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class PayValidationError(PayError):
    """Input validation failed (invalid address, amount below minimum, etc.)."""

    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message, code="validation_error")
        self.field = field


class PayNetworkError(PayError):
    """Network or server communication failed."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="network_error")


class PayServerError(PayError):
    """Server returned an error response."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message, code="server_error")
        self.status_code = status_code


class PayInsufficientFundsError(PayError):
    """Insufficient USDC balance for the requested operation."""

    def __init__(self, message: str = "Insufficient USDC balance") -> None:
        super().__init__(message, code="insufficient_funds")
