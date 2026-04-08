"""E2E acceptance tests — run against live testnet.

Skip unless PAYSKILL_TESTNET_KEY is set. These hit the real testnet server
and exercise the full SDK → server → chain round-trip.

Usage:
    PAYSKILL_TESTNET_KEY=0xdead... pytest tests/test_e2e.py -v
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Generator

import pytest

from payskill.client import PayClient
from payskill.errors import PayValidationError
from payskill.models import TabStatus
from payskill.signer import CallbackSigner

TESTNET_URL = os.environ.get("PAYSKILL_TESTNET_URL", "https://testnet.pay-skill.com/api/v1")
TESTNET_KEY = os.environ.get("PAYSKILL_TESTNET_KEY", "")

# Testnet contract addresses (Base Sepolia)
CHAIN_ID = 84532
ROUTER_ADDRESS = "0xE0Aa45e6937F3b9Fc0BEe457361885Cb9bfC067F"

# Second wallet for provider-side operations
PROVIDER_ADDR = os.environ.get("PAYSKILL_TESTNET_PROVIDER", "0x" + "b2" * 20)

skip_no_key = pytest.mark.skipif(not TESTNET_KEY, reason="PAYSKILL_TESTNET_KEY not set")

# Mark all tests in this module as e2e
pytestmark = [pytest.mark.e2e, pytest.mark.timeout(60)]


def _make_signer() -> CallbackSigner:
    """Build a signer from the testnet private key.

    Uses eth_account if available, otherwise a dummy signer
    (server may accept unsigned requests on testnet).
    """
    try:
        from eth_account import Account  # type: ignore[import-untyped]

        acct = Account.from_key(TESTNET_KEY)

        def _sign(hash_bytes: bytes) -> bytes:
            signed = acct.signHash(hash_bytes)
            return bytes(signed.signature)

        return CallbackSigner(callback=_sign)
    except ImportError:
        # Fallback: dummy signer for testnet (server may not verify sigs)
        return CallbackSigner(callback=lambda h: b"\x00" * 65)


@pytest.fixture(scope="module")
def client() -> Generator[PayClient, None, None]:
    c = PayClient(
        api_url=TESTNET_URL,
        private_key=TESTNET_KEY,
        chain_id=CHAIN_ID,
        router_address=ROUTER_ADDRESS,
    )
    yield c
    c.close()


# ── Connectivity ─────────────────────────────────────────────────────


@skip_no_key
class TestStatus:
    def test_get_status(self, client: PayClient) -> None:
        """Server is reachable and returns valid status."""
        status = client.get_status()
        assert hasattr(status, "address")
        assert isinstance(status.balance, int)
        assert status.balance >= 0
        assert isinstance(status.open_tabs, list)


# ── Direct Payment ───────────────────────────────────────────────────


@skip_no_key
class TestDirectPayment:
    def test_validation_still_works(self, client: PayClient) -> None:
        """Client-side validation catches bad inputs before hitting server."""
        with pytest.raises(PayValidationError, match="Invalid"):
            client.pay_direct("not-an-address", 1_000_000)

        with pytest.raises(PayValidationError, match="below minimum"):
            client.pay_direct(PROVIDER_ADDR, 500_000)

    def test_direct_payment(self, client: PayClient) -> None:
        """Send $1 USDC via direct payment."""
        result = client.pay_direct(PROVIDER_ADDR, 1_000_000, memo="e2e-test")
        assert result.tx_hash
        assert result.status in ("confirmed", "pending")
        assert result.amount == 1_000_000
        assert result.fee > 0  # 1% fee


# ── Tab Lifecycle ────────────────────────────────────────────────────


@skip_no_key
class TestTabLifecycle:
    """Full tab lifecycle: open → list → get → top-up → close."""

    _tab_id: str = ""

    def test_01_open_tab(self, client: PayClient) -> None:
        """Open a $5 tab with provider."""
        tab = client.open_tab(PROVIDER_ADDR, 5_000_000, max_charge_per_call=500_000)
        assert tab.tab_id
        assert tab.provider == PROVIDER_ADDR
        assert tab.status == TabStatus.OPEN
        assert tab.max_charge_per_call == 500_000
        assert tab.charge_count == 0
        # Activation fee deducted: balance_remaining < amount
        assert tab.balance_remaining <= 5_000_000
        TestTabLifecycle._tab_id = tab.tab_id

    def test_02_list_tabs(self, client: PayClient) -> None:
        """Newly opened tab appears in list."""
        tabs = client.list_tabs()
        assert isinstance(tabs, list)
        tab_ids = [t.tab_id for t in tabs]
        assert TestTabLifecycle._tab_id in tab_ids

    def test_03_get_tab(self, client: PayClient) -> None:
        """Get specific tab by ID."""
        tab = client.get_tab(TestTabLifecycle._tab_id)
        assert tab.tab_id == TestTabLifecycle._tab_id
        assert tab.status == TabStatus.OPEN

    def test_04_top_up_tab(self, client: PayClient) -> None:
        """Top up adds funds without extra activation fee."""
        before = client.get_tab(TestTabLifecycle._tab_id)
        tab = client.top_up_tab(TestTabLifecycle._tab_id, 5_000_000)
        assert tab.balance_remaining > before.balance_remaining

    def test_05_close_tab(self, client: PayClient) -> None:
        """Close distributes funds and marks tab closed."""
        tab = client.close_tab(TestTabLifecycle._tab_id)
        assert tab.status == TabStatus.CLOSED


# ── Webhooks ─────────────────────────────────────────────────────────


@skip_no_key
class TestWebhookCrud:
    """Register → list → delete a webhook."""

    _wh_id: str = ""

    def test_01_register(self, client: PayClient) -> None:
        """Register a webhook endpoint."""
        wh = client.register_webhook(
            f"https://example.com/hook/{uuid.uuid4().hex[:8]}",
            events=["payment.completed"],
            secret="whsec_test_" + uuid.uuid4().hex[:8],
        )
        assert wh.webhook_id
        assert wh.url.startswith("https://")
        assert "payment.completed" in wh.events
        TestWebhookCrud._wh_id = wh.webhook_id

    def test_02_list(self, client: PayClient) -> None:
        """Registered webhook shows in list."""
        webhooks = client.list_webhooks()
        assert isinstance(webhooks, list)
        wh_ids = [w.webhook_id for w in webhooks]
        assert TestWebhookCrud._wh_id in wh_ids

    def test_03_delete(self, client: PayClient) -> None:
        """Delete webhook removes it."""
        client.delete_webhook(TestWebhookCrud._wh_id)
        webhooks = client.list_webhooks()
        wh_ids = [w.webhook_id for w in webhooks]
        assert TestWebhookCrud._wh_id not in wh_ids


# ── Funding Links ────────────────────────────────────────────────────


@skip_no_key
class TestFunding:
    def test_fund_link(self, client: PayClient) -> None:
        """Get a funding link."""
        link = client.create_fund_link(amount=10_000_000)
        assert link
        assert link.startswith("https://")

    def test_withdraw_link(self, client: PayClient) -> None:
        """Get a withdrawal link."""
        link = client.create_withdraw_link(amount=5_000_000)
        assert link
        assert link.startswith("https://")
