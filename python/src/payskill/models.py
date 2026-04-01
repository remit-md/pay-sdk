"""Data models for the pay SDK."""

from enum import Enum

from pydantic import BaseModel, Field


class TabStatus(str, Enum):
    """Tab lifecycle states."""

    OPEN = "open"
    CLOSED = "closed"


class DirectPaymentResult(BaseModel):
    """Result of a direct payment."""

    payment_id: str = ""
    tx_hash: str | None = None
    status: str = "confirmed"
    amount: int = Field(default=0, description="Amount in USDC micro-units (6 decimals)")
    fee: int = Field(default=0, description="Fee deducted in USDC micro-units")


class Tab(BaseModel):
    """Tab state."""

    tab_id: str
    provider: str
    amount: int = Field(description="Total locked amount in USDC micro-units")
    balance_remaining: int = Field(description="Remaining balance in USDC micro-units")
    total_charged: int = Field(description="Total charged so far in USDC micro-units")
    charge_count: int = Field(description="Number of charges made")
    max_charge_per_call: int = Field(description="Max per-charge limit in USDC micro-units")
    status: TabStatus


class StatusResponse(BaseModel):
    """Wallet status."""

    wallet: str
    balance_usdc: str | None = Field(default=None, description="USDC balance as decimal string")
    open_tabs: int = Field(default=0)
    total_locked: int = Field(default=0)

    @property
    def address(self) -> str:
        """Alias for wallet (backwards compat)."""
        return self.wallet

    @property
    def balance(self) -> int:
        """Balance in micro-units (backwards compat). Server returns raw micro-units."""
        if self.balance_usdc is None:
            return 0
        return int(float(self.balance_usdc))


class WebhookRegistration(BaseModel):
    """Registered webhook."""

    id: str
    url: str
    events: list[str]

    @property
    def webhook_id(self) -> str:
        """Alias for backwards compat."""
        return self.id
