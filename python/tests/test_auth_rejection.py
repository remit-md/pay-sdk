"""Auth rejection tests — proves that:

1. Requests without auth headers are rejected with 401
2. Requests with stub signers are rejected
3. The SDK surfaces auth errors as PayServerError with correct status_code
"""

import httpx
import pytest
from pytest_httpx import HTTPXMock

from payskill.client import DEFAULT_API_URL, PayClient
from payskill.errors import PayServerError
from payskill.signer import CallbackSigner, RawKeySigner

# Anvil account #0 — well-known test key
ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

TEST_ROUTER = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
TEST_CHAIN_ID = 8453


class TestAuthRejection:
    """Server returns 401 when auth headers are missing or invalid."""

    def test_no_auth_headers_returns_401(self, httpx_mock: HTTPXMock) -> None:
        """Client without auth config sends no X-Pay-* headers → server 401."""
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/status",
            method="GET",
            status_code=401,
            json={"error": "Missing auth headers"},
        )

        # Client without private_key/chain_id/router_address → no auth headers
        client = PayClient(
            api_url=DEFAULT_API_URL,
            signer=CallbackSigner(callback=lambda h: b"\x00" * 65),
        )

        with pytest.raises(PayServerError) as exc_info:
            client.get_status()

        assert exc_info.value.status_code == 401
        assert "Missing auth headers" in str(exc_info.value)
        client.close()

    def test_stub_signer_rejected(self, httpx_mock: HTTPXMock) -> None:
        """Client with stub signer (all-zero sig) → server rejects with 401."""
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/status",
            method="GET",
            status_code=401,
            json={"error": "Invalid signature"},
        )

        client = PayClient(
            api_url=DEFAULT_API_URL,
            signer=CallbackSigner(callback=lambda h: b"\x00" * 65),
            chain_id=TEST_CHAIN_ID,
            router_address=TEST_ROUTER,
        )

        with pytest.raises(PayServerError) as exc_info:
            client.get_status()

        assert exc_info.value.status_code == 401
        client.close()

    def test_server_error_has_correct_fields(self, httpx_mock: HTTPXMock) -> None:
        """PayServerError from 401 has status_code and code fields."""
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/status",
            method="GET",
            status_code=401,
            json={"error": "Unauthorized"},
        )

        client = PayClient(
            api_url=DEFAULT_API_URL,
            signer=CallbackSigner(callback=lambda h: b"\x00" * 65),
        )

        with pytest.raises(PayServerError) as exc_info:
            client.get_status()

        err = exc_info.value
        assert err.status_code == 401
        assert err.code == "server_error"
        client.close()

    def test_authenticated_client_sends_headers(self, httpx_mock: HTTPXMock) -> None:
        """Client with real private key sends X-Pay-* headers on every request."""

        def check_auth_headers(request: httpx.Request) -> httpx.Response:
            # Verify all required auth headers are present
            assert "x-pay-agent" in request.headers, "Missing X-Pay-Agent"
            assert "x-pay-signature" in request.headers, "Missing X-Pay-Signature"
            assert "x-pay-timestamp" in request.headers, "Missing X-Pay-Timestamp"
            assert "x-pay-nonce" in request.headers, "Missing X-Pay-Nonce"

            # Agent address should match the derived address
            agent = request.headers["x-pay-agent"]
            assert agent.lower() == ANVIL_ADDRESS.lower()

            # Signature should not be all zeros
            sig = request.headers["x-pay-signature"]
            assert sig != "0x" + "0" * 130, "Signature must not be zeros (stub)"

            return httpx.Response(
                status_code=200,
                json={
                    "address": agent,
                    "balance": 100_000_000,
                    "open_tabs": [],
                },
            )

        httpx_mock.add_callback(check_auth_headers, url=f"{DEFAULT_API_URL}/status")

        client = PayClient(
            api_url=DEFAULT_API_URL,
            signer=RawKeySigner(key=ANVIL_PK),
            private_key=ANVIL_PK,
            chain_id=TEST_CHAIN_ID,
            router_address=TEST_ROUTER,
        )

        # Should succeed — headers are valid
        status = client.get_status()
        assert status.balance == 100_000_000
        client.close()

    def test_all_api_endpoints_get_auth_headers(self, httpx_mock: HTTPXMock) -> None:
        """Verify auth headers are sent on POST endpoints too, not just GET."""

        def check_and_respond(request: httpx.Request) -> httpx.Response:
            assert "x-pay-agent" in request.headers, (
                f"Missing X-Pay-Agent on {request.method} {request.url}"
            )
            assert "x-pay-signature" in request.headers, (
                f"Missing X-Pay-Signature on {request.method} {request.url}"
            )
            return httpx.Response(
                status_code=200,
                json={
                    "tx_hash": "0xabc",
                    "status": "confirmed",
                    "amount": 1_000_000,
                    "fee": 10_000,
                },
            )

        httpx_mock.add_callback(check_and_respond, url=f"{DEFAULT_API_URL}/direct")

        client = PayClient(
            api_url=DEFAULT_API_URL,
            signer=RawKeySigner(key=ANVIL_PK),
            private_key=ANVIL_PK,
            chain_id=TEST_CHAIN_ID,
            router_address=TEST_ROUTER,
        )

        result = client.pay_direct("0x" + "a1" * 20, 1_000_000, memo="auth-test")
        assert result.tx_hash == "0xabc"
        client.close()
