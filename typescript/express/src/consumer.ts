/**
 * Consumer-side Express middleware.
 *
 * Attaches `req.pay.fetch` (pay-enabled fetch) and `req.pay.wallet`
 * to every request. Use `req.pay.fetch` to make outbound HTTP calls
 * that auto-settle x402 payments.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { Wallet } from "@pay-skill/sdk";
 * import { payMiddleware } from "@pay-skill/express";
 *
 * const wallet = await Wallet.create();
 * const app = express();
 *
 * app.use(payMiddleware(wallet, { maxPerRequest: 1.00, maxTotal: 100.00 }));
 *
 * app.get("/forecast", async (req, res) => {
 *   const data = await req.pay!.fetch("https://api.example.com/forecast");
 *   res.json(await data.json());
 * });
 * ```
 *
 * @module
 */

import type { RequestHandler } from "express";
import type { Wallet } from "@pay-skill/sdk";
import { createPayFetch } from "@pay-skill/sdk";
import type { PayMiddlewareOptions } from "./types.js";

/**
 * Create Express middleware that attaches a pay-enabled fetch to every request.
 *
 * @param wallet - A configured Wallet instance.
 * @param options - Budget limits and callbacks (same as createPayFetch).
 * @returns Express middleware function.
 */
export function payMiddleware(
  wallet: Wallet,
  options: PayMiddlewareOptions = {},
): RequestHandler {
  // Single payFetch instance shared across all requests.
  // Budget tracking (maxTotal) is per-middleware-instance lifetime.
  const payFetch = createPayFetch(wallet, options);

  return (req, _res, next) => {
    req.pay = {
      fetch: payFetch,
      wallet,
    };
    next();
  };
}
