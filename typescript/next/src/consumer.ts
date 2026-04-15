/**
 * Consumer-side Next.js App Router wrapper.
 *
 * Wraps a route handler with a pay-enabled fetch context. Use inside
 * any App Router route handler (GET, POST, PUT, DELETE, etc.).
 *
 * @example
 * ```ts
 * // app/api/forecast/route.ts
 * import { withPay } from "@pay-skill/next";
 * import { Wallet } from "@pay-skill/sdk";
 *
 * const wallet = await Wallet.create();
 *
 * export const GET = withPay(wallet, async (_req, pay) => {
 *   const resp = await pay.fetch("https://weather-api.example.com/forecast");
 *   return Response.json(await resp.json());
 * });
 * ```
 *
 * @module
 */

import type { Wallet } from "@pay-skill/sdk";
import { createPayFetch } from "@pay-skill/sdk";
import type { PayContext, PayHandler, WithPayOptions } from "./types.js";

/**
 * Wrap a Next.js App Router route handler with a pay-enabled fetch.
 *
 * @param wallet - A configured Wallet instance.
 * @param handler - The route handler. Receives (req, pay) instead of just (req).
 * @param options - Optional budget limits and callbacks.
 * @returns A Next.js-compatible route handler function.
 */
export function withPay<Req extends Request = Request>(
  wallet: Wallet,
  handler: PayHandler<Req>,
  options: WithPayOptions = {},
): (req: Req) => Promise<Response> {
  // Single payFetch per wrapper instance. Budget tracking (maxTotal)
  // persists across requests while the process is alive.
  const payFetch = createPayFetch(wallet, options);

  const context: PayContext = {
    fetch: payFetch,
    wallet,
  };

  return async (req: Req) => handler(req, context);
}
