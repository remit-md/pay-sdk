"""OWS Signer unit tests.

Uses a mock OWS module — no real open-wallet-standard needed.
Tests construction, EIP-712 typed data building, signature concatenation,
error paths, and security (no key leakage).
"""

from __future__ import annotations

import json

import pytest

from payskill.ows_signer import OwsSigner

# ── Mock OWS module ──────────────────────────────────────────────────


class MockOws:
    """Fake OWS module for unit testing."""

    def __init__(
        self,
        accounts: list[dict[str, str]] | None = None,
        signature: str = "aa" * 64,
        recovery_id: int = 0,
    ):
        self.accounts = (
            accounts
            if accounts is not None
            else [
                {
                    "chain_id": "eip155:8453",
                    "address": "0x1234567890abcdef1234567890abcdef12345678",
                    "derivation_path": "m/44'/60'/0'/0/0",
                }
            ]
        )
        self._signature = signature
        self._recovery_id = recovery_id
        self.calls: list[dict[str, object]] = []

    def get_wallet(self, name_or_id: str) -> dict:
        return {
            "id": f"id-{name_or_id}",
            "name": name_or_id,
            "accounts": self.accounts,
            "created_at": "2026-04-01T00:00:00Z",
        }

    def sign_typed_data(
        self,
        wallet_id: str,
        chain: str,
        typed_data_json: str,
        ows_api_key: str | None = None,
    ) -> dict:
        self.calls.append(
            {
                "wallet": wallet_id,
                "chain": chain,
                "json": typed_data_json,
                "passphrase": ows_api_key,
            }
        )
        return {
            "signature": self._signature,
            "recovery_id": self._recovery_id,
        }


# ── Construction ──────────────────────────────────────────────────────


class TestOwsSignerConstruction:
    def test_creates_with_eip155_chain_id(self):
        mock = MockOws()
        signer = OwsSigner(wallet_id="pay-test", _ows_module=mock)
        assert signer.address == "0x1234567890abcdef1234567890abcdef12345678"

    def test_creates_with_evm_chain_id(self):
        mock = MockOws(
            accounts=[
                {"chain_id": "evm", "address": "0xcafe", "derivation_path": "m/44'/60'/0'/0/0"}
            ]
        )
        signer = OwsSigner(wallet_id="pay-evm", _ows_module=mock)
        assert signer.address == "0xcafe"

    def test_throws_when_no_evm_account(self):
        mock = MockOws(
            accounts=[
                {"chain_id": "solana", "address": "Sol123", "derivation_path": "m/44'/501'/0'/0'"}
            ]
        )
        with pytest.raises(ValueError, match="No EVM account found"):
            OwsSigner(wallet_id="pay-sol", _ows_module=mock)

    def test_throws_when_no_accounts(self):
        mock = MockOws(accounts=[])
        with pytest.raises(ValueError, match="No EVM account found"):
            OwsSigner(wallet_id="pay-empty", _ows_module=mock)

    def test_throws_when_ows_not_installed(self):
        with pytest.raises(ImportError, match="not installed"):
            # Without _ows_module, constructor tries to import `ows`
            OwsSigner(wallet_id="pay-missing")


# ── sign_typed_data ───────────────────────────────────────────────────


class TestSignTypedData:
    DOMAIN: dict = {
        "name": "Pay",
        "version": "1",
        "chainId": 8453,
        "verifyingContract": "0xrouter",
    }
    TYPES: dict = {
        "Request": [
            {"name": "method", "type": "string"},
            {"name": "path", "type": "string"},
        ]
    }
    VALUE: dict = {"method": "POST", "path": "/api/v1/direct"}

    @pytest.fixture()
    def signer_and_mock(self):
        mock = MockOws()
        signer = OwsSigner(wallet_id="pay-test", _ows_module=mock)
        return signer, mock

    @pytest.mark.asyncio()
    async def test_builds_eip712_json_with_domain_type(self, signer_and_mock):
        signer, mock = signer_and_mock
        await signer.sign_typed_data(self.DOMAIN, self.TYPES, self.VALUE)

        assert len(mock.calls) == 1
        parsed = json.loads(mock.calls[0]["json"])

        # EIP712Domain auto-generated from domain fields
        assert parsed["types"]["EIP712Domain"] == [
            {"name": "name", "type": "string"},
            {"name": "version", "type": "string"},
            {"name": "chainId", "type": "uint256"},
            {"name": "verifyingContract", "type": "address"},
        ]

        # Original types preserved
        assert parsed["types"]["Request"] == self.TYPES["Request"]

        # Primary type derived from first non-EIP712Domain key
        assert parsed["primaryType"] == "Request"

        # Domain and message passed through
        assert parsed["domain"] == self.DOMAIN
        assert parsed["message"] == self.VALUE

    @pytest.mark.asyncio()
    async def test_passes_chain_as_evm(self, signer_and_mock):
        signer, mock = signer_and_mock
        await signer.sign_typed_data(self.DOMAIN, self.TYPES, self.VALUE)
        assert mock.calls[0]["chain"] == "evm"

    @pytest.mark.asyncio()
    async def test_passes_api_key_as_passphrase(self):
        mock = MockOws()
        signer = OwsSigner(wallet_id="pay-test", ows_api_key="ows_key_secret123", _ows_module=mock)
        await signer.sign_typed_data(self.DOMAIN, self.TYPES, self.VALUE)

        test_key = "ows_key_secret123"  # noqa: S105
        assert mock.calls[0]["passphrase"] == test_key
        # API key must NOT appear in the JSON payload
        assert test_key not in mock.calls[0]["json"]

    @pytest.mark.asyncio()
    async def test_only_includes_present_domain_fields(self):
        mock = MockOws()
        signer = OwsSigner(wallet_id="pay-test", _ows_module=mock)

        # Domain with only name and chainId
        await signer.sign_typed_data({"name": "Pay", "chainId": 8453}, self.TYPES, self.VALUE)

        parsed = json.loads(mock.calls[0]["json"])
        assert parsed["types"]["EIP712Domain"] == [
            {"name": "name", "type": "string"},
            {"name": "chainId", "type": "uint256"},
        ]


