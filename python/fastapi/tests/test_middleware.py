"""Tests for payskill-fastapi middleware.

Unit tests use FastAPI's TestClient (no running server needed) and a
local mock facilitator server for verify calls.
"""

from __future__ import annotations

import base64
import json
import threading
import time
from collections.abc import Generator
from typing import Any

import httpx
import pytest
import uvicorn
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from payskill_fastapi import PaymentInfo, PayMiddleware, require_payment

# -- Mock facilitator ---------------------------------------------------------

_facilitator_behavior = {"mode": "valid"}


def _make_facilitator_app() -> FastAPI:
    app = FastAPI()

    @app.post("/verify")
    async def verify(request: Request) -> Any:
        mode = _facilitator_behavior["mode"]
        if mode == "valid":
            return {"isValid": True, "payer": "0x" + "cc" * 20}
        if mode == "invalid":
            return {"isValid": False, "invalidReason": "insufficient funds"}
        if mode == "error":
            from fastapi.responses import JSONResponse

            return JSONResponse({"error": "internal"}, status_code=500)
        return {"isValid": False}

    return app


class _FacilitatorServer:
    """Spin a facilitator on a background thread using uvicorn."""

    def __init__(self) -> None:
        self.app = _make_facilitator_app()
        self.server: uvicorn.Server | None = None
        self.thread: threading.Thread | None = None
        self.port = 0

    def start(self) -> None:
        import socket

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()

        config = uvicorn.Config(
            self.app,
            host="127.0.0.1",
            port=self.port,
            log_level="error",
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        # Wait for server to come up
        for _ in range(50):
            try:
                httpx.get(f"http://127.0.0.1:{self.port}/verify", timeout=0.1)
                return
            except httpx.HTTPError:
                time.sleep(0.05)
        raise RuntimeError("Facilitator server failed to start")

    def stop(self) -> None:
        if self.server:
            self.server.should_exit = True
        if self.thread:
            self.thread.join(timeout=2)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


@pytest.fixture(scope="module")
def facilitator() -> Generator[_FacilitatorServer, None, None]:
    server = _FacilitatorServer()
    server.start()
    yield server
    server.stop()


# -- Helpers ------------------------------------------------------------------


def _make_payment_signature() -> str:
    payload = {
        "x402Version": 2,
        "accepted": {
            "scheme": "exact",
            "network": "eip155:8453",
            "amount": "10000",
        },
        "payload": {"signature": "0x" + "ab" * 65},
        "extensions": {},
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()


# =============================================================================
# require_payment (provider) tests
# =============================================================================


class TestRequirePaymentNoHeader:
    def test_returns_402_without_header(self, facilitator: _FacilitatorServer) -> None:
        app = FastAPI()

        @app.get("/api/data")
        async def get_data(
            payment: PaymentInfo = Depends(
                require_payment(
                    price=0.01,
                    settlement="tab",
                    provider_address="0x" + "bb" * 20,
                    facilitator_url=facilitator.url,
                )
            ),
        ) -> Any:
            return {"data": "premium", "from": payment.from_address}

        client = TestClient(app)
        resp = client.get("/api/data")
        assert resp.status_code == 402

        pr_header = resp.headers.get("payment-required")
        assert pr_header, "PAYMENT-REQUIRED header must be present"

        decoded = json.loads(base64.b64decode(pr_header).decode())
        assert decoded["x402Version"] == 2
        assert len(decoded["accepts"]) == 1
        assert decoded["accepts"][0]["amount"] == "10000"
        assert decoded["accepts"][0]["extra"]["settlement"] == "tab"

        body = resp.json()
        assert body["detail"]["error"] == "payment_required"

    def test_amount_encoding_for_different_prices(self, facilitator: _FacilitatorServer) -> None:
        app = FastAPI()

        @app.get("/api/report")
        async def get_report(
            payment: PaymentInfo = Depends(
                require_payment(
                    price=2.5,
                    settlement="direct",
                    provider_address="0x" + "bb" * 20,
                    facilitator_url=facilitator.url,
                )
            ),
        ) -> Any:
            return {"report": "done"}

        client = TestClient(app)
        resp = client.get("/api/report")
        assert resp.status_code == 402

        pr_header = resp.headers.get("payment-required")
        decoded = json.loads(base64.b64decode(pr_header).decode())
        assert decoded["accepts"][0]["amount"] == "2500000"
        assert decoded["accepts"][0]["extra"]["settlement"] == "direct"


class TestRequirePaymentValid:
    def test_passes_through_with_payment_info(self, facilitator: _FacilitatorServer) -> None:
        _facilitator_behavior["mode"] = "valid"
        app = FastAPI()

        @app.get("/api/data")
        async def get_data(
            payment: PaymentInfo = Depends(
                require_payment(
                    price=0.01,
                    settlement="tab",
                    provider_address="0x" + "bb" * 20,
                    facilitator_url=facilitator.url,
                )
            ),
        ) -> Any:
            return {
                "paid_by": payment.from_address,
                "amount": payment.amount,
                "settlement": payment.settlement,
                "verified": payment.verified,
            }

        client = TestClient(app)
        resp = client.get(
            "/api/data",
            headers={"payment-signature": _make_payment_signature()},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["paid_by"] == "0x" + "cc" * 20
        assert body["amount"] == 10000
        assert body["settlement"] == "tab"
        assert body["verified"] is True


class TestRequirePaymentInvalid:
    def test_returns_402_on_invalid_payment(self, facilitator: _FacilitatorServer) -> None:
        _facilitator_behavior["mode"] = "invalid"
        app = FastAPI()

        @app.get("/api/data")
        async def get_data(
            payment: PaymentInfo = Depends(
                require_payment(
                    price=0.01,
                    settlement="tab",
                    provider_address="0x" + "bb" * 20,
                    facilitator_url=facilitator.url,
                )
            ),
        ) -> Any:
            return {"data": "should not reach"}

        client = TestClient(app)
        resp = client.get(
            "/api/data",
            headers={"payment-signature": _make_payment_signature()},
        )
        assert resp.status_code == 402
        body = resp.json()
        assert "insufficient funds" in body["detail"]["message"]

    def test_returns_402_on_malformed_signature(self, facilitator: _FacilitatorServer) -> None:
        app = FastAPI()

        @app.get("/api/data")
        async def get_data(
            payment: PaymentInfo = Depends(
                require_payment(
                    price=0.01,
                    settlement="tab",
                    provider_address="0x" + "bb" * 20,
                    facilitator_url=facilitator.url,
                )
            ),
        ) -> Any:
            return {"data": "should not reach"}

        client = TestClient(app)
        resp = client.get(
            "/api/data",
            headers={"payment-signature": "not-valid-base64!!!"},
        )
        assert resp.status_code == 402
        body = resp.json()
        assert "decode failed" in body["detail"]["message"]


class TestRequirePaymentFacilitatorDown:
    def test_503_when_unreachable_closed(self) -> None:
        app = FastAPI()

        @app.get("/api/data")
        async def get_data(
            payment: PaymentInfo = Depends(
                require_payment(
                    price=0.01,
                    settlement="tab",
                    provider_address="0x" + "bb" * 20,
                    facilitator_url="http://127.0.0.1:19999",
                    fail_mode="closed",
                )
            ),
        ) -> Any:
            return {"data": "should not reach"}

        client = TestClient(app)
        resp = client.get(
            "/api/data",
            headers={"payment-signature": _make_payment_signature()},
        )
        assert resp.status_code == 503
        body = resp.json()
        assert body["detail"]["error"] == "facilitator_unavailable"

    def test_passthrough_when_unreachable_open(self) -> None:
        app = FastAPI()

        @app.get("/api/data")
        async def get_data(
            payment: PaymentInfo = Depends(
                require_payment(
                    price=0.01,
                    settlement="tab",
                    provider_address="0x" + "bb" * 20,
                    facilitator_url="http://127.0.0.1:19999",
                    fail_mode="open",
                )
            ),
        ) -> Any:
            return {
                "data": "passed through",
                "verified": payment.verified,
            }

        client = TestClient(app)
        resp = client.get(
            "/api/data",
            headers={"payment-signature": _make_payment_signature()},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"] == "passed through"
        assert body["verified"] is True

    def test_402_when_facilitator_returns_500(self, facilitator: _FacilitatorServer) -> None:
        _facilitator_behavior["mode"] = "error"
        app = FastAPI()

        @app.get("/api/data")
        async def get_data(
            payment: PaymentInfo = Depends(
                require_payment(
                    price=0.01,
                    settlement="tab",
                    provider_address="0x" + "bb" * 20,
                    facilitator_url=facilitator.url,
                    fail_mode="closed",
                )
            ),
        ) -> Any:
            return {"data": "should not reach"}

        client = TestClient(app)
        resp = client.get(
            "/api/data",
            headers={"payment-signature": _make_payment_signature()},
        )
        # 500 from facilitator → isValid=False → 402
        assert resp.status_code == 402


class TestRequirePaymentFreeRoute:
    def test_free_route_unaffected(self, facilitator: _FacilitatorServer) -> None:
        app = FastAPI()

        @app.get("/api/health")
        async def health() -> Any:
            return {"ok": True}

        @app.get("/api/data")
        async def get_data(
            payment: PaymentInfo = Depends(
                require_payment(
                    price=0.01,
                    settlement="tab",
                    provider_address="0x" + "bb" * 20,
                    facilitator_url=facilitator.url,
                )
            ),
        ) -> Any:
            return {"data": "premium"}

        client = TestClient(app)
        # Free route - 200
        free_resp = client.get("/api/health")
        assert free_resp.status_code == 200

        # Paid route - 402
        paid_resp = client.get("/api/data")
        assert paid_resp.status_code == 402


# =============================================================================
# PayMiddleware (consumer) tests
# =============================================================================


class TestPayMiddleware:
    def test_attaches_pay_context(self) -> None:
        """request.state.pay has fetch and wallet."""
        from payskill import Wallet

        # Use a dummy wallet - we don't make real calls in this test
        test_key = "0x" + "ab" * 32
        wallet = Wallet(private_key=test_key, testnet=True)

        app = FastAPI()
        app.add_middleware(PayMiddleware, wallet=wallet)

        @app.get("/test")
        async def test_route(request: Request) -> Any:
            pay = request.state.pay
            return {
                "has_fetch": callable(pay.fetch),
                "has_wallet": pay.wallet is not None,
                "wallet_address": pay.wallet.address,
            }

        client = TestClient(app)
        resp = client.get("/test")
        assert resp.status_code == 200
        body = resp.json()
        assert body["has_fetch"] is True
        assert body["has_wallet"] is True
        assert body["wallet_address"].startswith("0x")

        wallet.close()

    def test_accepts_budget_options(self) -> None:
        """Middleware accepts max_per_request and max_total options."""
        from payskill import Wallet

        test_key = "0x" + "ab" * 32
        wallet = Wallet(private_key=test_key, testnet=True)

        app = FastAPI()
        app.add_middleware(
            PayMiddleware,
            wallet=wallet,
            max_per_request=1.00,
            max_total=50.00,
        )

        @app.get("/test")
        async def test_route(request: Request) -> Any:
            pay = request.state.pay
            return {"total_spent": pay.fetch.total_spent}

        client = TestClient(app)
        resp = client.get("/test")
        assert resp.status_code == 200
        assert resp.json()["total_spent"] == 0

        wallet.close()
