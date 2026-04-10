# Vulture whitelist — suppress false positives for fields used via deserialization
# and pytest framework variables.

# Pydantic model fields (populated via API JSON deserialization)
payment_id  # noqa
total_charged  # noqa
activation_fee  # noqa
total_withdrawn  # noqa
auto_close_after  # noqa
pending_charge_count  # noqa
pending_charge_total  # noqa
effective_balance  # noqa
effective_tab_id  # noqa
total_locked  # noqa

# pytest markers (used by pytest framework, not direct code references)
pytestmark  # noqa

# Dummy signer callback params (intentionally unused — returns fixed bytes)
h  # noqa

# OWS signer stores chain for future use in signing context
_chain  # noqa

# Public SDK API — mirrors TypeScript SDK surface
discover  # noqa
