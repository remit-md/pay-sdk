"""Tests for PayClient methods."""

import base64
import json

import pytest
from pytest_httpx import HTTPXMock

from payskill.client import DEFAULT_API_URL, PayClient
from payskill.errors import PayServerError, PayValidationError
from payskill.signer import CallbackSigner

VALID_ADDR = "0x" + "a1" * 20
PROVIDER_ADDR = "0x" + "b2" * 20
DIRECT_CONTRACT = "0x" + "d1" * 20
TAB_CONTRACT = "0x" + "d2" * 20
USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def _v2_payment_required(
    amount: str, pay_to: str, settlement: str = "direct"
) -> str:
    """Build a base64-encoded v2 PAYMENT-REQUIRED header value."""
    payload = {
        "x402Version": 2,
        "resource": {"url": "https://api.example.com/data", "mimeType": "application/json"},
        "accepts": [
            {
                "scheme": "exact",
                "network": "eip155:8453",
                "amount": amount,
                "asset": USDC_ADDR,
                "payTo": pay_to,
                "maxTimeoutSeconds": 60,
                "extra": {
                    "name": "USDC",
                    "version": "2",
                    "facilitator": "https://pay-skill.com/x402",
                    "settlement": settlement,
                },
            }
        ],
        "extensions": {},
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()

# Dummy signer that returns 65 zero bytes
_DUMMY_SIGNER = CallbackSigner(callback=lambda h: b"\x00" * 65)


@pytest.fixture()
def client() -> PayClient:
    return PayClient(api_url=DEFAULT_API_URL, signer=_DUMMY_SIGNER)


def mock_permit_flow(httpx_mock: HTTPXMock) -> None:
    """Add mocks for /contracts and /permit/prepare (needed by pay_direct, open_tab, etc.)."""
    httpx_mock.add_response(
        url=f"{DEFAULT_API_URL}/contracts",
        method="GET",
        json={
            "router": "0x" + "00" * 20,
            "tab": TAB_CONTRACT,
            "direct": DIRECT_CONTRACT,
            "usdc": "0x" + "00" * 20,
        },
    )
    httpx_mock.add_response(
        url=f"{DEFAULT_API_URL}/permit/prepare",
        method="POST",
        json={"hash": "0x" + "ab" * 32, "nonce": "0", "deadline": 9999999999},
    )


class TestPayDirect:
    def test_happy_path(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        mock_permit_flow(httpx_mock)
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/direct",
            method="POST",
            json={
                "tx_hash": "0xabc",
                "status": "confirmed",
                "amount": 5_000_000,
                "fee": 50_000,
            },
        )
        result = client.pay_direct(VALID_ADDR, 5_000_000, memo="test")
        assert result.tx_hash == "0xabc"
        assert result.amount == 5_000_000
        assert result.fee == 50_000

    def test_invalid_address(self, client: PayClient) -> None:
        with pytest.raises(PayValidationError, match="Invalid"):
            client.pay_direct("not-an-address", 1_000_000)

    def test_below_minimum(self, client: PayClient) -> None:
        with pytest.raises(PayValidationError, match="below minimum"):
            client.pay_direct(VALID_ADDR, 500_000)

    def test_server_error(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        mock_permit_flow(httpx_mock)
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/direct",
            method="POST",
            status_code=400,
            json={"error": "insufficient balance"},
        )
        with pytest.raises(PayServerError) as exc_info:
            client.pay_direct(VALID_ADDR, 1_000_000)
        assert exc_info.value.status_code == 400


class TestOpenTab:
    def test_happy_path(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        mock_permit_flow(httpx_mock)
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/tabs",
            method="POST",
            json={
                "tab_id": "tab_123",
                "provider": PROVIDER_ADDR,
                "amount": 20_000_000,
                "balance_remaining": 19_800_000,
                "total_charged": 0,
                "charge_count": 0,
                "max_charge_per_call": 500_000,
                "status": "open",
            },
        )
        tab = client.open_tab(PROVIDER_ADDR, 20_000_000, max_charge_per_call=500_000)
        assert tab.tab_id == "tab_123"
        assert tab.status == "open"

    def test_below_minimum(self, client: PayClient) -> None:
        with pytest.raises(PayValidationError, match="below minimum"):
            client.open_tab(PROVIDER_ADDR, 1_000_000, max_charge_per_call=100_000)

    def test_zero_max_charge(self, client: PayClient) -> None:
        with pytest.raises(PayValidationError, match="max_charge_per_call"):
            client.open_tab(PROVIDER_ADDR, 10_000_000, max_charge_per_call=0)


class TestWithdrawTab:
    def test_happy_path(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/tabs/tab_123/withdraw",
            method="POST",
            json={
                "tab_id": "tab_123",
                "provider": PROVIDER_ADDR,
                "amount": 20_000_000,
                "balance_remaining": 15_000_000,
                "total_charged": 5_000_000,
                "total_withdrawn": 5_000_000,
                "charge_count": 10,
                "max_charge_per_call": 500_000,
                "status": "open",
            },
        )
        tab = client.withdraw_tab("tab_123")
        assert tab.tab_id == "tab_123"
        assert tab.total_withdrawn == 5_000_000
        assert tab.status == "open"

    def test_server_error(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/tabs/tab_456/withdraw",
            method="POST",
            status_code=403,
            json={"error": "not the provider"},
        )
        with pytest.raises(PayServerError) as exc_info:
            client.withdraw_tab("tab_456")
        assert exc_info.value.status_code == 403


class TestListTabs:
    def test_empty(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/tabs",
            method="GET",
            json=[],
        )
        assert client.list_tabs() == []


class TestGetStatus:
    def test_happy_path(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/status",
            method="GET",
            json={
                "wallet": VALID_ADDR,
                "balance_usdc": "142500000",
                "open_tabs": 0,
            },
        )
        status = client.get_status()
        assert status.balance == 142_500_000


class TestWebhooks:
    def test_register(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/webhooks",
            method="POST",
            json={
                "id": "wh_123",
                "url": "https://example.com/hook",
                "events": ["tab.charged"],
            },
        )
        wh = client.register_webhook("https://example.com/hook", events=["tab.charged"])
        assert wh.webhook_id == "wh_123"


class TestX402Request:
    def test_no_payment_needed(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        """200 response — no payment required."""
        httpx_mock.add_response(url="https://api.example.com/data", json={"data": "ok"})
        resp = client.request("https://api.example.com/data")
        assert resp.status_code == 200

    def test_402_direct_settlement(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        """402 with v2 direct settlement — SDK pays and retries with base64 v2 payload."""
        mock_permit_flow(httpx_mock)
        # First request: 402 with v2 PAYMENT-REQUIRED header
        httpx_mock.add_response(
            url="https://api.example.com/premium",
            json={},
            status_code=402,
            headers={"payment-required": _v2_payment_required("1000000", VALID_ADDR, "direct")},
        )
        # Direct payment to server
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/direct",
            method="POST",
            json={"tx_hash": "0xabc", "status": "confirmed", "amount": 1_000_000, "fee": 10_000},
        )
        # Retry after payment: 200
        httpx_mock.add_response(
            url="https://api.example.com/premium",
            json={"data": "premium content"},
        )

        resp = client.request("https://api.example.com/premium")
        assert resp.status_code == 200

        # Verify the retry request used base64-encoded v2 PAYMENT-SIGNATURE
        retry_req = httpx_mock.get_requests()[-1]
        sig_header = retry_req.headers.get("payment-signature")
        assert sig_header is not None
        decoded = json.loads(base64.b64decode(sig_header))
        assert decoded["x402Version"] == 2
        assert decoded["payload"]["txHash"] == "0xabc"
        assert decoded["extensions"]["pay"]["settlement"] == "direct"

    def test_402_tab_settlement_with_existing_tab(
        self, client: PayClient, httpx_mock: HTTPXMock
    ) -> None:
        """402 with v2 tab settlement — charges existing tab, sends v2 payload."""
        # First request: 402 with v2 PAYMENT-REQUIRED header
        httpx_mock.add_response(
            url="https://api.example.com/metered",
            json={},
            status_code=402,
            headers={"payment-required": _v2_payment_required("100000", PROVIDER_ADDR, "tab")},
        )
        # List tabs — returns existing open tab
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/tabs",
            method="GET",
            json=[
                {
                    "tab_id": "tab_existing",
                    "provider": PROVIDER_ADDR,
                    "amount": 10_000_000,
                    "balance_remaining": 9_000_000,
                    "total_charged": 1_000_000,
                    "charge_count": 5,
                    "max_charge_per_call": 500_000,
                    "status": "open",
                }
            ],
        )
        # Charge tab
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/tabs/tab_existing/charge",
            method="POST",
            json={"charge_id": "ch_1", "status": "approved"},
        )
        # Retry: 200
        httpx_mock.add_response(
            url="https://api.example.com/metered",
            json={"data": "metered content"},
        )

        resp = client.request("https://api.example.com/metered")
        assert resp.status_code == 200

        # Verify the retry request used base64-encoded v2 PAYMENT-SIGNATURE
        retry_req = httpx_mock.get_requests()[-1]
        sig_header = retry_req.headers.get("payment-signature")
        assert sig_header is not None
        decoded = json.loads(base64.b64decode(sig_header))
        assert decoded["x402Version"] == 2
        assert decoded["extensions"]["pay"]["settlement"] == "tab"
        assert decoded["extensions"]["pay"]["tabId"] == "tab_existing"
        assert decoded["extensions"]["pay"]["chargeId"] == "ch_1"

    def test_402_v2_body_fallback(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        """402 with v2 requirements in body (no header) — still parses correctly."""
        mock_permit_flow(httpx_mock)
        httpx_mock.add_response(
            url="https://api.example.com/premium",
            json={
                "x402Version": 2,
                "resource": {"url": "https://api.example.com/premium"},
                "accepts": [
                    {
                        "scheme": "exact",
                        "network": "eip155:8453",
                        "amount": "1000000",
                        "asset": USDC_ADDR,
                        "payTo": VALID_ADDR,
                        "maxTimeoutSeconds": 60,
                        "extra": {"settlement": "direct"},
                    }
                ],
                "extensions": {},
            },
            status_code=402,
        )
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/direct",
            method="POST",
            json={"tx_hash": "0xdef", "status": "confirmed", "amount": 1_000_000, "fee": 10_000},
        )
        httpx_mock.add_response(
            url="https://api.example.com/premium",
            json={"data": "ok"},
        )

        resp = client.request("https://api.example.com/premium")
        assert resp.status_code == 200

    def test_402_non_v2_raises(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        """402 with non-v2 body raises PayServerError."""
        httpx_mock.add_response(
            url="https://api.example.com/old",
            json={"scheme": "exact", "amount": 1000, "to": VALID_ADDR},
            status_code=402,
        )
        with pytest.raises(PayServerError, match="x402 v2"):
            client.request("https://api.example.com/old")


class TestFunding:
    def test_fund_link(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/links/fund",
            method="POST",
            json={"url": "https://pay-skill.com/fund?token=abc"},
        )
        link = client.create_fund_link()
        assert "pay-skill" in link

    def test_withdraw_link(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(
            url=f"{DEFAULT_API_URL}/links/withdraw",
            method="POST",
            json={"url": "https://pay-skill.com/withdraw?token=def"},
        )
        link = client.create_withdraw_link()
        assert "withdraw" in link
