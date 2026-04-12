"""E2E acceptance tests -- run against live testnet.

Skip unless PAYSKILL_TESTNET_KEY is set. These hit the real testnet server
and exercise the full SDK -> server -> chain round-trip.

Usage:
    PAYSKILL_TESTNET_KEY=0xdead... pytest tests/test_e2e.py -v
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Generator

import pytest

from payskill import Wallet
from payskill.errors import PayValidationError

TESTNET_KEY = os.environ.get("PAYSKILL_TESTNET_KEY", "")

# Second wallet for provider-side operations
PROVIDER_ADDR = os.environ.get("PAYSKILL_TESTNET_PROVIDER", "0x" + "b2" * 20)

skip_no_key = pytest.mark.skipif(not TESTNET_KEY, reason="PAYSKILL_TESTNET_KEY not set")

# Mark all tests in this module as e2e
pytestmark = [pytest.mark.e2e, pytest.mark.timeout(60)]


@pytest.fixture(scope="module")
def wallet() -> Generator[Wallet, None, None]:
    w = Wallet(private_key=TESTNET_KEY, testnet=True)
    yield w
    w.close()


# -- Connectivity -------------------------------------------------------------


@skip_no_key
class TestStatus:
    def test_get_status(self, wallet: Wallet) -> None:
        """Server is reachable and returns valid status."""
        status = wallet.status()
        assert status.address
        assert status.balance.total >= 0
        assert isinstance(status.open_tabs, int)

    def test_balance(self, wallet: Wallet) -> None:
        """Balance returns dollar amounts."""
        bal = wallet.balance()
        assert bal.total >= 0
        assert bal.available >= 0


# -- Direct Payment -----------------------------------------------------------


@skip_no_key
class TestDirectPayment:
    def test_validation_still_works(self, wallet: Wallet) -> None:
        """Client-side validation catches bad inputs before hitting server."""
        with pytest.raises(PayValidationError, match="Invalid"):
            wallet.send("not-an-address", 5.0)

        with pytest.raises(PayValidationError, match="below minimum"):
            wallet.send(PROVIDER_ADDR, 0.50)

    def test_direct_payment(self, wallet: Wallet) -> None:
        """Send $1 USDC via direct payment."""
        result = wallet.send(PROVIDER_ADDR, 1.0, memo="e2e-test")
        assert result.tx_hash
        assert result.status in ("confirmed", "pending")
        assert result.amount == 1.0
        assert result.fee > 0  # 1% fee


# -- Tab Lifecycle ------------------------------------------------------------


@skip_no_key
class TestTabLifecycle:
    """Full tab lifecycle: open -> list -> get -> top-up -> close."""

    _tab_id: str = ""

    def test_01_open_tab(self, wallet: Wallet) -> None:
        """Open a $5 tab with provider."""
        tab = wallet.open_tab(PROVIDER_ADDR, 5.0, max_charge_per_call=0.50)
        assert tab.id
        assert tab.provider.lower() == PROVIDER_ADDR.lower()
        assert tab.status == "open"
        assert tab.charge_count == 0
        TestTabLifecycle._tab_id = tab.id

    def test_02_list_tabs(self, wallet: Wallet) -> None:
        """Newly opened tab appears in list."""
        tabs = wallet.list_tabs()
        assert isinstance(tabs, list)
        tab_ids = [t.id for t in tabs]
        assert TestTabLifecycle._tab_id in tab_ids

    def test_03_get_tab(self, wallet: Wallet) -> None:
        """Get specific tab by ID."""
        tab = wallet.get_tab(TestTabLifecycle._tab_id)
        assert tab.id == TestTabLifecycle._tab_id
        assert tab.status == "open"

    def test_04_top_up_tab(self, wallet: Wallet) -> None:
        """Top up adds funds without extra activation fee."""
        before = wallet.get_tab(TestTabLifecycle._tab_id)
        tab = wallet.top_up_tab(TestTabLifecycle._tab_id, 5.0)
        assert tab.balance_remaining > before.balance_remaining

    def test_05_close_tab(self, wallet: Wallet) -> None:
        """Close distributes funds and marks tab closed."""
        tab = wallet.close_tab(TestTabLifecycle._tab_id)
        assert tab.status == "closed"


# -- Webhooks -----------------------------------------------------------------


@skip_no_key
class TestWebhookCrud:
    """Register -> list -> delete a webhook."""

    _wh_id: str = ""

    def test_01_register(self, wallet: Wallet) -> None:
        """Register a webhook endpoint."""
        wh = wallet.register_webhook(
            f"https://example.com/hook/{uuid.uuid4().hex[:8]}",
            events=["payment.completed"],
            secret="whsec_test_" + uuid.uuid4().hex[:8],
        )
        assert wh.id
        assert wh.url.startswith("https://")
        assert "payment.completed" in wh.events
        TestWebhookCrud._wh_id = wh.id

    def test_02_list(self, wallet: Wallet) -> None:
        """Registered webhook shows in list."""
        webhooks = wallet.list_webhooks()
        assert isinstance(webhooks, list)
        wh_ids = [w.id for w in webhooks]
        assert TestWebhookCrud._wh_id in wh_ids

    def test_03_delete(self, wallet: Wallet) -> None:
        """Delete webhook removes it."""
        wallet.delete_webhook(TestWebhookCrud._wh_id)
        webhooks = wallet.list_webhooks()
        wh_ids = [w.id for w in webhooks]
        assert TestWebhookCrud._wh_id not in wh_ids


# -- Funding Links ------------------------------------------------------------


@skip_no_key
class TestFunding:
    def test_fund_link(self, wallet: Wallet) -> None:
        """Get a funding link."""
        link = wallet.create_fund_link(message="e2e test")
        assert link
        assert link.startswith("https://")

    def test_withdraw_link(self, wallet: Wallet) -> None:
        """Get a withdrawal link."""
        link = wallet.create_withdraw_link()
        assert link
        assert link.startswith("https://")


# -- Mint (testnet only) ------------------------------------------------------


@skip_no_key
class TestMint:
    def test_mint(self, wallet: Wallet) -> None:
        """Mint testnet USDC."""
        result = wallet.mint(10)
        assert result.tx_hash
        assert result.amount == 10.0
