"""Tests for PayClient methods."""

import pytest
from pytest_httpx import HTTPXMock

from payskill.client import DEFAULT_API_URL, PayClient
from payskill.errors import PayServerError, PayValidationError
from payskill.signer import CallbackSigner

VALID_ADDR = "0x" + "a1" * 20
PROVIDER_ADDR = "0x" + "b2" * 20

# Dummy signer that returns 65 zero bytes
_DUMMY_SIGNER = CallbackSigner(callback=lambda h: b"\x00" * 65)


@pytest.fixture()
def client() -> PayClient:
    return PayClient(api_url=DEFAULT_API_URL, signer=_DUMMY_SIGNER)


class TestPayDirect:
    def test_happy_path(self, client: PayClient, httpx_mock: HTTPXMock) -> None:
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
        assert tab.status.value == "open"

    def test_below_minimum(self, client: PayClient) -> None:
        with pytest.raises(PayValidationError, match="below minimum"):
            client.open_tab(PROVIDER_ADDR, 1_000_000, max_charge_per_call=100_000)

    def test_zero_max_charge(self, client: PayClient) -> None:
        with pytest.raises(PayValidationError, match="max_charge_per_call"):
            client.open_tab(PROVIDER_ADDR, 10_000_000, max_charge_per_call=0)


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
                "address": VALID_ADDR,
                "balance": 142_500_000,
                "open_tabs": [],
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
                "webhook_id": "wh_123",
                "url": "https://example.com/hook",
                "events": ["tab.charged"],
            },
        )
        wh = client.register_webhook("https://example.com/hook", events=["tab.charged"])
        assert wh.webhook_id == "wh_123"
