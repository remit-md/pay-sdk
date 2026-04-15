/**
 * Tests for @pay-skill/next route handler wrappers.
 *
 * Next.js App Router handlers take a standard Request and return a
 * standard Response, so these tests exercise the wrappers directly
 * without needing a Next.js runtime.
 *
 * A local Express server mocks the facilitator for verify calls.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { withPay, withPaywall } from "../src/index.js";
import type { PaymentInfo } from "../src/types.js";

// ── Mock facilitator ─────────────────────────────────────────────────

type FacilitatorBehavior = "valid" | "invalid" | "error";
let facilitatorBehavior: FacilitatorBehavior = "valid";
let facilitatorUrl = "";
let facilitatorClose: () => void = () => {};

before(async () => {
  const app = express();
  app.use(express.json());
  app.post("/verify", (_req, res) => {
    switch (facilitatorBehavior) {
      case "valid":
        res.json({ isValid: true, payer: "0x" + "cc".repeat(20) });
        break;
      case "invalid":
        res.json({ isValid: false, invalidReason: "insufficient funds" });
        break;
      case "error":
        res.status(500).json({ error: "internal" });
        break;
    }
  });

  await new Promise<void>((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bad address");
      facilitatorUrl = `http://127.0.0.1:${addr.port}`;
      facilitatorClose = () => server.close();
      resolve();
    });
  });
});

after(() => {
  facilitatorClose();
});

// ── Helpers ──────────────────────────────────────────────────────────

function buildPaymentSignature(): string {
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "10000",
    },
    payload: { signature: "0x" + "ab".repeat(65) },
    extensions: {},
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function mockRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://example.com/api/data", { headers });
}

// ── withPay (consumer) tests ─────────────────────────────────────────

describe("withPay (consumer)", () => {
  it("calls handler with pay context", async () => {
    // Mock wallet — withPay passes it through to createPayFetch
    const mockWallet = { address: "0x" + "aa".repeat(20) } as any;

    const handler = withPay(mockWallet, async (_req, pay) => {
      return Response.json({
        hasFetch: typeof pay.fetch === "function",
        hasWallet: !!pay.wallet,
        walletAddress: pay.wallet.address,
      });
    });

    const resp = await handler(mockRequest());
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as any;
    assert.equal(body.hasFetch, true);
    assert.equal(body.hasWallet, true);
    assert.equal(body.walletAddress, "0x" + "aa".repeat(20));
  });

  it("handler receives the request object", async () => {
    const mockWallet = { address: "0x" + "aa".repeat(20) } as any;

    const handler = withPay(mockWallet, async (req, _pay) => {
      return Response.json({
        url: req.url,
        method: req.method,
      });
    });

    const req = new Request("http://example.com/api/foo", { method: "GET" });
    const resp = await handler(req);
    const body = (await resp.json()) as any;
    assert.ok(body.url.includes("/api/foo"));
    assert.equal(body.method, "GET");
  });
});

// ── withPaywall (provider) tests ─────────────────────────────────────

describe("withPaywall (provider)", () => {
  it("returns 402 when no payment header is present", async () => {
    const handler = withPaywall(
      {
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      },
      async () => Response.json({ data: "premium" }),
    );

    const resp = await handler(mockRequest());
    assert.equal(resp.status, 402);

    const prHeader = resp.headers.get("payment-required");
    assert.ok(prHeader, "PAYMENT-REQUIRED header must be present");

    const decoded = JSON.parse(Buffer.from(prHeader, "base64").toString("utf-8"));
    assert.equal(decoded.x402Version, 2);
    assert.equal(decoded.accepts[0].amount, "10000");
    assert.equal(decoded.accepts[0].extra.settlement, "tab");

    const body = (await resp.json()) as any;
    assert.equal(body.error, "payment_required");
  });

  it("encodes amounts correctly for different prices", async () => {
    const handler = withPaywall(
      {
        price: 2.5,
        settlement: "direct",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      },
      async () => Response.json({ report: "done" }),
    );

    const resp = await handler(mockRequest());
    assert.equal(resp.status, 402);

    const prHeader = resp.headers.get("payment-required")!;
    const decoded = JSON.parse(Buffer.from(prHeader, "base64").toString("utf-8"));
    assert.equal(decoded.accepts[0].amount, "2500000");
    assert.equal(decoded.accepts[0].extra.settlement, "direct");
  });

  it("passes through with payment info on valid payment", async () => {
    facilitatorBehavior = "valid";
    const handler = withPaywall(
      {
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      },
      async (_req, payment: PaymentInfo) => {
        return Response.json({
          paidBy: payment.from,
          amount: payment.amount,
          settlement: payment.settlement,
          verified: payment.verified,
        });
      },
    );

    const resp = await handler(
      mockRequest({ "PAYMENT-SIGNATURE": buildPaymentSignature() }),
    );
    assert.equal(resp.status, 200);

    const body = (await resp.json()) as any;
    assert.equal(body.paidBy, "0x" + "cc".repeat(20));
    assert.equal(body.amount, 10000);
    assert.equal(body.settlement, "tab");
    assert.equal(body.verified, true);
  });

  it("returns 402 on invalid payment from facilitator", async () => {
    facilitatorBehavior = "invalid";
    const handler = withPaywall(
      {
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      },
      async () => Response.json({ data: "should not reach" }),
    );

    const resp = await handler(
      mockRequest({ "PAYMENT-SIGNATURE": buildPaymentSignature() }),
    );
    assert.equal(resp.status, 402);
    const body = (await resp.json()) as any;
    assert.ok(body.message.includes("insufficient funds"));
  });

  it("returns 402 on malformed PAYMENT-SIGNATURE", async () => {
    const handler = withPaywall(
      {
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      },
      async () => Response.json({ data: "should not reach" }),
    );

    const resp = await handler(
      mockRequest({ "PAYMENT-SIGNATURE": "not-valid-base64!!!" }),
    );
    assert.equal(resp.status, 402);
    const body = (await resp.json()) as any;
    assert.ok(body.message.includes("decode failed"));
  });

  it("returns 503 when facilitator unreachable (failMode=closed)", async () => {
    const handler = withPaywall(
      {
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl: "http://127.0.0.1:19999",
        failMode: "closed",
      },
      async () => Response.json({ data: "should not reach" }),
    );

    const resp = await handler(
      mockRequest({ "PAYMENT-SIGNATURE": buildPaymentSignature() }),
    );
    assert.equal(resp.status, 503);
    const body = (await resp.json()) as any;
    assert.equal(body.error, "facilitator_unavailable");
  });

  it("passes through when facilitator unreachable (failMode=open)", async () => {
    const handler = withPaywall(
      {
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl: "http://127.0.0.1:19999",
        failMode: "open",
      },
      async () => Response.json({ data: "passed through" }),
    );

    const resp = await handler(
      mockRequest({ "PAYMENT-SIGNATURE": buildPaymentSignature() }),
    );
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as any;
    assert.equal(body.data, "passed through");
  });

  it("returns 402 when facilitator returns 500 (failMode=closed)", async () => {
    facilitatorBehavior = "error";
    const handler = withPaywall(
      {
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
        failMode: "closed",
      },
      async () => Response.json({ data: "should not reach" }),
    );

    const resp = await handler(
      mockRequest({ "PAYMENT-SIGNATURE": buildPaymentSignature() }),
    );
    // Facilitator 500 → verify returns isValid=false → 402
    assert.equal(resp.status, 402);
  });

  it("resource URL in 402 uses request pathname", async () => {
    const handler = withPaywall(
      {
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      },
      async () => Response.json({ data: "premium" }),
    );

    const req = new Request("http://example.com/api/custom/path?q=1");
    const resp = await handler(req);
    const prHeader = resp.headers.get("payment-required")!;
    const decoded = JSON.parse(Buffer.from(prHeader, "base64").toString("utf-8"));
    assert.equal(decoded.resource.url, "/api/custom/path?q=1");
  });
});
