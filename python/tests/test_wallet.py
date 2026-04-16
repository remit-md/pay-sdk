"""Unit tests for Wallet class."""

from __future__ import annotations

import os
from unittest.mock import patch

import httpx
import pytest

from payskill import (
    Balance,
    ChargeResult,
    MintResult,
    PayError,
    PayInsufficientFundsError,
    PayServerError,
    PayValidationError,
    SendResult,
    Status,
    Tab,
    Wallet,
    WebhookRegistration,
)

# Test key (not real, deterministic for tests)
TEST_KEY = "0x" + "ab" * 32
TEST_ADDRESS = "0xb7A5bd0345EF1Cc5E66bf61BdeC17D2461fBd968"  # derived from TEST_KEY

# Mock contracts response
CONTRACTS_RESPONSE = {
    "router": "0x1111111111111111111111111111111111111111",
    "tab": "0x2222222222222222222222222222222222222222",
    "direct": "0x3333333333333333333333333333333333333333",
    "fee": "0x4444444444444444444444444444444444444444",
    "usdc": "0x5555555555555555555555555555555555555555",
    "relayer": "0x6666666666666666666666666666666666666666",
    "chain_id": 84532,
}

PERMIT_PREPARE_RESPONSE = {
    "hash": "0x" + "aa" * 32,
    "nonce": "1",
    "deadline": 9999999999,
}


@pytest.fixture
def wallet():
    """Create a testnet wallet with explicit key."""
    w = Wallet(private_key=TEST_KEY, testnet=True)
    yield w
    w.close()


def mock_transport(responses: list[tuple[int, dict | list | str]]):
    """Create an httpx mock transport that returns responses in order."""
    call_count = [0]

    def handler(request: httpx.Request) -> httpx.Response:
        idx = min(call_count[0], len(responses) - 1)
        call_count[0] += 1
        status, body = responses[idx]
        if isinstance(body, str):
            return httpx.Response(status, text=body)
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handler)


class TestWalletConstruction:
    def test_no_key_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            env = os.environ.copy()
            env.pop("PAYSKILL_KEY", None)
            with patch.dict(os.environ, env, clear=True):
                with pytest.raises(PayError, match="No private key found"):
                    Wallet()

    def test_explicit_key(self):
        w = Wallet(private_key=TEST_KEY, testnet=True)
        assert w.address.startswith("0x")
        assert len(w.address) == 42
        w.close()

    def test_env_key(self):
        with patch.dict(os.environ, {"PAYSKILL_KEY": TEST_KEY}):
            w = Wallet(testnet=True)
            assert w.address.startswith("0x")
            w.close()

    def test_invalid_key(self):
        with pytest.raises(PayValidationError, match="Invalid private key"):
            Wallet(private_key="0xnotavalidkey", testnet=True)

    def test_from_env_no_key(self):
        with patch.dict(os.environ, {}, clear=True):
            env = os.environ.copy()
            env.pop("PAYSKILL_KEY", None)
            with patch.dict(os.environ, env, clear=True):
                with pytest.raises(PayError, match="PAYSKILL_KEY env var not set"):
                    Wallet.from_env()

    def test_from_env_with_key(self):
        with patch.dict(os.environ, {"PAYSKILL_KEY": TEST_KEY}):
            w = Wallet.from_env(testnet=True)
            assert w.address.startswith("0x")
            w.close()

    def test_create_with_keychain(self):
        with patch("payskill.wallet.read_from_keychain", return_value=TEST_KEY):
            w = Wallet.create(testnet=True)
            assert w.address.startswith("0x")
            w.close()

    def test_create_falls_back_to_env(self):
        with patch("payskill.wallet.read_from_keychain", return_value=None):
            with patch.dict(os.environ, {"PAYSKILL_KEY": TEST_KEY}):
                w = Wallet.create(testnet=True)
                assert w.address.startswith("0x")
                w.close()

    def test_context_manager(self):
        with Wallet(private_key=TEST_KEY, testnet=True) as w:
            assert w.address.startswith("0x")

    def test_testnet_from_env(self):
        with patch.dict(os.environ, {"PAYSKILL_KEY": TEST_KEY, "PAYSKILL_TESTNET": "1"}):
            w = Wallet()
            assert w._testnet is True
            w.close()