# ── Signature concatenation ──────────────────────────────────────────


class TestSignatureConcatenation:
    @pytest.mark.asyncio()
    async def test_appends_v27_when_recovery_id_0(self):
        mock = MockOws(signature="aa" * 64, recovery_id=0)
        signer = OwsSigner(wallet_id="pay-test", _ows_module=mock)

        sig = await signer.sign_typed_data({}, {"R": []}, {})
        assert sig.startswith("0x")
        assert len(sig) == 2 + 130  # 0x + 64r + 64s + 2v
        assert sig[-2:] == "1b"  # 27 = 0x1b

    @pytest.mark.asyncio()
    async def test_appends_v28_when_recovery_id_1(self):
        mock = MockOws(signature="bb" * 64, recovery_id=1)
        signer = OwsSigner(wallet_id="pay-test", _ows_module=mock)

        sig = await signer.sign_typed_data({}, {"R": []}, {})
        assert sig[-2:] == "1c"  # 28 = 0x1c

    @pytest.mark.asyncio()
    async def test_passthrough_130_char_rsv(self):
        rsv = "cc" * 65  # 130 hex = already has v
        mock = MockOws(signature=rsv)
        signer = OwsSigner(wallet_id="pay-test", _ows_module=mock)

        sig = await signer.sign_typed_data({}, {"R": []}, {})
        assert sig == f"0x{rsv}"

    @pytest.mark.asyncio()
    async def test_strips_0x_prefix(self):
        mock = MockOws(signature="0x" + "dd" * 64, recovery_id=0)
        signer = OwsSigner(wallet_id="pay-test", _ows_module=mock)

        sig = await signer.sign_typed_data({}, {"R": []}, {})
        assert "0x0x" not in sig
        assert len(sig) == 2 + 130

    @pytest.mark.asyncio()
    async def test_defaults_recovery_id_to_0(self):
        mock = MockOws(signature="ee" * 64)
        # Override recovery_id to None to test default
        original_sign = mock.sign_typed_data

        def sign_no_recovery(*args, **kwargs):
            result = original_sign(*args, **kwargs)
            result["recovery_id"] = None
            return result

        mock.sign_typed_data = sign_no_recovery  # type: ignore[assignment]

        signer = OwsSigner(wallet_id="pay-test", _ows_module=mock)
        sig = await signer.sign_typed_data({}, {"R": []}, {})
        assert sig[-2:] == "1b"  # v=27


# ── sign() rejection ─────────────────────────────────────────────────


class TestSignRawHashRejection:
    def test_throws_not_implemented(self):
        mock = MockOws()
        signer = OwsSigner(wallet_id="pay-test", _ows_module=mock)
        with pytest.raises(NotImplementedError, match="does not support sign"):
            signer.sign(b"\x00" * 32)


# ── Security ─────────────────────────────────────────────────────────


class TestSecurity:
    def test_repr_does_not_expose_api_key(self):
        mock = MockOws()
        signer = OwsSigner(wallet_id="pay-test", ows_api_key="ows_key_topsecret", _ows_module=mock)
        output = repr(signer)
        assert "topsecret" not in output
        assert "pay-test" in output

    def test_str_does_not_expose_api_key(self):
        mock = MockOws()
        signer = OwsSigner(wallet_id="pay-test", ows_api_key="ows_key_topsecret", _ows_module=mock)
        output = str(signer)
        assert "topsecret" not in output
