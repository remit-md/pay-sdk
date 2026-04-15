"""Provider-side FastAPI dependency for x402 payment verification.

Gates routes behind x402 paywalls. Unpaid requests get 402.
Paid requests are verified via the facilitator and passed to the handler
with PaymentInfo injected via FastAPI's Depends().

Usage::

    from fastapi import FastAPI, Depends
    from payskill_fastapi import require_payment, PaymentInfo

    app = FastAPI()

    @app.get("/api/data")
    async def get_data(
        payment: PaymentInfo = Depends(
            require_payment(price=0.01, settlement="tab", provider_address="0x...")
        ),
    ):
        return {"data": "premium", "paid_by": payment.from_address}
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from typing import Any, Literal

import httpx
from fastapi import HTTPException, Request

from payskill_fastapi.types import PaymentInfo

# -- Constants ----------------------------------------------------------------

MAINNET_FACILITATOR = "https://pay-skill.com/x402"
MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
TESTNET_FACILITATOR = "https://testnet.pay-skill.com/x402"
TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

MAINNET_NETWORK = "eip155:8453"
TESTNET_NETWORK = "eip155:84532"

VERIFY_TIMEOUT_SECONDS = 5.0


# -- Public API ---------------------------------------------------------------


def require_payment(
    *,
    price: float,
    settlement: Literal["tab", "direct"],
    provider_address: str,
    facilitator_url: str | None = None,
    fail_mode: Literal["closed", "open"] = "closed",
    asset: str | None = None,
) -> Callable[[Request], Any]:
    """Create a FastAPI dependency that requires x402 payment for a route.

    Returns an async callable to be used with ``Depends()``. The dependency
    checks the PAYMENT-SIGNATURE header, verifies via the facilitator, and
    returns a ``PaymentInfo`` on success. On failure it raises an HTTPException
    with the appropriate 402/503 response.

    Args:
        price: Dollar amount to charge per request.
        settlement: "tab" for micropayments, "direct" for $1+ one-shot.
        provider_address: Provider wallet address (0x...).
        facilitator_url: Facilitator URL. Defaults to mainnet.
        fail_mode: "closed" (block on facilitator error) or "open" (passthrough).
        asset: USDC contract address. Auto-detected from facilitator_url.

    Returns:
        A dependency callable for use with Depends().
    """
    resolved_facilitator = facilitator_url or MAINNET_FACILITATOR
    is_testnet = "testnet" in resolved_facilitator
    network = TESTNET_NETWORK if is_testnet else MAINNET_NETWORK
    resolved_asset = asset or (TESTNET_USDC if is_testnet else MAINNET_USDC)
    amount_micro = str(round(price * 1_000_000))

    async def dependency(request: Request) -> PaymentInfo:
        payment_header = request.headers.get("payment-signature")

        # No payment — 402
        if not payment_header:
            raise _payment_required(
                request,
                amount_micro,
                network,
                resolved_asset,
                provider_address,
                settlement,
                resolved_facilitator,
            )

        # Decode payload
        try:
            payment_payload: Any = json.loads(base64.b64decode(payment_header).decode("utf-8"))
        except Exception as e:
            raise _payment_required(
                request,
                amount_micro,
                network,
                resolved_asset,
                provider_address,
                settlement,
                resolved_facilitator,
                reason="Invalid PAYMENT-SIGNATURE header: base64/JSON decode failed",
            ) from e

        # Verify via facilitator
        offer = _build_offer(
            amount_micro,
            network,
            resolved_asset,
            provider_address,
            settlement,
            resolved_facilitator,
        )

        verify_result = await _verify_payment(resolved_facilitator, payment_payload, offer)

        # Facilitator unreachable
        if verify_result is None:
            if fail_mode == "open":
                return PaymentInfo(
                    from_address="",
                    amount=int(amount_micro),
                    settlement=settlement,
                    verified=True,
                )
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "facilitator_unavailable",
                    "message": "Payment facilitator is unreachable. Try again later.",
                },
            )

        # Invalid payment
        if not verify_result.get("isValid"):
            raise _payment_required(
                request,
                amount_micro,
                network,
                resolved_asset,
                provider_address,
                settlement,
                resolved_facilitator,
                reason=verify_result.get("invalidReason"),
            )

        # Valid — build PaymentInfo
        return PaymentInfo(
            from_address=verify_result.get("payer", ""),
            amount=int(amount_micro),
            settlement=settlement,
            verified=True,
        )

    return dependency


# -- Internal -----------------------------------------------------------------


def _build_offer(
    amount: str,
    network: str,
    asset: str,
    pay_to: str,
    settlement: str,
    facilitator: str,
) -> dict[str, Any]:
    return {
        "scheme": "exact",
        "network": network,
        "amount": amount,
        "asset": asset,
        "payTo": pay_to,
        "maxTimeoutSeconds": 60,
        "extra": {
            "settlement": settlement,
            "facilitator": facilitator,
        },
    }


def _payment_required(
    request: Request,
    amount: str,
    network: str,
    asset: str,
    pay_to: str,
    settlement: str,
    facilitator: str,
    reason: str | None = None,
) -> HTTPException:
    """Build a 402 HTTPException with PAYMENT-REQUIRED header."""
    offer = _build_offer(amount, network, asset, pay_to, settlement, facilitator)

    requirements = {
        "x402Version": 2,
        "accepts": [offer],
        "resource": {
            "url": request.url.path + (("?" + request.url.query) if request.url.query else ""),
            "mimeType": "application/json",
        },
        "extensions": {},
    }

    encoded = base64.b64encode(json.dumps(requirements).encode()).decode()
    dollars = int(amount) / 1_000_000
    message = reason or f"This endpoint requires payment of ${dollars:.2f}"

    return HTTPException(
        status_code=402,
        detail={
            "error": "payment_required",
            "message": message,
            "requirements": requirements,
        },
        headers={"PAYMENT-REQUIRED": encoded},
    )


async def _verify_payment(
    facilitator_url: str,
    payment_payload: Any,
    payment_requirements: dict[str, Any],
) -> dict[str, Any] | None:
    """Call facilitator /verify. Returns None on network/timeout error."""
    body = {
        "x402Version": 2,
        "paymentPayload": payment_payload,
        "paymentRequirements": payment_requirements,
    }

    try:
        async with httpx.AsyncClient(timeout=VERIFY_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{facilitator_url}/verify",
                json=body,
            )
            if resp.status_code != 200:
                return {
                    "isValid": False,
                    "invalidReason": f"Facilitator returned {resp.status_code}",
                }
            return resp.json()  # type: ignore[no-any-return]
    except (httpx.HTTPError, httpx.TimeoutException):
        return None
