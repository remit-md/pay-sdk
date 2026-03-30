"""PayClient — single entry point for the pay SDK."""

from __future__ import annotations

import re
from typing import Any

import httpx

from payskill.errors import PayNetworkError, PayServerError, PayValidationError
from payskill.models import (
    DirectPaymentResult,
    StatusResponse,
    Tab,
    WebhookRegistration,
)
from payskill.signer import Signer, create_signer

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_DIRECT_MIN = 1_000_000  # $1.00 USDC
_TAB_MIN = 5_000_000  # $5.00 USDC

DEFAULT_API_URL = "https://pay-skill.com/api/v1"


def _validate_address(address: str, field: str = "address") -> None:
    if not _ADDRESS_RE.match(address):
        raise PayValidationError(f"Invalid Ethereum address: {address}", field=field)


def _validate_amount(amount: int, minimum: int, field: str = "amount") -> None:
    if amount < minimum:
        min_usd = minimum / 1_000_000
        raise PayValidationError(f"Amount {amount} below minimum (${min_usd:.2f})", field=field)


class PayClient:
    """Client for the pay API.

    Args:
        api_url: Base URL of the pay API server.
        signer: Signer mode ("cli", "raw", "custom") or a Signer instance.
        **signer_kwargs: Passed to create_signer if signer is a string.
    """

    def __init__(
        self,
        api_url: str = DEFAULT_API_URL,
        signer: str | Signer = "cli",
        **signer_kwargs: Any,
    ) -> None:
        self._api_url = api_url.rstrip("/")
        self._signer = (
            signer if isinstance(signer, Signer) else create_signer(signer, **signer_kwargs)
        )
        self._http = httpx.Client(base_url=self._api_url, timeout=30.0)

    def close(self) -> None:
        """Close the HTTP client."""
        self._http.close()

    def __enter__(self) -> PayClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    # ── Direct Payment ──────────────────────────────────────────────

    def pay_direct(self, to: str, amount: int, memo: str = "") -> DirectPaymentResult:
        """Send a one-shot USDC payment.

        Args:
            to: Provider wallet address (0x...).
            amount: Amount in USDC micro-units (6 decimals). $1.00 = 1_000_000.
            memo: Optional memo string.
        """
        _validate_address(to, field="to")
        _validate_amount(amount, _DIRECT_MIN)
        data = self._post("/direct", {"to": to, "amount": amount, "memo": memo})
        return DirectPaymentResult.model_validate(data)

    # ── Tab Management ──────────────────────────────────────────────

    def open_tab(self, provider: str, amount: int, max_charge_per_call: int) -> Tab:
        """Open a pre-funded metered tab.

        Args:
            provider: Provider wallet address.
            amount: Amount to lock in USDC micro-units ($5.00 minimum).
            max_charge_per_call: Maximum charge per call in USDC micro-units.
        """
        _validate_address(provider, field="provider")
        _validate_amount(amount, _TAB_MIN)
        if max_charge_per_call <= 0:
            raise PayValidationError(
                "max_charge_per_call must be positive", field="max_charge_per_call"
            )
        data = self._post(
            "/tabs",
            {
                "provider": provider,
                "amount": amount,
                "max_charge_per_call": max_charge_per_call,
            },
        )
        return Tab.model_validate(data)

    def close_tab(self, tab_id: str) -> Tab:
        """Close a tab and distribute funds."""
        data = self._post(f"/tabs/{tab_id}/close", {})
        return Tab.model_validate(data)

    def top_up_tab(self, tab_id: str, amount: int) -> Tab:
        """Add funds to an open tab."""
        _validate_amount(amount, 1, field="amount")
        data = self._post(f"/tabs/{tab_id}/topup", {"amount": amount})
        return Tab.model_validate(data)

    def list_tabs(self) -> list[Tab]:
        """List all open tabs."""
        data = self._get("/tabs")
        return [Tab.model_validate(t) for t in data]

    def get_tab(self, tab_id: str) -> Tab:
        """Get a specific tab."""
        data = self._get(f"/tabs/{tab_id}")
        return Tab.model_validate(data)

    # ── x402 ────────────────────────────────────────────────────────

    def request(
        self,
        url: str,
        method: str = "GET",
        body: Any = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """Make an x402-aware HTTP request.

        If the server returns 402, the SDK handles payment automatically.
        """
        # Stub: full x402 flow will be implemented when server endpoints exist
        response = httpx.request(method, url, json=body, headers=headers, timeout=30.0)
        # TODO: handle 402 → sign → retry (requires server endpoints)
        return response

    # ── Wallet ──────────────────────────────────────────────────────

    def get_status(self) -> StatusResponse:
        """Get wallet balance and open tabs."""
        data = self._get("/status")
        return StatusResponse.model_validate(data)

    # ── Webhooks ────────────────────────────────────────────────────

    def register_webhook(
        self,
        url: str,
        events: list[str] | None = None,
        secret: str | None = None,
    ) -> WebhookRegistration:
        """Register a webhook endpoint."""
        payload: dict[str, Any] = {"url": url}
        if events:
            payload["events"] = events
        if secret:
            payload["secret"] = secret
        data = self._post("/webhooks", payload)
        return WebhookRegistration.model_validate(data)

    def list_webhooks(self) -> list[WebhookRegistration]:
        """List registered webhooks."""
        data = self._get("/webhooks")
        return [WebhookRegistration.model_validate(w) for w in data]

    def delete_webhook(self, webhook_id: str) -> None:
        """Delete a webhook."""
        self._delete(f"/webhooks/{webhook_id}")

    # ── Funding ─────────────────────────────────────────────────────

    def create_fund_link(self, amount: int | None = None) -> str:
        """Get a funding link (Coinbase Onramp)."""
        params = {"amount": str(amount)} if amount else {}
        data = self._get("/fund-link", params=params)
        return str(data.get("url", ""))

    def create_withdraw_link(self, amount: int | None = None) -> str:
        """Get a withdrawal link."""
        params = {"amount": str(amount)} if amount else {}
        data = self._get("/withdraw-link", params=params)
        return str(data.get("url", ""))

    # ── HTTP helpers ────────────────────────────────────────────────

    def _get(self, path: str, params: dict[str, str] | None = None) -> Any:
        try:
            resp = self._http.get(path, params=params)
        except httpx.HTTPError as e:
            raise PayNetworkError(str(e)) from e
        return self._handle_response(resp)

    def _post(self, path: str, payload: dict[str, Any]) -> Any:
        try:
            resp = self._http.post(path, json=payload)
        except httpx.HTTPError as e:
            raise PayNetworkError(str(e)) from e
        return self._handle_response(resp)

    def _delete(self, path: str) -> Any:
        try:
            resp = self._http.delete(path)
        except httpx.HTTPError as e:
            raise PayNetworkError(str(e)) from e
        return self._handle_response(resp)

    @staticmethod
    def _handle_response(resp: httpx.Response) -> Any:
        if resp.status_code >= 400:
            try:
                body = resp.json()
                msg = body.get("error", resp.text)
            except Exception:
                msg = resp.text
            raise PayServerError(msg, status_code=resp.status_code)
        if resp.status_code == 204:
            return None
        return resp.json()