class TestAmountConversion:
    def test_dollar_to_micro(self):
        from payskill.wallet import _to_micro

        assert _to_micro(1.0) == 1_000_000
        assert _to_micro(5) == 5_000_000
        assert _to_micro(0.01) == 10_000
        assert _to_micro(100) == 100_000_000

    def test_micro_dict(self):
        from payskill.wallet import _to_micro

        assert _to_micro({"micro": 5_000_000}) == 5_000_000
        assert _to_micro({"micro": 0}) == 0

    def test_negative_raises(self):
        from payskill.wallet import _to_micro

        with pytest.raises(PayValidationError, match="positive"):
            _to_micro(-1.0)

    def test_nan_raises(self):
        from payskill.wallet import _to_micro

        with pytest.raises(PayValidationError, match="positive finite"):
            _to_micro(float("nan"))

    def test_inf_raises(self):
        from payskill.wallet import _to_micro

        with pytest.raises(PayValidationError, match="positive finite"):
            _to_micro(float("inf"))

    def test_negative_micro_raises(self):
        from payskill.wallet import _to_micro

        with pytest.raises(PayValidationError, match="non-negative"):
            _to_micro({"micro": -1})


class TestAddressValidation:
    def test_valid(self):
        from payskill.wallet import _validate_address

        _validate_address("0x" + "a" * 40)  # should not raise

    def test_too_short(self):
        from payskill.wallet import _validate_address

        with pytest.raises(PayValidationError, match="Invalid Ethereum address"):
            _validate_address("0x123")

    def test_no_prefix(self):
        from payskill.wallet import _validate_address

        with pytest.raises(PayValidationError, match="Invalid Ethereum address"):
            _validate_address("a" * 40)


