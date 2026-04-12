"""Wallet -- the single entry point for the pay SDK.

Zero-config for agents:  Wallet()                       (reads PAYSKILL_KEY env)
Explicit key:            Wallet(private_key="0x...")
OS keychain (CLI key):   Wallet.create()
OWS wallet extension:    Wallet.from_ows(wallet_id="...")
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx
from eth_account import Account

from payskill.auth import build_auth_headers
from payskill.eip3009 import sign_transfer_authorization
from payskill.errors import (
    PayError,
    PayInsufficientFundsError,
    PayNetworkError,
    PayServerError,
    PayValidationError,
)
from payskill.keychain import read_from_keychain

# -- Constants ----------------------------------------------------------------

MAINNET_API_URL = "https://pay-skill.com/api/v1"
TESTNET_API_URL = "https://testnet.pay-skill.com/api/v1"
ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
KEY_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
DIRECT_MIN_MICRO = 1_000_000  # $1.00
TAB_MIN_MICRO = 5_000_000  # $5.00
TAB_MULTIPLIER = 10
DEFAULT_TIMEOUT = 30.0  # seconds

# -- Public types -------------------------------------------------------------

Amount = int | float | dict[str, int]
"""Dollar amount (int or float) or ``{"micro": int}`` for micro-USDC."""


@dataclass
class SendResult:
    tx_hash: str
    status: str
    amount: float
    fee: float


@dataclass
class Tab:
    id: str
    provider: str
    amount: float
    balance_remaining: float
    total_charged: float
    charge_count: int
    max_charge_per_call: float
    total_withdrawn: float
    status: str
    pending_charge_count: int
    pending_charge_total: float
    effective_balance: float


@dataclass
class ChargeResult:
    charge_id: str
    status: str


@dataclass
class Balance:
    total: float
    locked: float
    available: float


@dataclass
class Status:
    address: str
    balance: Balance
    open_tabs: int


@dataclass
class DiscoverService:
    name: str
    description: str
    base_url: str
    category: str
    keywords: list[str]
    routes: list[dict[str, Any]]
    docs_url: str | None = None


@dataclass
class DiscoverOptions:
    sort: str | None = None
    category: str | None = None
    settlement: str | None = None


@dataclass
class WebhookRegistration:
    id: str
    url: str
    events: list[str]


@dataclass
class MintResult:
    tx_hash: str
    amount: float


@dataclass
class _Contracts:
    router: str
    tab: str
    direct: str
    fee: str
    usdc: str
    chain_id: int


@dataclass
class _Permit:
    nonce: str
    deadline: int
    v: int
    r: str
    s: str


@dataclass
class _OwsInit:
    """Internal sentinel for OWS construction."""

    address: str
    sign_typed_data: Any
    testnet: bool
    timeout: float


# -- Helpers ------------------------------------------------------------------


def _normalize_key(key: str) -> str:
    clean = key if key.startswith("0x") else "0x" + key
    if not KEY_RE.match(clean):
        raise PayValidationError("Invalid private key: must be 32 bytes hex", "privateKey")
    return clean


def _validate_address(address: str) -> None:
    if not ADDRESS_RE.match(address):
        raise PayValidationError(f"Invalid Ethereum address: {address}", "address")


def _to_micro(amount: Amount) -> int:
    if isinstance(amount, dict):
        micro = amount.get("micro", 0)
        if not isinstance(micro, int) or micro < 0:
            raise PayValidationError("Micro amount must be a non-negative integer", "amount")
        return micro
    if not isinstance(amount, (int, float)):
        raise PayValidationError("Amount must be a number or {'micro': int}", "amount")
    if not math.isfinite(amount) or amount < 0:
        raise PayValidationError("Amount must be a positive finite number", "amount")
    return round(amount * 1_000_000)


def _to_dollars(micro: int | float) -> float:
    return micro / 1_000_000


def _parse_tab(raw: dict[str, Any]) -> Tab:
    return Tab(
        id=raw.get("tab_id", ""),
        provider=raw.get("provider", ""),
        amount=_to_dollars(raw.get("amount", 0)),
        balance_remaining=_to_dollars(raw.get("balance_remaining", 0)),
        total_charged=_to_dollars(raw.get("total_charged", 0)),
        charge_count=raw.get("charge_count", 0),
        max_charge_per_call=_to_dollars(raw.get("max_charge_per_call", 0)),
        total_withdrawn=_to_dollars(raw.get("total_withdrawn", 0)),
        status=raw.get("status", "open"),
        pending_charge_count=raw.get("pending_charge_count", 0),
        pending_charge_total=_to_dollars(raw.get("pending_charge_total", 0)),
        effective_balance=_to_dollars(raw.get("effective_balance", 0)),
    )


def _parse_sig(signature: str) -> dict[str, Any]:
    sig = signature[2:] if signature.startswith("0x") else signature
    return {
        "v": int(sig[128:130], 16),
        "r": "0x" + sig[:64],
        "s": "0x" + sig[64:128],
    }


def _resolve_api_url(testnet: bool) -> str:
    override = os.environ.get("PAYSKILL_API_URL")
    if override:
        return override
    return TESTNET_API_URL if testnet else MAINNET_API_URL


def _extract_402(obj: dict[str, Any]) -> dict[str, Any]:
    accepts = obj.get("accepts")
    if isinstance(accepts, list) and len(accepts) > 0:
        offer = accepts[0]
        extra = offer.get("extra", {})
        return {
            "settlement": str(extra.get("settlement", "direct")),
            "amount": int(offer.get("amount", 0)),
            "to": str(offer.get("payTo", "")),
            "accepted": offer,
        }
    return {
        "settlement": str(obj.get("settlement", "direct")),
        "amount": int(obj.get("amount", 0)),
        "to": str(obj.get("to", "")),
    }


# -- Standalone discover (no wallet needed) -----------------------------------


def discover(
    query: str | None = None,
    *,
    sort: str | None = None,
    category: str | None = None,
    settlement: str | None = None,
    testnet: bool | None = None,
) -> list[DiscoverService]:
    """Search for available services. No wallet required."""
    is_testnet = testnet if testnet is not None else bool(os.environ.get("PAYSKILL_TESTNET"))
    api_url = _resolve_api_url(is_testnet)
    return _discover_impl(api_url, DEFAULT_TIMEOUT, query, sort, category, settlement)


def _discover_impl(
    api_url: str,
    timeout: float,
    query: str | None = None,
    sort: str | None = None,
    category: str | None = None,
    settlement: str | None = None,
) -> list[DiscoverService]:
    params: dict[str, str] = {}
    if query:
        params["q"] = query
    if sort:
        params["sort"] = sort
    if category:
        params["category"] = category
    if settlement:
        params["settlement"] = settlement
    try:
        resp = httpx.get(f"{api_url}/discover", params=params, timeout=timeout)
    except httpx.HTTPError as e:
        raise PayNetworkError(f"Failed to reach server: {e}") from e
    if resp.status_code >= 400:
        raise PayServerError(f"discover failed: {resp.status_code}", resp.status_code)
    data = resp.json()
    services = data.get("services", [])
    return [
        DiscoverService(
            name=s.get("name", ""),
            description=s.get("description", ""),
            base_url=s.get("base_url", s.get("baseUrl", "")),
            category=s.get("category", ""),
            keywords=s.get("keywords", []),
            routes=s.get("routes", []),
            docs_url=s.get("docs_url", s.get("docsUrl")),
        )
        for s in services
    ]


# -- Wallet -------------------------------------------------------------------


class Wallet:
    """Single entry point for the pay SDK.

    Zero-config:       ``Wallet()``  (reads PAYSKILL_KEY env var)
    Explicit key:      ``Wallet(private_key="0x...")``
    OS keychain:       ``Wallet.create()``
    OWS extension:     ``Wallet.from_ows(wallet_id="...")``
    """

    def __init__(
        self,
        *,
        private_key: str | None = None,
        testnet: bool | None = None,
        timeout: float | None = None,
        _ows_init: _OwsInit | None = None,
    ) -> None:
        if _ows_init is not None:
            self.address: str = _ows_init.address
            self._sign_typed_data = _ows_init.sign_typed_data
            self._raw_key: str | None = None
            self._testnet = _ows_init.testnet
            self._timeout = _ows_init.timeout
            self._api_url = _resolve_api_url(self._testnet)
            self._contracts: _Contracts | None = None
            self._client = httpx.Client(timeout=self._timeout)
            return

        key = private_key or os.environ.get("PAYSKILL_KEY")
        if not key:
            raise PayError(
                "No private key found. Provide private_key=, set PAYSKILL_KEY env var, "
                "or use Wallet.create() to read from OS keychain."
            )
        self._raw_key = _normalize_key(key)
        account = Account.from_key(self._raw_key)
        self.address = account.address
        self._sign_typed_data = None
        self._testnet = testnet if testnet is not None else bool(os.environ.get("PAYSKILL_TESTNET"))
        self._timeout = timeout if timeout is not None else DEFAULT_TIMEOUT
        self._api_url = _resolve_api_url(self._testnet)
        self._contracts = None
        self._client = httpx.Client(timeout=self._timeout)

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> Wallet:
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    @classmethod
    def create(
        cls,
        *,
        private_key: str | None = None,
        testnet: bool | None = None,
        timeout: float | None = None,
    ) -> Wallet:
        """Factory. Resolves key from: arg -> OS keychain -> PAYSKILL_KEY env -> error."""
        if private_key:
            return cls(private_key=private_key, testnet=testnet, timeout=timeout)
        keychain_key = read_from_keychain()
        if keychain_key:
            return cls(private_key=keychain_key, testnet=testnet, timeout=timeout)
        return cls(testnet=testnet, timeout=timeout)

    @classmethod
    def from_env(cls, *, testnet: bool | None = None) -> Wallet:
        """Factory. Reads key from PAYSKILL_KEY env var only."""
        key = os.environ.get("PAYSKILL_KEY")
        if not key:
            raise PayError("PAYSKILL_KEY env var not set")
        return cls(private_key=key, testnet=testnet)

    @classmethod
    def from_ows(
        cls,
        wallet_id: str,
        *,
        ows_api_key: str | None = None,
        testnet: bool | None = None,
        timeout: float | None = None,
        _ows_module: Any = None,
    ) -> Wallet:
        """Factory. Creates a wallet backed by an OWS (Open Wallet Standard) wallet."""
        if _ows_module is not None:
            ows = _ows_module
        else:
            try:
                import ows  # type: ignore[import-untyped]
            except ImportError:
                raise PayError(
                    "open-wallet-standard is not installed. "
                    "Install it with: pip install open-wallet-standard"
                ) from None

        wallet_info = ows.get_wallet(wallet_id)
        accounts: list[dict[str, str]] = wallet_info.get("accounts", [])
        evm_account = next(
            (
                a
                for a in accounts
                if a.get("chain_id") == "evm" or a.get("chain_id", "").startswith("eip155:")
            ),
            None,
        )
        if evm_account is None:
            chains = ", ".join(a.get("chain_id", "?") for a in accounts) or "none"
            raise PayError(
                f"No EVM account found in OWS wallet '{wallet_id}'. Available chains: {chains}."
            )

        def sign_typed_data(
            domain: dict[str, Any],
            types: dict[str, Any],
            primary_type: str,
            message: dict[str, Any],
        ) -> str:
            domain_type: list[dict[str, str]] = []
            if "name" in domain:
                domain_type.append({"name": "name", "type": "string"})
            if "version" in domain:
                domain_type.append({"name": "version", "type": "string"})
            if "chainId" in domain:
                domain_type.append({"name": "chainId", "type": "uint256"})
            if "verifyingContract" in domain:
                domain_type.append({"name": "verifyingContract", "type": "address"})

            full_typed_data = {
                "types": {"EIP712Domain": domain_type, **types},
                "primaryType": primary_type,
                "domain": domain,
                "message": message,
            }
            typed_data_json = json.dumps(full_typed_data, default=str)
            result = ows.sign_typed_data(wallet_id, "evm", typed_data_json, ows_api_key)
            sig: str = result["signature"]
            if sig.startswith("0x"):
                sig = sig[2:]
            if len(sig) == 130:
                return f"0x{sig}"
            recovery_id: int = result.get("recovery_id") or 0
            v = recovery_id + 27
            return f"0x{sig}{v:02x}"

        is_testnet = testnet if testnet is not None else bool(os.environ.get("PAYSKILL_TESTNET"))
        return cls(
            _ows_init=_OwsInit(
                address=evm_account["address"],
                sign_typed_data=sign_typed_data,
                testnet=is_testnet,
                timeout=timeout if timeout is not None else DEFAULT_TIMEOUT,
            ),
        )

    # -- Internal: contracts --------------------------------------------------

    def _ensure_contracts(self) -> _Contracts:
        if self._contracts is not None:
            return self._contracts
        try:
            resp = self._client.get(f"{self._api_url}/contracts")
        except httpx.HTTPError as e:
            raise PayNetworkError(f"Failed to reach server: {e}") from e
        if resp.status_code >= 400:
            raise PayNetworkError(f"Failed to fetch contracts: {resp.status_code}")
        data = resp.json()
        self._contracts = _Contracts(
            router=str(data.get("router", "")),
            tab=str(data.get("tab", "")),
            direct=str(data.get("direct", "")),
            fee=str(data.get("fee", "")),
            usdc=str(data.get("usdc", "")),
            chain_id=int(data.get("chain_id", 0)),
        )
        return self._contracts

    # -- Internal: HTTP -------------------------------------------------------

    def _auth_fetch(
        self,
        path: str,
        method: str = "GET",
        body: Any = None,
    ) -> httpx.Response:
        contracts = self._ensure_contracts()
        method = method.upper()
        path_only = path.split("?")[0]

        try:
            base_path = httpx.URL(self._api_url).raw_path.decode().rstrip("/")
        except Exception:
            base_path = ""
        sign_path = base_path + path_only

        if self._raw_key:
            headers = build_auth_headers(
                self._raw_key, method, sign_path, contracts.chain_id, contracts.router
            )
        else:
            raise PayError("OWS auth headers not yet supported for HTTP calls")

        request_headers = {"Content-Type": "application/json", **headers}
        url = f"{self._api_url}{path}"
        kwargs: dict[str, Any] = {"headers": request_headers}
        if body is not None:
            kwargs["content"] = json.dumps(body).encode()

        try:
            return self._client.request(method, url, **kwargs)
        except httpx.HTTPError as e:
            raise PayNetworkError(str(e)) from e

    def _get(self, path: str) -> Any:
        try:
            resp = self._auth_fetch(path)
        except PayError:
            raise
        except Exception as e:
            raise PayNetworkError(str(e)) from e
        return self._handle_response(resp)

    def _post(self, path: str, body: Any) -> Any:
        try:
            resp = self._auth_fetch(path, method="POST", body=body)
        except PayError:
            raise
        except Exception as e:
            raise PayNetworkError(str(e)) from e
        return self._handle_response(resp)

    def _del(self, path: str) -> None:
        try:
            resp = self._auth_fetch(path, method="DELETE")
        except PayError:
            raise
        except Exception as e:
            raise PayNetworkError(str(e)) from e
        if resp.status_code >= 400:
            raise PayServerError(resp.text, resp.status_code)

    def _handle_response(self, resp: httpx.Response) -> Any:
        if resp.status_code >= 400:
            try:
                body = resp.json()
                msg = body.get("error", f"Server error: {resp.status_code}")
                code = body.get("code", "")
                if code == "insufficient_funds" or "insufficient" in msg.lower():
                    raise PayInsufficientFundsError(msg)
            except PayInsufficientFundsError:
                raise
            except Exception:
                msg = f"Server error: {resp.status_code}"
            raise PayServerError(msg, resp.status_code)
        if resp.status_code == 204:
            return None
        return resp.json()

    # -- Internal: permits ----------------------------------------------------

    def _sign_permit(self, flow: str, micro_amount: int) -> _Permit:
        contracts = self._ensure_contracts()
        spender = contracts.tab if flow == "tab" else contracts.direct
        prep = self._post("/permit/prepare", {"amount": micro_amount, "spender": spender})

        if self._raw_key:
            account = Account.from_key(self._raw_key)
            sig_obj = account.unsafe_sign_hash(bytes.fromhex(prep["hash"][2:]))
            return _Permit(
                nonce=prep["nonce"],
                deadline=prep["deadline"],
                v=sig_obj.v,
                r=hex(sig_obj.r),
                s=hex(sig_obj.s),
            )

        # OWS path: sign full EIP-2612 permit typed data
        if self._sign_typed_data is None:
            raise PayError("No signing method available")
        signature = self._sign_typed_data(
            domain={
                "name": "USD Coin",
                "version": "2",
                "chainId": contracts.chain_id,
                "verifyingContract": contracts.usdc,
            },
            types={
                "Permit": [
                    {"name": "owner", "type": "address"},
                    {"name": "spender", "type": "address"},
                    {"name": "value", "type": "uint256"},
                    {"name": "nonce", "type": "uint256"},
                    {"name": "deadline", "type": "uint256"},
                ],
            },
            primary_type="Permit",
            message={
                "owner": self.address,
                "spender": spender,
                "value": str(micro_amount),
                "nonce": prep["nonce"],
                "deadline": str(prep["deadline"]),
            },
        )
        parts = _parse_sig(signature)
        return _Permit(
            nonce=prep["nonce"],
            deadline=prep["deadline"],
            v=parts["v"],
            r=parts["r"],
            s=parts["s"],
        )

    # -- Internal: x402 -------------------------------------------------------

    def _parse_402(self, resp: httpx.Response) -> dict[str, Any]:
        pr_header = resp.headers.get("payment-required")
        if pr_header:
            try:
                decoded = json.loads(base64.b64decode(pr_header))
                return _extract_402(decoded)
            except Exception:  # noqa: S110
                pass
        body = resp.json()
        return _extract_402(body.get("requirements", body))

    def _handle_402(
        self,
        resp: httpx.Response,
        url: str,
        method: str,
        body: str | None,
        headers: dict[str, str],
    ) -> httpx.Response:
        reqs = self._parse_402(resp)
        if reqs["settlement"] == "tab":
            return self._settle_via_tab(url, method, body, headers, reqs)
        return self._settle_via_direct(url, method, body, headers, reqs)

    def _settle_via_direct(
        self,
        url: str,
        method: str,
        body: str | None,
        headers: dict[str, str],
        reqs: dict[str, Any],
    ) -> httpx.Response:
        if not self._raw_key:
            raise PayError(
                "x402 direct settlement requires a private key. "
                "OWS wallets only support tab settlement. "
                "Ask the provider to enable tab settlement, or use a private key wallet."
            )
        contracts = self._ensure_contracts()
        auth = sign_transfer_authorization(
            self._raw_key,
            reqs["to"],
            reqs["amount"],
            contracts.chain_id,
            contracts.usdc,
        )
        payment_payload = {
            "x402Version": 2,
            "accepted": reqs.get(
                "accepted",
                {
                    "scheme": "exact",
                    "network": f"eip155:{contracts.chain_id}",
                    "amount": str(reqs["amount"]),
                    "payTo": reqs["to"],
                },
            ),
            "payload": {
                "signature": auth["signature"],
                "authorization": {
                    "from": auth["from"],
                    "to": auth["to"],
                    "value": str(reqs["amount"]),
                    "validAfter": "0",
                    "validBefore": "0",
                    "nonce": auth["nonce"],
                },
            },
            "extensions": {},
        }
        payment_header = base64.b64encode(json.dumps(payment_payload).encode()).decode()
        return self._client.request(
            method,
            url,
            content=body.encode() if body else None,
            headers={
                **headers,
                "Content-Type": "application/json",
                "PAYMENT-SIGNATURE": payment_header,
            },
        )

    def _settle_via_tab(
        self,
        url: str,
        method: str,
        body: str | None,
        headers: dict[str, str],
        reqs: dict[str, Any],
    ) -> httpx.Response:
        contracts = self._ensure_contracts()
        raw_tabs: list[dict[str, Any]] = self._get("/tabs")
        tab = next(
            (t for t in raw_tabs if t.get("provider") == reqs["to"] and t.get("status") == "open"),
            None,
        )

        if tab is None:
            tab_micro = max(reqs["amount"] * TAB_MULTIPLIER, TAB_MIN_MICRO)
            bal = self.balance()
            tab_dollars = _to_dollars(tab_micro)
            if bal.available < tab_dollars:
                raise PayInsufficientFundsError(
                    f"Insufficient balance for tab: have ${bal.available:.2f}, "
                    f"need ${tab_dollars:.2f}",
                    bal.available,
                    tab_dollars,
                )
            permit = self._sign_permit("tab", tab_micro)
            tab = self._post(
                "/tabs",
                {
                    "provider": reqs["to"],
                    "amount": tab_micro,
                    "max_charge_per_call": reqs["amount"],
                    "permit": {
                        "nonce": permit.nonce,
                        "deadline": permit.deadline,
                        "v": permit.v,
                        "r": permit.r,
                        "s": permit.s,
                    },
                },
            )

        tab_id = tab.get("tab_id", tab.get("id", ""))
        charge = self._post(f"/tabs/{tab_id}/charge", {"amount": reqs["amount"]})

        payment_payload = {
            "x402Version": 2,
            "accepted": reqs.get(
                "accepted",
                {
                    "scheme": "exact",
                    "network": f"eip155:{contracts.chain_id}",
                    "amount": str(reqs["amount"]),
                    "payTo": reqs["to"],
                },
            ),
            "payload": {
                "authorization": {"from": self.address},
            },
            "extensions": {
                "pay": {
                    "settlement": "tab",
                    "tabId": tab_id,
                    "chargeId": charge.get("charge_id", ""),
                },
            },
        }
        payment_header = base64.b64encode(json.dumps(payment_payload).encode()).decode()
        return self._client.request(
            method,
            url,
            content=body.encode() if body else None,
            headers={
                **headers,
                "Content-Type": "application/json",
                "PAYMENT-SIGNATURE": payment_header,
            },
        )

    # -- Public: Direct Payment -----------------------------------------------

    def send(self, to: str, amount: Amount, memo: str | None = None) -> SendResult:
        """Send a direct USDC payment."""
        _validate_address(to)
        micro = _to_micro(amount)
        if micro < DIRECT_MIN_MICRO:
            raise PayValidationError("Amount below minimum ($1.00)", "amount")
        permit = self._sign_permit("direct", micro)
        raw = self._post(
            "/direct",
            {
                "to": to,
                "amount": micro,
                "memo": memo or "",
                "permit": {
                    "nonce": permit.nonce,
                    "deadline": permit.deadline,
                    "v": permit.v,
                    "r": permit.r,
                    "s": permit.s,
                },
            },
        )
        return SendResult(
            tx_hash=raw.get("tx_hash", ""),
            status=raw.get("status", ""),
            amount=_to_dollars(raw.get("amount", 0)),
            fee=_to_dollars(raw.get("fee", 0)),
        )

    # -- Public: Tabs ---------------------------------------------------------

    def open_tab(self, provider: str, amount: Amount, max_charge_per_call: Amount) -> Tab:
        """Open a pre-funded tab with a provider."""
        _validate_address(provider)
        micro_amount = _to_micro(amount)
        micro_max = _to_micro(max_charge_per_call)
        if micro_amount < TAB_MIN_MICRO:
            raise PayValidationError("Tab amount below minimum ($5.00)", "amount")
        if micro_max <= 0:
            raise PayValidationError("max_charge_per_call must be positive", "maxChargePerCall")
        permit = self._sign_permit("tab", micro_amount)
        raw = self._post(
            "/tabs",
            {
                "provider": provider,
                "amount": micro_amount,
                "max_charge_per_call": micro_max,
                "permit": {
                    "nonce": permit.nonce,
                    "deadline": permit.deadline,
                    "v": permit.v,
                    "r": permit.r,
                    "s": permit.s,
                },
            },
        )
        return _parse_tab(raw)

    def close_tab(self, tab_id: str) -> Tab:
        """Close an open tab."""
        raw = self._post(f"/tabs/{tab_id}/close", {})
        return _parse_tab(raw)

    def top_up_tab(self, tab_id: str, amount: Amount) -> Tab:
        """Add funds to an existing tab."""
        micro = _to_micro(amount)
        if micro <= 0:
            raise PayValidationError("Amount must be positive", "amount")
        permit = self._sign_permit("tab", micro)
        raw = self._post(
            f"/tabs/{tab_id}/topup",
            {
                "amount": micro,
                "permit": {
                    "nonce": permit.nonce,
                    "deadline": permit.deadline,
                    "v": permit.v,
                    "r": permit.r,
                    "s": permit.s,
                },
            },
        )
        return _parse_tab(raw)

    def list_tabs(self) -> list[Tab]:
        """List all tabs for this wallet."""
        raw = self._get("/tabs")
        return [_parse_tab(t) for t in raw]

    def get_tab(self, tab_id: str) -> Tab:
        """Get a single tab by ID."""
        raw = self._get(f"/tabs/{tab_id}")
        return _parse_tab(raw)

    def charge_tab(self, tab_id: str, amount: Amount) -> ChargeResult:
        """Record a charge against a tab."""
        micro = _to_micro(amount)
        raw = self._post(f"/tabs/{tab_id}/charge", {"amount": micro})
        return ChargeResult(
            charge_id=raw.get("charge_id", ""),
            status=raw.get("status", ""),
        )

    # -- Public: x402 ---------------------------------------------------------

    def request(
        self,
        url: str,
        *,
        method: str | None = None,
        body: Any = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """Make an HTTP request. Automatically handles 402 payment responses."""
        req_method = method or "GET"
        req_headers = headers or {}
        body_str = json.dumps(body) if body is not None else None
        try:
            resp = self._client.request(
                req_method,
                url,
                content=body_str.encode() if body_str else None,
                headers=req_headers,
            )
        except httpx.HTTPError as e:
            raise PayNetworkError(str(e)) from e
        if resp.status_code != 402:
            return resp
        return self._handle_402(resp, url, req_method, body_str, req_headers)

    # -- Public: Wallet -------------------------------------------------------

    def balance(self) -> Balance:
        """Get wallet balance in dollars."""
        raw = self._get("/status")
        balance_usdc = raw.get("balance_usdc")
        total = float(balance_usdc) / 1_000_000 if balance_usdc else 0.0
        locked = (raw.get("total_locked", 0) or 0) / 1_000_000
        return Balance(total=total, locked=locked, available=total - locked)

    def status(self) -> Status:
        """Get full wallet status."""
        raw = self._get("/status")
        balance_usdc = raw.get("balance_usdc")
        total = float(balance_usdc) / 1_000_000 if balance_usdc else 0.0
        locked = (raw.get("total_locked", 0) or 0) / 1_000_000
        return Status(
            address=raw.get("wallet", ""),
            balance=Balance(total=total, locked=locked, available=total - locked),
            open_tabs=raw.get("open_tabs", 0),
        )

    # -- Public: Discovery ----------------------------------------------------

    def discover(
        self,
        query: str | None = None,
        *,
        sort: str | None = None,
        category: str | None = None,
        settlement: str | None = None,
    ) -> list[DiscoverService]:
        """Search for available services."""
        return _discover_impl(self._api_url, self._timeout, query, sort, category, settlement)

    # -- Public: Funding ------------------------------------------------------

    def create_fund_link(
        self,
        *,
        message: str | None = None,
        agent_name: str | None = None,
    ) -> str:
        """Create a funding link for depositing USDC."""
        data = self._post(
            "/links/fund",
            {
                "messages": [{"text": message}] if message else [],
                "agent_name": agent_name,
            },
        )
        return data["url"]

    def create_withdraw_link(
        self,
        *,
        message: str | None = None,
        agent_name: str | None = None,
    ) -> str:
        """Create a withdrawal link for withdrawing USDC."""
        data = self._post(
            "/links/withdraw",
            {
                "messages": [{"text": message}] if message else [],
                "agent_name": agent_name,
            },
        )
        return data["url"]

    # -- Public: Webhooks -----------------------------------------------------

    def register_webhook(
        self,
        url: str,
        events: list[str] | None = None,
        secret: str | None = None,
    ) -> WebhookRegistration:
        """Register a webhook for events."""
        payload: dict[str, Any] = {"url": url}
        if events is not None:
            payload["events"] = events
        if secret is not None:
            payload["secret"] = secret
        raw = self._post("/webhooks", payload)
        return WebhookRegistration(id=raw["id"], url=raw["url"], events=raw["events"])

    def list_webhooks(self) -> list[WebhookRegistration]:
        """List all registered webhooks."""
        raw = self._get("/webhooks")
        return [WebhookRegistration(id=w["id"], url=w["url"], events=w["events"]) for w in raw]

    def delete_webhook(self, webhook_id: str) -> None:
        """Delete a webhook by ID."""
        self._del(f"/webhooks/{webhook_id}")

    # -- Public: Testnet ------------------------------------------------------

    def mint(self, amount: Amount) -> MintResult:
        """Mint testnet USDC. Only available on testnet."""
        if not self._testnet:
            raise PayError("mint is only available on testnet")
        micro = _to_micro(amount)
        raw = self._post("/mint", {"amount": micro})
        return MintResult(
            tx_hash=raw.get("tx_hash", ""),
            amount=_to_dollars(raw.get("amount", 0)),
        )
