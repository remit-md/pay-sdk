"""pay SDK — payment infrastructure for AI agents."""

from payskill.auth import build_auth_headers, derive_address
from payskill.client import PayClient
from payskill.errors import PayError, PayNetworkError, PayValidationError
from payskill.models import DirectPaymentResult, Tab, TabStatus

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
    "Tab",
    "TabStatus",
    "build_auth_headers",
    "derive_address",
    "OwsSigner",
]