class TestSend:
    def test_below_minimum(self, wallet):
        with pytest.raises(PayValidationError, match="below minimum"):
            wallet.send("0x" + "a" * 40, 0.50)

    def test_invalid_address(self, wallet):
        with pytest.raises(PayValidationError, match="Invalid Ethereum address"):
            wallet.send("bad_address", 5.0)

    def test_success(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (200, {"hash": "0x" + "cc" * 32, "nonce": "1", "deadline": 9999999}),
                (
                    200,
                    {
                        "tx_hash": "0x" + "dd" * 32,
                        "status": "confirmed",
                        "amount": 5_000_000,
                        "fee": 50_000,
                    },
                ),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.send("0x" + "a" * 40, 5.0)
        assert isinstance(result, SendResult)
        assert result.amount == 5.0
        assert result.fee == 0.05


class TestTabs:
    def test_open_below_minimum(self, wallet):
        with pytest.raises(PayValidationError, match="below minimum"):
            wallet.open_tab("0x" + "a" * 40, 3.0, 0.10)

    def test_open_invalid_provider(self, wallet):
        with pytest.raises(PayValidationError, match="Invalid Ethereum address"):
            wallet.open_tab("bad", 10.0, 0.10)

    def test_open_success(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (200, {"hash": "0x" + "cc" * 32, "nonce": "1", "deadline": 9999999}),
                (
                    200,
                    {
                        "tab_id": "tab-123",
                        "provider": "0x" + "a" * 40,
                        "amount": 10_000_000,
                        "balance_remaining": 9_900_000,
                        "total_charged": 0,
                        "charge_count": 0,
                        "max_charge_per_call": 100_000,
                        "total_withdrawn": 0,
                        "status": "open",
                        "pending_charge_count": 0,
                        "pending_charge_total": 0,
                        "effective_balance": 9_900_000,
                    },
                ),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.open_tab("0x" + "a" * 40, 10.0, 0.10)
        assert isinstance(result, Tab)
        assert result.id == "tab-123"
        assert result.amount == 10.0

    def test_list(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (
                    200,
                    [
                        {
                            "tab_id": "tab-1",
                            "provider": "0x" + "a" * 40,
                            "amount": 10_000_000,
                            "balance_remaining": 9_000_000,
                            "total_charged": 1_000_000,
                            "charge_count": 5,
                            "max_charge_per_call": 200_000,
                            "total_withdrawn": 0,
                            "status": "open",
                            "pending_charge_count": 0,
                            "pending_charge_total": 0,
                            "effective_balance": 9_000_000,
                        }
                    ],
                ),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.list_tabs()
        assert len(result) == 1
        assert result[0].id == "tab-1"
        assert result[0].charge_count == 5

    def test_charge(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (200, {"charge_id": "chg-1", "status": "buffered"}),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.charge_tab("tab-1", 0.05)
        assert isinstance(result, ChargeResult)
        assert result.charge_id == "chg-1"


class TestBalance:
    def test_balance(self, wallet):
        # balance_usdc is a dollar-formatted string (server format
        # "{whole}.{frac:02}"), total_locked is micro-USDC as integer.
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (
                    200,
                    {
                        "wallet": wallet.address,
                        "balance_usdc": "50.00",
                        "total_locked": 10_000_000,
                        "open_tabs": 2,
                    },
                ),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.balance()
        assert isinstance(result, Balance)
        assert result.total == 50.0
        assert result.locked == 10.0
        assert result.available == 40.0

    def test_status(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (
                    200,
                    {
                        "wallet": wallet.address,
                        "balance_usdc": "50.00",
                        "total_locked": 10_000_000,
                        "open_tabs": 2,
                    },
                ),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.status()
        assert isinstance(result, Status)
        assert result.open_tabs == 2
        assert result.balance.available == 40.0


class TestWebhooks:
    def test_register(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (
                    200,
                    {
                        "id": "wh-1",
                        "url": "https://example.com/hook",
                        "events": ["payment.completed"],
                    },
                ),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.register_webhook("https://example.com/hook", events=["payment.completed"])
        assert isinstance(result, WebhookRegistration)
        assert result.id == "wh-1"

    def test_list(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (
                    200,
                    [
                        {
                            "id": "wh-1",
                            "url": "https://example.com/hook",
                            "events": ["payment.completed"],
                        }
                    ],
                ),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.list_webhooks()
        assert len(result) == 1

    def test_delete(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (204, ""),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        wallet.delete_webhook("wh-1")  # should not raise


class TestFunding:
    def test_create_fund_link(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (200, PERMIT_PREPARE_RESPONSE),
                (200, {}),
                (200, {"url": "https://pay-skill.com/fund/abc123"}),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.create_fund_link(message="Need funds")
        assert result == "https://pay-skill.com/fund/abc123"

    def test_create_withdraw_link(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (200, PERMIT_PREPARE_RESPONSE),
                (200, {}),
                (200, {"url": "https://pay-skill.com/withdraw/abc123"}),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.create_withdraw_link()
        assert result == "https://pay-skill.com/withdraw/abc123"


class TestMint:
    def test_mint_testnet(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (200, {"tx_hash": "0x" + "ee" * 32, "amount": 100}),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        result = wallet.mint(100)
        assert isinstance(result, MintResult)
        assert result.amount == 100

    def test_mint_mainnet_raises(self):
        w = Wallet(private_key=TEST_KEY, testnet=False)
        with pytest.raises(PayError, match="only available on testnet"):
            w.mint(100)
        w.close()


class TestErrorHandling:
    def test_server_error(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (500, {"error": "Internal server error"}),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        with pytest.raises(PayServerError) as exc_info:
            wallet.balance()
        assert exc_info.value.status_code == 500

    def test_insufficient_funds_detected(self, wallet):
        transport = mock_transport(
            [
                (200, CONTRACTS_RESPONSE),
                (402, {"error": "Insufficient USDC balance", "code": "insufficient_funds"}),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        with pytest.raises(PayInsufficientFundsError):
            wallet.balance()


class TestDiscover:
    def test_standalone_discover(self):
        transport = mock_transport(
            [
                (
                    200,
                    {
                        "services": [
                            {
                                "name": "Test API",
                                "description": "A test",
                                "base_url": "https://test.com",
                                "category": "data",
                                "keywords": ["test"],
                                "routes": [],
                            },
                        ]
                    },
                ),
            ]
        )
        client = httpx.Client(transport=transport)
        with patch("payskill.wallet.httpx.get", side_effect=lambda *a, **kw: client.get(*a, **kw)):
            from payskill.wallet import discover

            result = discover("test", testnet=True)
            assert len(result) == 1
            assert result[0].name == "Test API"

    def test_wallet_discover(self, wallet):
        transport = mock_transport(
            [
                (
                    200,
                    {
                        "services": [
                            {
                                "name": "Weather",
                                "description": "Weather data",
                                "base_url": "https://weather.com",
                                "category": "data",
                                "keywords": ["weather"],
                                "routes": [],
                            },
                        ]
                    },
                ),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        # discover uses _discover_impl which calls httpx.get directly, not wallet._client
        # so we need to patch httpx.get
        with patch("payskill.wallet.httpx.get") as mock_get:
            mock_get.return_value = httpx.Response(
                200,
                json={
                    "services": [
                        {
                            "name": "Weather",
                            "description": "Weather data",
                            "base_url": "https://weather.com",
                            "category": "data",
                            "keywords": ["weather"],
                            "routes": [],
                        },
                    ]
                },
            )
            result = wallet.discover("weather")
            assert len(result) == 1
            assert result[0].name == "Weather"


class TestX402:
    def test_non_402_passes_through(self, wallet):
        transport = mock_transport(
            [
                (200, {"data": "success"}),
            ]
        )
        wallet._client = httpx.Client(transport=transport)
        resp = wallet.request("https://api.example.com/data")
        assert resp.status_code == 200

    def test_402_extract_from_body(self):
        from payskill.wallet import _extract_402

        result = _extract_402(
            {
                "accepts": [
                    {
                        "amount": 100000,
                        "payTo": "0x" + "a" * 40,
                        "extra": {"settlement": "direct"},
                    }
                ],
            }
        )
        assert result["settlement"] == "direct"
        assert result["amount"] == 100000
        assert result["to"] == "0x" + "a" * 40

    def test_402_extract_flat(self):
        from payskill.wallet import _extract_402

        result = _extract_402(
            {
                "settlement": "tab",
                "amount": 50000,
                "to": "0x" + "b" * 40,
            }
        )
        assert result["settlement"] == "tab"
        assert result["amount"] == 50000


class TestSettle:
    """Tests for the public settle() method."""

    def test_settle_direct_returns_metadata(self, wallet):
        """settle() with direct settlement extracts amount and type."""
        from payskill.wallet import _Contracts

        wallet._contracts = _Contracts(
            router=CONTRACTS_RESPONSE["router"],
            tab=CONTRACTS_RESPONSE["tab"],
            direct=CONTRACTS_RESPONSE["direct"],
            fee=CONTRACTS_RESPONSE["fee"],
            usdc=CONTRACTS_RESPONSE["usdc"],
            chain_id=CONTRACTS_RESPONSE["chain_id"],
            relayer=CONTRACTS_RESPONSE["relayer"],
        )

        provider = "0x" + "aa" * 20
        # Mock transport handles: retry request after payment
        transport = mock_transport(
            [
                (200, {"data": "paid content"}),
            ]
        )
        wallet._client = httpx.Client(transport=transport)

        resp402 = httpx.Response(
            402,
            json={
                "accepts": [
                    {
                        "amount": 100000,
                        "payTo": provider,
                        "extra": {"settlement": "direct"},
                    }
                ],
            },
        )

        result = wallet.settle(resp402, "https://api.example.com/data")
        assert result.response.status_code == 200
        assert result.amount == 100000
        assert result.settlement == "direct"

    def test_settle_tab_returns_metadata(self, wallet):
        """settle() with tab settlement extracts amount and type."""
        from payskill.wallet import _Contracts

        wallet._contracts = _Contracts(
            router=CONTRACTS_RESPONSE["router"],
            tab=CONTRACTS_RESPONSE["tab"],
            direct=CONTRACTS_RESPONSE["direct"],
            fee=CONTRACTS_RESPONSE["fee"],
            usdc=CONTRACTS_RESPONSE["usdc"],
            chain_id=CONTRACTS_RESPONSE["chain_id"],
            relayer=CONTRACTS_RESPONSE["relayer"],
        )

        provider = "0x" + "aa" * 20
        # Mock transport: GET /tabs, GET /status (balance), prepare-permit,
        #   POST /tabs, POST /charge, retry
        transport = mock_transport(
            [
                (200, []),  # GET /tabs (empty — no existing tab)
                (
                    200,
                    {"balance_usdc": "100.00", "total_locked": 0},
                ),  # GET /status (balance check)
                (200, PERMIT_PREPARE_RESPONSE),  # GET /prepare-permit
                (
                    200,
                    {
                        "id": "tab-001",
                        "provider": provider,
                        "amount": 5000000,
                        "status": "open",
                    },
                ),  # POST /tabs
                (
                    200,
                    {"charge_id": "ch-001", "status": "buffered"},
                ),  # POST /charge
                (200, {"data": "paid content"}),  # retry
            ]
        )
        wallet._client = httpx.Client(transport=transport)

        resp402 = httpx.Response(
            402,
            json={
                "accepts": [
                    {
                        "amount": 100000,
                        "payTo": provider,
                        "extra": {"settlement": "tab"},
                    }
                ],
            },
        )

        result = wallet.settle(resp402, "https://api.example.com/data")
        assert result.response.status_code == 200
        assert result.amount == 100000
        assert result.settlement == "tab"

    def test_settle_forwards_method_and_body(self, wallet):
        """settle() passes method and body through to the retry request."""
        from payskill.wallet import _Contracts

        wallet._contracts = _Contracts(
            router=CONTRACTS_RESPONSE["router"],
            tab=CONTRACTS_RESPONSE["tab"],
            direct=CONTRACTS_RESPONSE["direct"],
            fee=CONTRACTS_RESPONSE["fee"],
            usdc=CONTRACTS_RESPONSE["usdc"],
            chain_id=CONTRACTS_RESPONSE["chain_id"],
            relayer=CONTRACTS_RESPONSE["relayer"],
        )

        captured_requests: list[httpx.Request] = []

        def capturing_handler(request: httpx.Request) -> httpx.Response:
            captured_requests.append(request)
            return httpx.Response(200, json={"ok": True})

        wallet._client = httpx.Client(
            transport=httpx.MockTransport(capturing_handler)
        )

        provider = "0x" + "aa" * 20
        resp402 = httpx.Response(
            402,
            json={
                "accepts": [
                    {
                        "amount": 100000,
                        "payTo": provider,
                        "extra": {"settlement": "direct"},
                    }
                ],
            },
        )

        wallet.settle(
            resp402,
            "https://api.example.com/data",
            method="POST",
            body='{"key":"val"}',
        )

        # Last request is the retry — verify method and body
        retry = captured_requests[-1]
        assert retry.method == "POST"
        assert b'"key"' in retry.content
        assert "PAYMENT-SIGNATURE" in retry.headers
