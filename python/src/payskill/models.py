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
    """Tab state. Handles both OpenTabResponse and TabSummary server formats."""

    # OpenTabResponse uses tab_id; TabSummary uses id
    tab_id: str = ""
    id: str = ""
    provider: str = ""
    agent: str = ""
    amount: int = Field(default=0, description="Total locked amount in USDC micro-units")
    balance: int = Field(default=0, description="Remaining balance (OpenTabResponse)")
    balance_remaining: int = Field(default=0, description="Remaining balance (TabSummary)")
    total_charged: int = Field(default=0, description="Total charged so far")
    charge_count: int = Field(default=0, description="Number of charges made")
    max_charge_per_call: int = Field(default=0, description="Max per-charge limit")
    activation_fee: int = Field(default=0, description="Activation fee charged")
    tx_hash: str | None = None
    total_withdrawn: int = Field(default=0, description="Total withdrawn so far")
    status: str = "open"
    auto_close_after: str | None = None
    pending_charge_count: int = Field(default=0, description="Charges buffered awaiting batch settlement")
    pending_charge_total: int = Field(default=0, description="Total pending charge amount in USDC micro-units")
    effective_balance: int = Field(default=0, description="balance_remaining minus pending charges")

    @property
    def effective_tab_id(self) -> str:
        """Return whichever ID field is populated."""
        return self.tab_id or self.id


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
