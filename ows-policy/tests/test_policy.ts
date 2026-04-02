/**
 * OWS Policy Engine tests.
 *
 * Tests the evaluate() function and decodeUsdcAmount() helper.
 * All rules: chain lock, contract allowlist, per-tx USDC cap, daily USDC cap.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluate,
  decodeUsdcAmount,
  type PolicyContext,
  type PolicyConfig,
} from "../src/pay-policy.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    chain_id: "eip155:8453",
    wallet_id: "pay-test",
    api_key_id: "key-test",
    transaction: {
      to: "0x1234567890abcdef1234567890abcdef12345678",
      value: "0",
      data: "0x",
      raw_hex: "0x",
    },
    spending: {
      daily_total: "0",
      date: "2026-04-01",
    },
    timestamp: "2026-04-01T12:00:00Z",
    policy_config: {},
    ...overrides,
  };
}

// ERC-20 transfer(address,uint256) calldata for $5 USDC (5_000_000 base units)
const TRANSFER_5_USDC =
  "0xa9059cbb" +
  "0000000000000000000000001234567890abcdef1234567890abcdef12345678" +
  "00000000000000000000000000000000000000000000000000000000004c4b40";

// ERC-20 approve(address,uint256) calldata for $100 USDC
const APPROVE_100_USDC =
  "0x095ea7b3" +
  "0000000000000000000000001234567890abcdef1234567890abcdef12345678" +
  "0000000000000000000000000000000000000000000000000000000005f5e100";

// transferFrom(from,to,uint256) calldata for $10 USDC
const TRANSFER_FROM_10_USDC =
  "0x23b872dd" +
  "000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
  "000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" +
  "0000000000000000000000000000000000000000000000000000000000989680";

// ── decodeUsdcAmount ─────────────────────────────────────────────────

describe("decodeUsdcAmount", () => {
  it("decodes transfer amount", () => {
    const amount = decodeUsdcAmount(TRANSFER_5_USDC);
    assert.equal(amount, 5_000_000n);
  });

  it("decodes approve amount", () => {
    const amount = decodeUsdcAmount(APPROVE_100_USDC);
    assert.equal(amount, 100_000_000n);
  });

  it("decodes transferFrom amount", () => {
    const amount = decodeUsdcAmount(TRANSFER_FROM_10_USDC);
    assert.equal(amount, 10_000_000n);
  });

  it("returns null for empty data", () => {
    assert.equal(decodeUsdcAmount(""), null);
    assert.equal(decodeUsdcAmount("0x"), null);
  });

  it("returns null for unknown selector", () => {
    assert.equal(decodeUsdcAmount("0xdeadbeef" + "00".repeat(64)), null);
  });

  it("returns null for truncated data", () => {
    assert.equal(decodeUsdcAmount("0xa9059cbb" + "00".repeat(10)), null);
  });

  it("decodes zero amount", () => {
    const data =
      "0xa9059cbb" +
      "0000000000000000000000001234567890abcdef1234567890abcdef12345678" +
      "0000000000000000000000000000000000000000000000000000000000000000";
    assert.equal(decodeUsdcAmount(data), 0n);
  });
});

// ── Rule 1: Chain lock ───────────────────────────────────────────────

describe("Rule 1: Chain lock", () => {
  it("allows when chain is in allowed list", () => {
    const ctx = makeContext({
      chain_id: "eip155:8453",
      policy_config: { chain_ids: ["eip155:8453"] },
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("denies when chain is not in allowed list", () => {
    const ctx = makeContext({
      chain_id: "eip155:1",
      policy_config: { chain_ids: ["eip155:8453"] },
    });
    const result = evaluate(ctx);
    assert.equal(result.allow, false);
    assert.ok(result.reason?.includes("not in allowed chains"));
  });

  it("skips when no chain_ids configured", () => {
    const ctx = makeContext({ policy_config: {} });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("denies when chain_id missing in context", () => {
    const ctx = makeContext({
      chain_id: "",
      policy_config: { chain_ids: ["eip155:8453"] },
    });
    const result = evaluate(ctx);
    assert.equal(result.allow, false);
  });
});

// ── Rule 2: Contract allowlist ───────────────────────────────────────

describe("Rule 2: Contract allowlist", () => {
  it("allows when contract is in allowlist", () => {
    const ctx = makeContext({
      transaction: {
        to: "0xABCD",
        value: "0",
        data: "0x",
        raw_hex: "0x",
      },
      policy_config: { allowed_contracts: ["0xabcd"] },
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("denies when contract is not in allowlist", () => {
    const ctx = makeContext({
      transaction: {
        to: "0xDEAD",
        value: "0",
        data: "0x",
        raw_hex: "0x",
      },
      policy_config: { allowed_contracts: ["0xBEEF"] },
    });
    const result = evaluate(ctx);
    assert.equal(result.allow, false);
    assert.ok(result.reason?.includes("not in allowed contracts"));
  });

  it("is case-insensitive", () => {
    const ctx = makeContext({
      transaction: {
        to: "0xAbCd",
        value: "0",
        data: "0x",
        raw_hex: "0x",
      },
      policy_config: { allowed_contracts: ["0xABCD"] },
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("skips when no allowed_contracts configured", () => {
    const ctx = makeContext({ policy_config: {} });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("denies when transaction target missing", () => {
    const ctx = makeContext({
      transaction: { to: "", value: "0", data: "0x", raw_hex: "0x" },
      policy_config: { allowed_contracts: ["0xABCD"] },
    });
    const result = evaluate(ctx);
    assert.equal(result.allow, false);
  });
});

// ── Rule 3: Per-tx USDC cap ─────────────────────────────────────────

describe("Rule 3: Per-tx USDC cap", () => {
  it("allows when amount under limit", () => {
    const ctx = makeContext({
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: TRANSFER_5_USDC,
        raw_hex: "0x",
      },
      policy_config: { max_tx_usdc: 10 },
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("denies when amount exceeds limit", () => {
    const ctx = makeContext({
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: APPROVE_100_USDC,
        raw_hex: "0x",
      },
      policy_config: { max_tx_usdc: 50 },
    });
    const result = evaluate(ctx);
    assert.equal(result.allow, false);
    assert.ok(result.reason?.includes("exceeds per-tx limit"));
  });

  it("allows when amount equals limit", () => {
    const ctx = makeContext({
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: TRANSFER_5_USDC,
        raw_hex: "0x",
      },
      policy_config: { max_tx_usdc: 5 },
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("skips when no max_tx_usdc configured", () => {
    const ctx = makeContext({
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: APPROVE_100_USDC,
        raw_hex: "0x",
      },
      policy_config: {},
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("skips for unknown calldata selector", () => {
    const ctx = makeContext({
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: "0xdeadbeef" + "00".repeat(64),
        raw_hex: "0x",
      },
      policy_config: { max_tx_usdc: 1 },
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("denies on negative limit config", () => {
    const ctx = makeContext({
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: TRANSFER_5_USDC,
        raw_hex: "0x",
      },
      policy_config: { max_tx_usdc: -1 },
    });
    const result = evaluate(ctx);
    assert.equal(result.allow, false);
    assert.ok(result.reason?.includes("Invalid max_tx_usdc"));
  });
});

// ── Rule 4: Daily USDC cap ──────────────────────────────────────────

describe("Rule 4: Daily USDC cap", () => {
  it("allows when projected daily total under limit", () => {
    const ctx = makeContext({
      spending: { daily_total: "0", date: "2026-04-01" },
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: TRANSFER_5_USDC,
        raw_hex: "0x",
      },
      policy_config: { daily_limit_usdc: 100 },
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("denies when projected daily total exceeds limit", () => {
    const ctx = makeContext({
      spending: { daily_total: "96000000", date: "2026-04-01" }, // $96 already spent
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: TRANSFER_5_USDC, // +$5
        raw_hex: "0x",
      },
      policy_config: { daily_limit_usdc: 100 }, // limit $100
    });
    const result = evaluate(ctx);
    assert.equal(result.allow, false);
    assert.ok(result.reason?.includes("exceeding limit"));
  });

  it("allows when projected daily total equals limit exactly", () => {
    const ctx = makeContext({
      spending: { daily_total: "95000000", date: "2026-04-01" }, // $95
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: TRANSFER_5_USDC, // +$5 = $100
        raw_hex: "0x",
      },
      policy_config: { daily_limit_usdc: 100 },
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("skips when no daily_limit_usdc configured", () => {
    const ctx = makeContext({
      spending: { daily_total: "999999999999", date: "2026-04-01" },
      policy_config: {},
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("denies on invalid daily_total string", () => {
    const ctx = makeContext({
      spending: { daily_total: "not-a-number", date: "2026-04-01" },
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: TRANSFER_5_USDC,
        raw_hex: "0x",
      },
      policy_config: { daily_limit_usdc: 100 },
    });
    const result = evaluate(ctx);
    assert.equal(result.allow, false);
    assert.ok(result.reason?.includes("not a valid integer"));
  });
});

// ── Combined rules ──────────────────────────────────────────────────

describe("Combined rules", () => {
  it("denies on first failing rule (chain > contract > spending)", () => {
    const ctx = makeContext({
      chain_id: "eip155:1", // Wrong chain
      transaction: {
        to: "0xBEEF", // Also wrong contract
        value: "0",
        data: APPROVE_100_USDC, // Also over limit
        raw_hex: "0x",
      },
      policy_config: {
        chain_ids: ["eip155:8453"],
        allowed_contracts: ["0xDEAD"],
        max_tx_usdc: 10,
      },
    });
    const result = evaluate(ctx);
    assert.equal(result.allow, false);
    // Should fail on chain lock (first rule)
    assert.ok(result.reason?.includes("not in allowed chains"));
  });

  it("allows when all rules pass", () => {
    const ctx = makeContext({
      chain_id: "eip155:8453",
      transaction: {
        to: "0xABCD",
        value: "0",
        data: TRANSFER_5_USDC,
        raw_hex: "0x",
      },
      spending: { daily_total: "0", date: "2026-04-01" },
      policy_config: {
        chain_ids: ["eip155:8453"],
        allowed_contracts: ["0xabcd"],
        max_tx_usdc: 100,
        daily_limit_usdc: 1000,
      },
    });
    assert.equal(evaluate(ctx).allow, true);
  });

  it("allows when all rules disabled (empty config)", () => {
    const ctx = makeContext({ policy_config: {} });
    assert.equal(evaluate(ctx).allow, true);
  });
});

// ── Determinism ─────────────────────────────────────────────────────

describe("Determinism", () => {
  it("same input always produces same output", () => {
    const ctx = makeContext({
      chain_id: "eip155:8453",
      policy_config: { chain_ids: ["eip155:8453"], max_tx_usdc: 10 },
      transaction: {
        to: "0xUSDC",
        value: "0",
        data: TRANSFER_5_USDC,
        raw_hex: "0x",
      },
    });

    const results = Array.from({ length: 100 }, () => evaluate(ctx));
    assert.ok(results.every((r) => r.allow === true));
  });
});
