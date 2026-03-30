# pay-sdk

Python + TypeScript SDKs for pay.

## Reference
- Remit SDKs: `C:\Users\jj\sdk\` (frozen, reference only — 9 languages)
- Dev guide: `C:\Users\jj\payskill\spec\guides\SDK.md`
- General guide: `C:\Users\jj\payskill\spec\guides\GENERAL.md`
- Project spec: `C:\Users\jj\payskill\spec\CLAUDE.md`

## Quick Rules
- Python 3.10+, type hints, ruff linting
- TypeScript strict mode, ESM, no `any`
- Both SDKs must have identical API surfaces
- SDK signs hashes only — server prepares EIP-712 typed data
- No float math for amounts. USDC 6 decimals. Integers only.
- No hallucinated APIs — read server routes before writing SDK methods
- Default API URL: `https://pay-skill.com/api/v1` (configurable)
- Three signer modes: CLI signer (default), raw key (dev), custom callback
- VERSION file at root, bump via PR before publish
- x402 request() handles tab-or-direct transparently
