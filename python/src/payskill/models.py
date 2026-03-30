"""Data models for the pay SDK."""

from enum import Enum

from pydantic import BaseModel, Field


class TabStatus(str, Enum):
    """Tab lifecycle states."""

    OPEN = "open"
    CLOSED = "closed"


class DirectPaymentResult(BaseModel):
    """Result of a direct payment."""

    tx_hash: str
    status: str = "confirmed"
    amount: int = Field(description="Amount in USDC micro-units (6 decimals)")
    fee: int = Field(description="Fee deducted in USDC micro-units")


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

    address: str
    balance: int = Field(description="USDC balance in micro-units")
    open_tabs: list[Tab] = Field(default_factory=list)


class WebhookRegistration(BaseModel):
    """Registered webhook."""

    webhook_id: str
    url: str
    events: list[str]
