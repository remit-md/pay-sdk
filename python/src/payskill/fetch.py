"""Drop-in HTTP wrapper that handles x402 payments automatically.

Usage::

    from payskill import Wallet, create_pay_fetch

    wallet = Wallet()
    pay_fetch = create_pay_fetch(wallet, max_per_request=1.00, max_total=50.00)

    # Every call auto-pays 402 responses
    response = pay_fetch("https://api.example.com/data")

    # With httpx client (transport adapter)
    import httpx
    client = httpx.Client(transport=pay_fetch.transport())

Inject into any SDK that accepts custom HTTP clients::

    import anthropic
    client = anthropic.Anthropic(http_client=httpx.Client(transport=pay_fetch.transport()))
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx

from payskill.errors import PayBudgetExceededError, PayNetworkError

# -- Types --------------------------------------------------------------------

if TYPE_CHECKING:
    from payskill.wallet import Wallet


@dataclass
class PayFetchOptions:
    """Budget and behavior options for create_pay_fetch."""

    max_per_request: float | None = None
    """Maximum dollars to pay for a single 402 settlement."""

    max_total: float | None = None
    """Maximum total dollars across all settlements in this wrapper's lifetime."""

    on_payment: Callable[[PaymentEvent], None] | None = None
    """Called after each successful x402 payment."""


@dataclass
class PaymentEvent:
    """Metadata emitted after each successful x402 settlement."""

    url: str
    """The URL that required payment."""

    amount: float
    """Dollar amount paid."""

    settlement: str
    """How the payment was settled ("direct" or "tab")."""


# -- Implementation -----------------------------------------------------------

_PAYMENT_HEADERS = frozenset({"payment-signature", "x-payment"})


class PayFetch:
    """Callable HTTP wrapper that auto-settles x402 responses.

    Call directly like a function, or use ``.transport()`` to get an
    httpx transport adapter for injection into httpx.Client.
    """

    def __init__(self, wallet: Wallet, options: PayFetchOptions | None = None) -> None:
        self._wallet = wallet
        opts = options or PayFetchOptions()
        self._max_per_request = opts.max_per_request
        self._max_total = opts.max_total
        self._on_payment = opts.on_payment
        self._total_spent: float = 0

    @property
    def total_spent(self) -> float:
        """Total dollars spent through this wrapper."""
        return self._total_spent

    def __call__(
        self,
        url: str,
        *,
        method: str = "GET",
        body: Any = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """Make an HTTP request, auto-paying any 402 response.

        Args:
            url: The URL to request.
            method: HTTP method (default GET, POST if body provided).
            body: Request body (dict or string). Dicts are JSON-serialized.
            headers: Additional request headers.

        Returns:
            The final httpx.Response (after payment if 402 was encountered).

        Raises:
            PayBudgetExceededError: If payment would exceed budget limits.
            PayNetworkError: If the request fails due to network issues.
        """
        if body is not None and method == "GET":
            req_method = "POST"
        else:
            req_method = method
        req_headers = dict(headers) if headers else {}
        body_str = json.dumps(body) if isinstance(body, dict) else body

        try:
            resp = self._wallet._client.request(
                req_method,
                url,
                content=body_str.encode() if body_str else None,
                headers=req_headers,
            )
        except httpx.HTTPError as e:
            raise PayNetworkError(str(e)) from e

        if resp.status_code != 402:
            return resp

        # Don't retry if we already attached a payment header (prevent loops)
        lower_headers = {k.lower() for k in req_headers}
        if lower_headers & _PAYMENT_HEADERS:
            return resp

        # Parse amount from 402 to check budget before paying
        amount_micro = _parse_402_amount(resp)
        amount_dollars = amount_micro / 1_000_000

        if self._max_per_request is not None and amount_dollars > self._max_per_request:
            raise PayBudgetExceededError(
                f"Payment of ${amount_dollars:.2f} exceeds per-request limit "
                f"of ${self._max_per_request:.2f}",
                spent=self._total_spent,
                requested=amount_dollars,
                limit_type="per_request",
            )

        if self._max_total is not None and self._total_spent + amount_dollars > self._max_total:
            raise PayBudgetExceededError(
                f"Payment of ${amount_dollars:.2f} would exceed total budget "
                f"of ${self._max_total:.2f} (spent: ${self._total_spent:.2f})",
                spent=self._total_spent,
                requested=amount_dollars,
                limit_type="total",
            )

        # Settle payment and retry
        reqs = self._wallet._parse_402(resp)
        if reqs["settlement"] == "tab":
            result = self._wallet._settle_via_tab(url, req_method, body_str, req_headers, reqs)
        else:
            result = self._wallet._settle_via_direct(url, req_method, body_str, req_headers, reqs)

        self._total_spent += amount_dollars
        if self._on_payment is not None:
            self._on_payment(
                PaymentEvent(
                    url=url,
                    amount=amount_dollars,
                    settlement=reqs["settlement"],
                )
            )

        return result

    def transport(self) -> PayFetchTransport:
        """Create an httpx transport adapter for injection into httpx.Client.

        Usage::

            import httpx
            client = httpx.Client(transport=pay_fetch.transport())
            resp = client.get("https://api.example.com/data")
        """
        return PayFetchTransport(self)


class PayFetchTransport(httpx.BaseTransport):
    """httpx transport adapter that routes requests through PayFetch."""

    def __init__(self, pay_fetch: PayFetch) -> None:
        self._pay_fetch = pay_fetch

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        headers = dict(request.headers)
        body_bytes = request.read()
        body_str = body_bytes.decode() if body_bytes else None

        return self._pay_fetch(
            str(request.url),
            method=request.method,
            body=body_str,
            headers=headers,
        )


# -- Public factory -----------------------------------------------------------


def create_pay_fetch(
    wallet: Wallet,
    *,
    max_per_request: float | None = None,
    max_total: float | None = None,
    on_payment: Callable[[PaymentEvent], None] | None = None,
) -> PayFetch:
    """Create an HTTP callable that automatically settles x402 responses.

    The returned object is callable with the same interface as a simple
    HTTP function. It also exposes ``.transport()`` for httpx integration.

    Args:
        wallet: A configured Wallet instance.
        max_per_request: Maximum dollars for a single payment.
        max_total: Maximum total dollars across all payments.
        on_payment: Callback after each successful settlement.

    Returns:
        A PayFetch instance (callable).

    Example::

        from payskill import Wallet, create_pay_fetch

        wallet = Wallet()
        pay = create_pay_fetch(wallet, max_per_request=1.00, max_total=50.00)
        resp = pay("https://api.example.com/data")

    Example with httpx.Client::

        import httpx
        from payskill import Wallet, create_pay_fetch

        wallet = Wallet()
        pay = create_pay_fetch(wallet)
        client = httpx.Client(transport=pay.transport())
        resp = client.get("https://api.example.com/data")
    """
    return PayFetch(
        wallet,
        PayFetchOptions(
            max_per_request=max_per_request,
            max_total=max_total,
            on_payment=on_payment,
        ),
    )


# -- Internal -----------------------------------------------------------------


def _parse_402_amount(resp: httpx.Response) -> int:
    """Extract payment amount from a 402 response without consuming the body."""
    header = resp.headers.get("payment-required")
    if not header:
        return 0
    try:
        decoded = json.loads(base64.b64decode(header))
        accepts = decoded.get("accepts")
        if isinstance(accepts, list) and len(accepts) > 0:
            return int(accepts[0].get("amount", 0))
        return int(decoded.get("amount", 0))
    except Exception:  # noqa: S110
        return 0
