/**
 * Drop-in fetch() wrapper that handles x402 payments automatically.
 *
 * Two ways to use it:
 *
 * 1. **Named wrapper** — inject into any SDK that accepts custom fetch:
 *    ```ts
 *    import { Wallet, createPayFetch } from "@pay-skill/sdk";
 *    const wallet = await Wallet.create();
 *    const payFetch = createPayFetch(wallet);
 *
 *    // Inject into OpenAI, Anthropic, Vercel AI SDK, etc.
 *    import OpenAI from "openai";
 *    const openai = new OpenAI({ fetch: payFetch });
 *    ```
 *
 * 2. **Global patch** — every fetch() in the process handles 402:
 *    ```ts
 *    import { Wallet, register } from "@pay-skill/sdk";
 *    const wallet = await Wallet.create();
 *    const unregister = register(wallet);
 *    ```
 *
 * @module
 */

import type { Wallet } from "./wallet.js";
import { PayBudgetExceededError } from "./errors.js";

// ── Types ─────────────────────────────────────────────────────────────

/** Budget and behavior options for createPayFetch. */
export interface PayFetchOptions {
  /**
   * Maximum dollars to pay for a single 402 settlement.
   * Requests exceeding this throw PayBudgetExceededError.
   * Default: no limit.
   */
  maxPerRequest?: number;

  /**
   * Maximum total dollars across all settlements in this wrapper's lifetime.
   * Default: no limit.
   */
  maxTotal?: number;

  /**
   * Called after each successful x402 payment.
   * Use for logging, observability, or UI updates.
   */
  onPayment?: (event: PaymentEvent) => void;
}

/** Metadata emitted after each successful x402 settlement. */
export interface PaymentEvent {
  /** The URL that required payment. */
  url: string;
  /** Dollar amount paid. */
  amount: number;
  /** How the payment was settled. */
  settlement: "direct" | "tab" | string;
}

// ── Implementation ────────────────────────────────────────────────────

/**
 * Create a fetch-compatible function that automatically settles
 * x402 (HTTP 402) responses using the provided wallet.
 *
 * The returned function has the exact same signature as `globalThis.fetch`.
 * Non-402 responses pass through untouched. When a 402 is received,
 * the wallet handles payment (tab or direct) and retries the request.
 *
 * @param wallet - A configured Wallet instance
 * @param options - Budget limits and callbacks
 * @returns A function with the same signature as fetch()
 *
 * @example Inject into OpenAI SDK
 * ```ts
 * import { Wallet, createPayFetch } from "@pay-skill/sdk";
 * import OpenAI from "openai";
 *
 * const wallet = await Wallet.create();
 * const payFetch = createPayFetch(wallet, { maxTotal: 10.00 });
 * const openai = new OpenAI({ fetch: payFetch });
 * ```
 *
 * @example Inject into Anthropic SDK
 * ```ts
 * import { Wallet, createPayFetch } from "@pay-skill/sdk";
 * import Anthropic from "@anthropic-ai/sdk";
 *
 * const wallet = await Wallet.create();
 * const client = new Anthropic({ fetch: createPayFetch(wallet) });
 * ```
 *
 * @example Standalone with budget controls
 * ```ts
 * const payFetch = createPayFetch(wallet, {
 *   maxPerRequest: 1.00,
 *   maxTotal: 50.00,
 *   onPayment: ({ url, amount, settlement }) => {
 *     console.log(`Paid $${amount} via ${settlement} for ${url}`);
 *   },
 * });
 *
 * const resp = await payFetch("https://api.example.com/data");
 * ```
 */
export function createPayFetch(
  wallet: Wallet,
  options: PayFetchOptions = {},
): typeof globalThis.fetch {
  const { maxPerRequest, maxTotal, onPayment } = options;
  let totalSpent = 0;

  const payFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // Make the initial request with the native fetch
    const resp = await fetch(input, init);
    if (resp.status !== 402) return resp;

    // Guard: don't retry if we already attached a payment (infinite loop)
    if (init?.headers) {
      const h = new Headers(init.headers);
      if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) {
        return resp; // already tried paying, don't loop
      }
    }

    // Parse the 402 to check budget before committing
    const amountMicro = parse402Amount(resp);
    const amountDollars = amountMicro / 1_000_000;

    if (maxPerRequest !== undefined && amountDollars > maxPerRequest) {
      throw new PayBudgetExceededError(
        `Payment of $${amountDollars.toFixed(2)} exceeds per-request limit of $${maxPerRequest.toFixed(2)}`,
        totalSpent,
        amountDollars,
        "perRequest",
      );
    }

    if (maxTotal !== undefined && totalSpent + amountDollars > maxTotal) {
      throw new PayBudgetExceededError(
        `Payment of $${amountDollars.toFixed(2)} would exceed total budget of $${maxTotal.toFixed(2)} (spent: $${totalSpent.toFixed(2)})`,
        totalSpent,
        amountDollars,
        "total",
      );
    }

    // Normalize input to the args wallet.settle() needs
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Serialize body to string if present (wallet.settle takes string)
    let bodyStr: string | undefined;
    if (init?.body != null) {
      bodyStr =
        typeof init.body === "string"
          ? init.body
          : init.body instanceof ArrayBuffer
            ? new TextDecoder().decode(init.body)
            : init.body instanceof Uint8Array
              ? new TextDecoder().decode(init.body)
              : String(init.body);
    }

    // Flatten headers to Record<string, string>
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
    }

    const result = await wallet.settle(resp, url, {
      method: init?.method,
      body: bodyStr,
      headers,
    });

    totalSpent += amountDollars;
    onPayment?.({
      url,
      amount: amountDollars,
      settlement: result.settlement,
    });

    return result.response;
  };

  return payFetch as typeof globalThis.fetch;
}

/**
 * Patch `globalThis.fetch` so every fetch() call in the process
 * automatically handles x402 payments.
 *
 * Returns an unregister function that restores the original fetch.
 *
 * @param wallet - A configured Wallet instance
 * @param options - Budget limits and callbacks
 * @returns A function that restores the original globalThis.fetch
 *
 * @example
 * ```ts
 * import { Wallet, register } from "@pay-skill/sdk";
 *
 * const wallet = await Wallet.create();
 * const unregister = register(wallet, { maxTotal: 50.00 });
 *
 * // Every fetch() call now handles 402 automatically
 * const resp = await fetch("https://api.example.com/data");
 *
 * // Restore original fetch when done
 * unregister();
 * ```
 */
export function register(
  wallet: Wallet,
  options?: PayFetchOptions,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = createPayFetch(wallet, options);
  return () => {
    globalThis.fetch = original;
  };
}

// ── Internal ──────────────────────────────────────────────────────────

/**
 * Read the payment amount from a 402 response's headers without
 * consuming the response body (so wallet.settle can read it later).
 */
function parse402Amount(resp: Response): number {
  const header = resp.headers.get("payment-required");
  if (!header) return 0;
  try {
    const decoded = JSON.parse(atob(header)) as Record<string, unknown>;
    const accepts = decoded.accepts as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(accepts) && accepts.length > 0) {
      return Number(accepts[0].amount ?? 0);
    }
    return Number(decoded.amount ?? 0);
  } catch {
    return 0;
  }
}
