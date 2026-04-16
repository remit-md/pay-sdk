"""Keychain integration tests -- prove Wallet.create() reads from real OS keychain.

Requires: gnome-keyring + dbus session on Linux.
Run via: dbus-run-session -- bash -c 'echo "" | gnome-keyring-daemon --unlock && pytest tests/test_keychain.py -v'

Skips gracefully when keyring is not installed or Secret Service is unavailable.
"""

from __future__ import annotations

import pytest

TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"


@pytest.fixture()
def keyring_mod():
    """Import keyring or skip the test."""
    try:
        import keyring  # type: ignore[import-untyped]
    except ImportError:
        pytest.skip("keyring not installed")

    # Probe: verify Secret Service is actually reachable
    try:
        keyring.set_password("pay-test-probe", "probe", "1")
        keyring.delete_password("pay-test-probe", "probe")
    except Exception:
        pytest.skip("OS keychain not available (no Secret Service)")

    return keyring


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove PAYSKILL_KEY so Wallet.create() must use keychain."""
    monkeypatch.delenv("PAYSKILL_KEY", raising=False)


class TestKeychainIntegration:
    def test_wallet_create_reads_from_keychain(self, keyring_mod: object) -> None:
        """Wallet.create() retrieves key stored by CLI in OS keychain."""
        import keyring  # type: ignore[import-untyped]

        from payskill.wallet import Wallet

        keyring.set_password("pay", "default", TEST_KEY)
        try:
            w = Wallet.create(testnet=True)
            assert w.address.lower() == TEST_ADDRESS.lower()
            w.close()
        finally:
            keyring.delete_password("pay", "default")

    def test_keychain_preferred_over_env(
        self, keyring_mod: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Keychain key wins over PAYSKILL_KEY env var."""
        import keyring  # type: ignore[import-untyped]

        from payskill.wallet import Wallet

        different_key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
        monkeypatch.setenv("PAYSKILL_KEY", different_key)

        keyring.set_password("pay", "default", TEST_KEY)
        try:
            w = Wallet.create(testnet=True)
            assert w.address.lower() == TEST_ADDRESS.lower()
            w.close()
        finally:
            keyring.delete_password("pay", "default")

    def test_fallback_to_env_when_no_entry(
        self, keyring_mod: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Wallet.create() falls back to env var when keychain has no entry."""
        import keyring  # type: ignore[import-untyped]

        from payskill.wallet import Wallet

        try:
            keyring.delete_password("pay", "default")
        except keyring.errors.PasswordDeleteError:
            pass  # already absent

        monkeypatch.setenv("PAYSKILL_KEY", TEST_KEY)
        w = Wallet.create(testnet=True)
        assert w.address.lower() == TEST_ADDRESS.lower()
        w.close()
