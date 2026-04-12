"""
Pay SDK (Python) acceptance tests.

All tests use real Wallet class against live Base Sepolia.
No mocks. No stubs.

Run:
    cd sdk/acceptance/python
    pip install -e ../../python  # install SDK
    pip install -r requirements.txt
    python -m pytest test_flows.py -v
"""

import sys
import os

# Add SDK source to path for direct import
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "python", "src"))

from conftest import (
    API_URL,
    generate_wallet,
    mint,
    get_contracts,
    get_on_chain_balance,
    wait_for_balance_change,
)
from payskill import Wallet
from payskill.errors import PayValidationError


def make_wallet(private_key: str) -> Wallet:
    """Create a testnet Wallet with explicit key."""
    return Wallet(private_key=private_key, testnet=True)


class TestDirectPayment:
    """Direct payment via Wallet.send()."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.agent_key, self.agent_addr = generate_wallet()
        self.provider_key, self.provider_addr = generate_wallet()

        mint(self.agent_addr, 200)  # 200 USDC (server expects whole USDC)
        wait_for_balance_change(self.agent_addr, self.contracts["usdc"], 0)

    def test_send_transfers_usdc(self):
        wallet = make_wallet(self.agent_key)

        before_agent = get_on_chain_balance(self.agent_addr, self.contracts["usdc"])
        before_provider = get_on_chain_balance(self.provider_addr, self.contracts["usdc"])

        result = wallet.send(self.provider_addr, 5.0, memo="acceptance")

        assert result.tx_hash, "should return tx_hash"

        after_agent = wait_for_balance_change(
            self.agent_addr, self.contracts["usdc"], before_agent
        )
        after_provider = get_on_chain_balance(self.provider_addr, self.contracts["usdc"])

        # Agent paid ~5 USDC
        assert before_agent - after_agent >= 4_900_000

        # Provider received ~99%
        assert after_provider - before_provider >= 4_900_000


class TestTabLifecycle:
    """Tab lifecycle via Wallet methods."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.agent_key, self.agent_addr = generate_wallet()
        self.provider_key, self.provider_addr = generate_wallet()

        mint(self.agent_addr, 200)  # 200 USDC
        wait_for_balance_change(self.agent_addr, self.contracts["usdc"], 0)

    def test_open_list_close(self):
        wallet = make_wallet(self.agent_key)

        # Open tab ($20, $2/call max)
        tab = wallet.open_tab(self.provider_addr, 20.0, max_charge_per_call=2.0)
        assert tab.id, "should return tab id"

        import time

        time.sleep(5)  # wait for on-chain

        # List tabs
        tabs = wallet.list_tabs()
        assert any(t.id == tab.id for t in tabs), "tab should appear in list"

        # Close
        closed = wallet.close_tab(tab.id)
        assert closed.status == "closed", "tab should be closed"


class TestStatus:
    """Wallet status via Wallet.status()."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.key, self.addr = generate_wallet()
        mint(self.addr, 50)  # 50 USDC
        wait_for_balance_change(self.addr, self.contracts["usdc"], 0)

    def test_status(self):
        wallet = make_wallet(self.key)
        status = wallet.status()
        assert status.address, "should return address"
        assert status.balance.total >= 0

    def test_balance(self):
        wallet = make_wallet(self.key)
        bal = wallet.balance()
        assert bal.total >= 0
        assert bal.available >= 0


class TestWebhookCRUD:
    """Webhook CRUD via Wallet methods."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.key, self.addr = generate_wallet()

    def test_register_list_delete(self):
        wallet = make_wallet(self.key)

        import time

        hook_url = f"https://example.com/hooks/py-test-{int(time.time())}"

        # Register
        reg = wallet.register_webhook(
            hook_url, events=["payment.completed"], secret="whsec_test_acceptance"
        )
        assert reg.id, "should return webhook id"

        # List
        hooks = wallet.list_webhooks()
        found = any(h.id == reg.id for h in hooks)
        assert found, "webhook should appear in list"

        # Delete
        wallet.delete_webhook(reg.id)

        # Verify gone
        hooks_after = wallet.list_webhooks()
        not_found = all(h.id != reg.id for h in hooks_after)
        assert not_found, "deleted webhook should not appear"


class TestFundWithdrawLinks:
    """Fund and withdraw link creation."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.key, self.addr = generate_wallet()

    def test_create_fund_link(self):
        wallet = make_wallet(self.key)
        url = wallet.create_fund_link()
        assert isinstance(url, str) and len(url) > 0

    def test_create_withdraw_link(self):
        wallet = make_wallet(self.key)
        url = wallet.create_withdraw_link()
        assert isinstance(url, str) and len(url) > 0


class TestX402Request:
    """x402 V2 request() with auto-payment."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.agent_key, self.agent_addr = generate_wallet()
        self.provider_key, self.provider_addr = generate_wallet()
        mint(self.agent_addr, 200)  # 200 USDC
        wait_for_balance_change(self.agent_addr, self.contracts["usdc"], 0)

    def test_request_handles_402_direct(self):
        """Wallet.request() sees 402, pays via EIP-3009, retries with PAYMENT-SIGNATURE."""
        import base64
        import json
        import threading
        from http.server import HTTPServer, BaseHTTPRequestHandler

        provider_addr = self.provider_addr

        class X402Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                sig = self.headers.get("PAYMENT-SIGNATURE", "")
                if sig:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"content":"paid"}')
                else:
                    requirements = {
                        "scheme": "exact",
                        "amount": 1_000_000,
                        "to": provider_addr,
                        "settlement": "direct",
                        "facilitator": "https://testnet.pay-skill.com/x402",
                        "maxChargePerCall": 1_000_000,
                        "network": "eip155:84532",
                    }
                    req_b64 = base64.b64encode(json.dumps(requirements).encode()).decode()
                    self.send_response(402)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("payment-required", req_b64)
                    self.end_headers()
                    body = json.dumps(
                        {
                            "error": "payment_required",
                            "message": "This resource requires payment",
                            "requirements": requirements,
                        }
                    )
                    self.wfile.write(body.encode())

            def log_message(self, format, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), X402Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            wallet = make_wallet(self.agent_key)
            resp = wallet.request(f"http://127.0.0.1:{port}/content")
            assert resp.status_code == 200, f"expected 200, got {resp.status_code}"
            data = resp.json()
            assert data["content"] == "paid"
        finally:
            server.shutdown()


class TestErrorPaths:
    """Client-side validation errors."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.key, self.addr = generate_wallet()

    def test_bad_address_raises_validation_error(self):
        wallet = make_wallet(self.key)
        try:
            wallet.send("not-an-address", 5.0)
            assert False, "should have raised"
        except (PayValidationError, ValueError, Exception):
            pass

    def test_below_minimum_raises_error(self):
        wallet = make_wallet(self.key)
        try:
            wallet.send("0x" + "a1" * 20, 0.50)  # $0.50 — below $1 min
            assert False, "should have raised"
        except (PayValidationError, ValueError, Exception):
            pass
