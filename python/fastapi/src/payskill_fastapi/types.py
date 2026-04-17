"""Shared types for payskill-fastapi middleware."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass
class PaymentInfo:
    """Verified payment info attached to the request after require_payment."""

    from_address: str
    """Payer wallet address (checksummed 0x...)."""

    amount: int
    """Amount in micro-USDC ($0.01 = 10000)."""

    settlement: Literal["tab", "direct"] | str
    """Settlement mode used."""

    tab_id: str | None = None
    """Tab ID if tab-backed, else None."""

    verified: bool = True
    """Always True when the middleware passes control to the handler."""


@dataclass
class RequirePaymentOptions:
    """Options for require_payment dependency."""

    price: float
    """Dollar amount to charge per request."""

    settlement: Literal["tab", "direct"]
    """Settlement mode: tab for micropayments, direct for $1+ one-shot."""

    provider_address: str
    """Provider wallet address (checksummed 0x...)."""

    facilitator_url: str | None = None
    """Facilitator URL. Defaults to mainnet."""

    fail_mode: Literal["closed", "open"] = "closed"
    """Behavior when facilitator is unreachable."""

    asset: str | None = None
    """USDC contract address. Auto-detected from facilitator_url if omitted."""
