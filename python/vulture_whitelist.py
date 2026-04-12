# Vulture whitelist -- suppress false positives for publicly-exported symbols,
# dataclass fields, and pytest framework variables.

# pytest markers (used by pytest framework, not direct code references)
pytestmark  # noqa

# Public SDK API -- exported from __init__.py
discover  # noqa
Balance  # noqa
ChargeResult  # noqa
DiscoverService  # noqa
MintResult  # noqa
SendResult  # noqa
Status  # noqa
Tab  # noqa
WebhookRegistration  # noqa
PayInsufficientFundsError  # noqa

# Dataclass fields used via deserialization / external access
total_charged  # noqa
total_withdrawn  # noqa
pending_charge_count  # noqa
pending_charge_total  # noqa
effective_balance  # noqa
description  # noqa
base_url  # noqa
keywords  # noqa
routes  # noqa
docs_url  # noqa

# DiscoverOptions class (used internally for type clarity)
DiscoverOptions  # noqa

# Wallet.from_ows factory method
from_ows  # noqa

# Test fixtures
TEST_ADDRESS  # noqa
return_value  # noqa
