"""pay SDK — payment infrastructure for AI agents."""

from __future__ import annotations

from typing import Any

from payskill.auth import build_auth_headers, derive_address
from payskill.client import PayClient
from payskill.errors import PayError, PayNetworkError, PayValidationError
from payskill.models import DirectPaymentResult, PaymentRequired, PaymentRequirementsV2, Tab, TabStatus

# OWS signer is optional — only available if open-wallet-standard is installed.
OwsSigner: Any
try:
    from payskill.ows_signer import OwsSigner
except ImportError:
    OwsSigner = None

__all__ = [
    "PayClient",
    "PayError",
    "PayNetworkError",
    "PayValidationError",
    "DirectPaymentResult",
    "PaymentRequired",
    "PaymentRequirementsV2",
    "Tab",
    "TabStatus",
    "build_auth_headers",
    "derive_address",
    "OwsSigner",
]
