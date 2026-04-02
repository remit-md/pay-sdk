"""PayClient — single entry point for the pay SDK."""

from __future__ import annotations

import re
from typing import Any

import httpx

from payskill.auth import build_auth_headers
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
        private_key: str | None = None,
        chain_id: int | None = None,
        router_address: str | None = None,
        **signer_kwargs: Any,
    ) -> None:
        self._api_url = api_url.rstrip("/")
        if private_key:
            signer_kwargs["key"] = private_key
        self._signer = (
            signer if isinstance(signer, Signer) else create_signer(signer, **signer_kwargs)
        )
        self._private_key = private_key
        self._chain_id = chain_id
        self._router_address = router_address
        self._http = httpx.Client(base_url=self._api_url, timeout=30.0)
        # Extract URL path prefix for auth signing (e.g., "/api/v1" from
        # "http://host:3001/api/v1"). The server verifies the full path.
        from urllib.parse import urlparse

        self._base_path = urlparse(self._api_url).path.rstrip("/")
        self._contracts_cache: dict[str, str] | None = None

    def close(self) -> None:
        """Close the HTTP client."""
        self._http.close()

    def __enter__(self) -> PayClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    # ── Contracts ───────────────────────────────────────────────────

    def _get_contracts(self) -> dict[str, str]:
        """Fetch contract addresses from server (cached per instance)."""
        if self._contracts_cache is None:
            resp = self._http.get("/contracts", timeout=10)
            resp.raise_for_status()
            self._contracts_cache = resp.json()
        return self._contracts_cache  # type: ignore[return-value]

    # ── Permit Signing ─────────────────────────────────────────────

    def _sign_permit(self, flow: str, amount: int) -> dict[str, Any]:
        """Sign an EIP-2612 permit via the server's /permit/prepare endpoint.

        1. POST /permit/prepare { amount, spender } — server returns EIP-712 hash
        2. Sign the hash locally with the agent's key
        3. Return { nonce, deadline, v, r, s }
        """
        contracts = self._get_contracts()
        spender = contracts.get("tab" if flow == "tab" else "direct", "")
        if not spender:
            raise PayServerError(f"Contract address for {flow} not available", status_code=0)

        prep = self._post("/permit/prepare", {"amount": amount, "spender": spender})

        hash_hex: str = prep["hash"]
        hash_clean = hash_hex[2:] if hash_hex.startswith("0x") else hash_hex
        hash_bytes = bytes.fromhex(hash_clean)

        sig_bytes = self._signer.sign(hash_bytes)
        r = "0x" + sig_bytes[:32].hex()
        s = "0x" + sig_bytes[32:64].hex()
        v = sig_bytes[64]

        return {
            "nonce": prep["nonce"],
            "deadline": prep["deadline"],
            "v": v,
            "r": r,
            "s": s,
        }

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
        permit = self._sign_permit("direct", amount)
        data = self._post("/direct", {"to": to, "amount": amount, "memo": memo, "permit": permit})
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
        permit = self._sign_permit("tab", amount)
        data = self._post(
            "/tabs",
            {
                "provider": provider,
                "amount": amount,
                "max_charge_per_call": max_charge_per_call,
                "permit": permit,
            },
        )
        return Tab.model_validate(data)

    def close_tab(self, tab_id: str) -> Tab:
        """Close a tab and distribute funds."""
        data = self._post(f"/tabs/{tab_id}/close", {})
        return Tab.model_validate(data)

    def withdraw_tab(self, tab_id: str) -> Tab:
        """Withdraw accumulated charges from an open tab (provider-only)."""
        data = self._post(f"/tabs/{tab_id}/withdraw", {})
        return Tab.model_validate(data)

    def top_up_tab(self, tab_id: str, amount: int) -> Tab:
        """Add funds to an open tab."""
        _validate_amount(amount, 1, field="amount")
        permit = self._sign_permit("tab", amount)
        data = self._post(f"/tabs/{tab_id}/topup", {"amount": amount, "permit": permit})
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

    _X402_TAB_MULTIPLIER = 10  # Auto-open tab at 10x per-call price
    _X402_TAB_MIN = _TAB_MIN  # $5.00 minimum tab

    def request(
        self,
        url: str,
        method: str = "GET",
        body: Any = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """Make an x402-aware HTTP request.

        If the server returns 402, the SDK handles payment automatically
        using either direct payment or tab-based settlement.
        """
        resp = httpx.request(method, url, json=body, headers=headers or {}, timeout=30.0)
        if resp.status_code != 402:
            return resp

        return self._handle_402(resp, url, method, body, headers or {})

    def _handle_402(
        self,
        resp: httpx.Response,
        url: str,
        method: str,
        body: Any,
        headers: dict[str, str],
    ) -> httpx.Response:
        """Handle a 402 Payment Required response."""
        try:
            requirements = resp.json()
        except Exception as e:
            raise PayServerError(f"Invalid 402 response: {e}", status_code=402) from e

        settlement = requirements.get("settlement", "direct")
        amount = int(requirements.get("amount", 0))
        provider = requirements.get("to", "")

        if settlement == "tab":
            return self._settle_via_tab(requirements, url, method, body, headers, provider, amount)
        return self._settle_via_direct(requirements, url, method, body, headers, provider, amount)

    def _settle_via_direct(
        self,
        requirements: dict[str, Any],
        url: str,
        method: str,
        body: Any,
        headers: dict[str, str],
        provider: str,
        amount: int,
    ) -> httpx.Response:
        """Settle via direct payment: sign permit, pay, retry."""
        result = self.pay_direct(provider, amount)

        payment_headers = {
            **headers,
            "X-Payment-Tx": result.tx_hash or "",
            "X-Payment-Status": result.status,
        }
        return httpx.request(method, url, json=body, headers=payment_headers, timeout=30.0)

    def _settle_via_tab(
        self,
        requirements: dict[str, Any],
        url: str,
        method: str,
        body: Any,
        headers: dict[str, str],
        provider: str,
        amount: int,
    ) -> httpx.Response:
        """Settle via tab: find/open tab, charge, retry."""
        # Look for existing open tab with this provider
        tabs = self.list_tabs()
        tab = next((t for t in tabs if t.provider == provider and t.status == "open"), None)

        if tab is None:
            # Auto-open tab: 10x per-call price, minimum $5
            tab_amount = max(amount * self._X402_TAB_MULTIPLIER, self._X402_TAB_MIN)
            tab = self.open_tab(provider, tab_amount, max_charge_per_call=amount)

        # Charge the tab via server
        charge_data = self._post(f"/tabs/{tab.tab_id}/charge", {"amount": amount})

        payment_headers = {
            **headers,
            "X-Payment-Tab": tab.tab_id,
            "X-Payment-Charge": charge_data.get("charge_id", ""),
        }
        return httpx.request(method, url, json=body, headers=payment_headers, timeout=30.0)

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

    def create_fund_link(
        self, messages: list[Any] | None = None, agent_name: str | None = None
    ) -> str:
        """Create a one-time fund link via the server. Returns the dashboard URL."""
        data = self._post("/links/fund", {"messages": messages or [], "agent_name": agent_name})
        return str(data["url"])

    def create_withdraw_link(
        self, messages: list[Any] | None = None, agent_name: str | None = None
    ) -> str:
        """Create a one-time withdraw link via the server. Returns the dashboard URL."""
        data = self._post("/links/withdraw", {"messages": messages or [], "agent_name": agent_name})
        return str(data["url"])

    # ── Auth headers ────────────────────────────────────────────────

    def _auth_headers(self, method: str, path: str) -> dict[str, str]:
        """Build X-Pay-* auth headers if auth config is available.

        Signs the full URL path the server sees (base_path + relative path).
        """
        if self._private_key and self._chain_id and self._router_address:
            full_path = self._base_path + path
            return build_auth_headers(
                self._private_key, method, full_path, self._chain_id, self._router_address
            )
        return {}

    # ── HTTP helpers ────────────────────────────────────────────────

    def _get(self, path: str, params: dict[str, str] | None = None) -> Any:
        try:
            resp = self._http.get(path, params=params, headers=self._auth_headers("GET", path))
        except httpx.HTTPError as e:
            raise PayNetworkError(str(e)) from e
        return self._handle_response(resp)

    def _post(self, path: str, payload: dict[str, Any]) -> Any:
        try:
            resp = self._http.post(path, json=payload, headers=self._auth_headers("POST", path))
        except httpx.HTTPError as e:
            raise PayNetworkError(str(e)) from e
        return self._handle_response(resp)

    def _delete(self, path: str) -> Any:
        try:
            resp = self._http.delete(path, headers=self._auth_headers("DELETE", path))
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
