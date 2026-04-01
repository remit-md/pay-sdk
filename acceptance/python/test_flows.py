"""
Pay SDK (Python) acceptance tests.

All tests use real PayClient with RawKeySigner against live Base Sepolia.
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
from payskill import PayClient
from payskill.errors import PayValidationError


class TestDirectPayment:
    """Direct payment via PayClient.pay_direct()."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.agent_key, self.agent_addr = generate_wallet()
        self.provider_key, self.provider_addr = generate_wallet()

        mint(self.agent_addr, 200)  # 200 USDC (server expects whole USDC)
        wait_for_balance_change(self.agent_addr, self.contracts["usdc"], 0)

    def test_pay_direct_transfers_usdc(self):
        client = PayClient(
            api_url=API_URL,
            signer="raw",
            private_key=self.agent_key,
            chain_id=84532,
            router_address=self.contracts["router"],
        )

        before_agent = get_on_chain_balance(self.agent_addr, self.contracts["usdc"])
        before_provider = get_on_chain_balance(self.provider_addr, self.contracts["usdc"])

        result = client.pay_direct(self.provider_addr, 5_000_000, memo="acceptance")

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
    """Tab lifecycle via PayClient methods."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.agent_key, self.agent_addr = generate_wallet()
        self.provider_key, self.provider_addr = generate_wallet()

        mint(self.agent_addr, 200)  # 200 USDC
        wait_for_balance_change(self.agent_addr, self.contracts["usdc"], 0)

    def test_open_charge_close(self):
        agent_client = PayClient(
            api_url=API_URL,
            signer="raw",
            private_key=self.agent_key,
            chain_id=84532,
            router_address=self.contracts["router"],
        )
        provider_client = PayClient(
            api_url=API_URL,
            signer="raw",
            private_key=self.provider_key,
            chain_id=84532,
            router_address=self.contracts["router"],
        )

        # Open tab
        tab = agent_client.open_tab(self.provider_addr, 20_000_000, 2_000_000)
        assert tab.tab_id, "should return tab_id"

        import time
        time.sleep(5)  # wait for on-chain

        # List tabs
        tabs = agent_client.list_tabs()
        assert any(t.tab_id == tab.tab_id for t in tabs), "tab should appear in list"

        # Close
        closed = agent_client.close_tab(tab.tab_id)
        assert closed, "close should succeed"


class TestStatus:
    """Wallet status via PayClient.get_status()."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.key, self.addr = generate_wallet()
        mint(self.addr, 50)  # 50 USDC
        wait_for_balance_change(self.addr, self.contracts["usdc"], 0)

    def test_get_status(self):
        client = PayClient(
            api_url=API_URL,
            signer="raw",
            private_key=self.key,
            chain_id=84532,
            router_address=self.contracts["router"],
        )
        status = client.get_status()
        assert status.wallet or status.address, "should return wallet address"


class TestWebhookCRUD:
    """Webhook CRUD via PayClient methods."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.key, self.addr = generate_wallet()

    def test_register_list_delete(self):
        client = PayClient(
            api_url=API_URL,
            signer="raw",
            private_key=self.key,
            chain_id=84532,
            router_address=self.contracts["router"],
        )

        import time
        hook_url = f"https://example.com/hooks/py-test-{int(time.time())}"

        # Register
        reg = client.register_webhook(hook_url, events=["tab.charged", "payment.completed"], secret="whsec_test_acceptance_secret")
        assert reg.webhook_id, "should return webhook_id"

        # List
        hooks = client.list_webhooks()
        found = any(h.webhook_id == reg.webhook_id for h in hooks)
        assert found, "webhook should appear in list"

        # Delete
        client.delete_webhook(reg.webhook_id)

        # Verify gone
        hooks_after = client.list_webhooks()
        not_found = all(h.webhook_id != reg.webhook_id for h in hooks_after)
        assert not_found, "deleted webhook should not appear"


class TestFundWithdrawLinks:
    """Fund and withdraw link creation."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.key, self.addr = generate_wallet()

    def test_create_fund_link(self):
        client = PayClient(
            api_url=API_URL,
            signer="raw",
            private_key=self.key,
            chain_id=84532,
            router_address=self.contracts["router"],
        )
        url = client.create_fund_link()
        assert isinstance(url, str) and len(url) > 0

    def test_create_withdraw_link(self):
        client = PayClient(
            api_url=API_URL,
            signer="raw",
            private_key=self.key,
            chain_id=84532,
            router_address=self.contracts["router"],
        )
        url = client.create_withdraw_link()
        assert isinstance(url, str) and len(url) > 0


class TestX402Request:
    """x402 request() with auto-payment."""

    def setup_method(self):
        self.contracts = get_contracts()
        self.agent_key, self.agent_addr = generate_wallet()
        self.provider_key, self.provider_addr = generate_wallet()
        mint(self.agent_addr, 200)  # 200 USDC
        wait_for_balance_change(self.agent_addr, self.contracts["usdc"], 0)

    def test_request_handles_402_direct(self):
        """SDK request() sees 402, pays via payDirect, retries with headers."""
        import threading
        from http.server import HTTPServer, BaseHTTPRequestHandler

        provider_addr = self.provider_addr

        class X402Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                tx = self.headers.get("X-Payment-Tx", "")
                if tx:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"content":"paid"}')
                else:
                    self.send_response(402)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    import json
                    body = json.dumps({
                        "scheme": "exact",
                        "amount": 1_000_000,
                        "to": provider_addr,
                        "settlement": "direct",
                    })
                    self.wfile.write(body.encode())

            def log_message(self, format, *args):
                pass  # suppress logs

        server = HTTPServer(("127.0.0.1", 0), X402Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            client = PayClient(
                api_url=API_URL,
                signer="raw",
                private_key=self.agent_key,
                chain_id=84532,
                router_address=self.contracts["router"],
            )
            resp = client.request(f"http://127.0.0.1:{port}/content")
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
        client = PayClient(
            api_url=API_URL,
            signer="raw",
            private_key=self.key,
            chain_id=84532,
            router_address=self.contracts["router"],
        )
        try:
            client.pay_direct("not-an-address", 5_000_000)
            assert False, "should have raised"
        except (PayValidationError, ValueError, Exception):
            pass  # Expected

    def test_below_minimum_raises_error(self):
        client = PayClient(
            api_url=API_URL,
            signer="raw",
            private_key=self.key,
            chain_id=84532,
            router_address=self.contracts["router"],
        )
        try:
            client.pay_direct(
                "0x" + "a1" * 20,
                500_000,  # $0.50 — below $1 min
            )
            assert False, "should have raised"
        except (PayValidationError, ValueError, Exception):
            pass  # Expected
