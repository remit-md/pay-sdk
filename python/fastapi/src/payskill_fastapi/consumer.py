"""Consumer-side FastAPI middleware.

Attaches ``request.state.pay`` to every incoming request, giving route
handlers a pay-enabled HTTP client that auto-settles x402 responses.

Usage::

    from fastapi import FastAPI, Request
    from payskill import Wallet
    from payskill_fastapi import PayMiddleware

    app = FastAPI()
    wallet = Wallet()

    app.add_middleware(PayMiddleware, wallet=wallet, max_per_request=1.00)

    @app.get("/forecast")
    async def forecast(request: Request):
        resp = request.state.pay.fetch("https://weather-api.example.com/forecast")
        return resp.json()
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from payskill import Wallet, create_pay_fetch
from payskill.fetch import PayFetch, PaymentEvent
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp


@dataclass
class PayContext:
    """Attached to request.state.pay by PayMiddleware."""

    fetch: PayFetch
    """Pay-enabled HTTP callable. Call like a function."""

    wallet: Wallet
    """The wallet instance (for direct payments, tab management)."""


class PayMiddleware(BaseHTTPMiddleware):
    """Starlette/FastAPI middleware that attaches a pay-enabled fetch to requests.

    The ``PayFetch`` instance is shared across all requests so budget limits
    (max_total) accumulate across the middleware's lifetime. ``max_per_request``
    is enforced per individual call.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        wallet: Wallet,
        max_per_request: float | None = None,
        max_total: float | None = None,
        on_payment: Callable[[PaymentEvent], None] | None = None,
    ) -> None:
        super().__init__(app)
        self._wallet = wallet
        self._pay_fetch = create_pay_fetch(
            wallet,
            max_per_request=max_per_request,
            max_total=max_total,
            on_payment=on_payment,
        )

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Any],
    ) -> Response:
        request.state.pay = PayContext(fetch=self._pay_fetch, wallet=self._wallet)
        return await call_next(request)  # type: ignore[no-any-return]
