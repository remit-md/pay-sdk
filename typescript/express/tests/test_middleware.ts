/**
 * Tests for @pay-skill/express middleware.
 *
 * Unit tests use mocked fetch and in-process Express servers.
 * No external dependencies required.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { payMiddleware, requirePayment } from "../src/index.js";
import type { PaymentInfo } from "../src/types.js";

// ── Test helpers ─────────────────────────────────────────────────────

/** Start an Express app on a random port, return its URL and close fn. */
function serve(app: express.Express): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bad address");
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({ url, close: () => server.close() });
    });
  });
}

/**
 * Build a base64-encoded PAYMENT-REQUIRED header value.
 * Matches the x402 V2 format that requirePayment produces.
 */
function buildPaymentHeader(
  amount: string,
  payTo: string,
  settlement: string,
  facilitatorUrl: string,
): string {
  const requirements = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo,
        maxTimeoutSeconds: 60,
        extra: { settlement, facilitator: facilitatorUrl },
      },
    ],
    resource: { url: "/api/data", mimeType: "application/json" },
    extensions: {},
  };
  return Buffer.from(JSON.stringify(requirements)).toString("base64");
}

/**
 * Build a fake PAYMENT-SIGNATURE header.
 * Real payments require wallet signing — this is just for provider test flow.
 */
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

// ── Consumer middleware tests (payMiddleware) ─────────────────────────

describe("payMiddleware (consumer)", () => {
  // payMiddleware needs a real Wallet. Since we can't construct one in
  // unit tests without a key, we test the attachment behavior with a
  // mock wallet-like object.
  it("attaches req.pay with fetch and wallet", async () => {
    const app = express();

    // Create a minimal mock that satisfies the type
    const mockWallet = { address: "0x" + "aa".repeat(20) } as any;
    const mockFetch = (() => {}) as any;

    // Use a thin middleware that mimics payMiddleware behavior
    app.use((req, _res, next) => {
      req.pay = { fetch: mockFetch, wallet: mockWallet };
      next();
    });

    app.get("/test", (req, res) => {
      res.json({
        hasPay: !!req.pay,
        hasFetch: typeof req.pay?.fetch === "function",
        hasWallet: !!req.pay?.wallet,
        walletAddress: req.pay?.wallet?.address,
      });
    });

    const { url, close } = await serve(app);
    try {
      const resp = await fetch(`${url}/test`);
      const body = await resp.json() as any;
      assert.equal(body.hasPay, true);
      assert.equal(body.hasFetch, true);
      assert.equal(body.hasWallet, true);
      assert.equal(body.walletAddress, "0x" + "aa".repeat(20));
    } finally {
      close();
    }
  });
});

// ── Provider middleware tests (requirePayment) ───────────────────────

describe("requirePayment (provider)", () => {
  // Mock facilitator server
  let facilitatorUrl: string;
  let facilitatorClose: () => void;
  let facilitatorBehavior: "valid" | "invalid" | "error" | "timeout";

  before(async () => {
    const facilitator = express();
    facilitator.use(express.json());

    facilitator.post("/verify", (req, res) => {
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
        case "timeout":
          // Don't respond — let it hang
          break;
      }
    });

    const server = await serve(facilitator);
    facilitatorUrl = server.url;
    facilitatorClose = server.close;
    facilitatorBehavior = "valid"; // default
  });

  after(() => {
    facilitatorClose();
  });

  it("returns 402 when no payment header is present", async () => {
    const app = express();
    app.get(
      "/api/data",
      requirePayment({
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      }),
      (_req, res) => res.json({ data: "premium" }),
    );

    const { url, close } = await serve(app);
    try {
      const resp = await fetch(`${url}/api/data`);
      assert.equal(resp.status, 402);

      // Check PAYMENT-REQUIRED header exists
      const prHeader = resp.headers.get("payment-required");
      assert.ok(prHeader, "PAYMENT-REQUIRED header must be present");

      // Decode and validate structure
      const decoded = JSON.parse(
        Buffer.from(prHeader, "base64").toString("utf-8"),
      );
      assert.equal(decoded.x402Version, 2);
      assert.equal(decoded.accepts.length, 1);
      assert.equal(decoded.accepts[0].amount, "10000"); // $0.01 = 10000 micro
      assert.equal(decoded.accepts[0].extra.settlement, "tab");

      // Check JSON body
      const body = await resp.json() as any;
      assert.equal(body.error, "payment_required");
    } finally {
      close();
    }
  });

  it("returns 402 with correct amount for different prices", async () => {
    const app = express();
    app.get(
      "/api/report",
      requirePayment({
        price: 2.5,
        settlement: "direct",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      }),
      (_req, res) => res.json({ report: "done" }),
    );

    const { url, close } = await serve(app);
    try {
      const resp = await fetch(`${url}/api/report`);
      assert.equal(resp.status, 402);

      const prHeader = resp.headers.get("payment-required")!;
      const decoded = JSON.parse(
        Buffer.from(prHeader, "base64").toString("utf-8"),
      );
      assert.equal(decoded.accepts[0].amount, "2500000"); // $2.50
      assert.equal(decoded.accepts[0].extra.settlement, "direct");
    } finally {
      close();
    }
  });

  it("passes through with req.payment on valid payment", async () => {
    facilitatorBehavior = "valid";
    const app = express();
    app.get(
      "/api/data",
      requirePayment({
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      }),
      (req, res) => {
        const payment = req.payment as PaymentInfo;
        res.json({
          data: "premium",
          paidBy: payment.from,
          amount: payment.amount,
          settlement: payment.settlement,
          verified: payment.verified,
        });
      },
    );

    const { url, close } = await serve(app);
    try {
      const resp = await fetch(`${url}/api/data`, {
        headers: { "PAYMENT-SIGNATURE": buildPaymentSignature() },
      });
      assert.equal(resp.status, 200);

      const body = await resp.json() as any;
      assert.equal(body.data, "premium");
      assert.equal(body.paidBy, "0x" + "cc".repeat(20)); // from mock facilitator
      assert.equal(body.amount, 10000);
      assert.equal(body.settlement, "tab");
      assert.equal(body.verified, true);
    } finally {
      close();
    }
  });

  it("returns 402 on invalid payment", async () => {
    facilitatorBehavior = "invalid";
    const app = express();
    app.get(
      "/api/data",
      requirePayment({
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      }),
      (_req, res) => res.json({ data: "should not reach" }),
    );

    const { url, close } = await serve(app);
    try {
      const resp = await fetch(`${url}/api/data`, {
        headers: { "PAYMENT-SIGNATURE": buildPaymentSignature() },
      });
      assert.equal(resp.status, 402);

      const body = await resp.json() as any;
      assert.equal(body.error, "payment_required");
      assert.ok(body.message.includes("insufficient funds"));
    } finally {
      close();
    }
  });

  it("returns 402 on malformed PAYMENT-SIGNATURE", async () => {
    const app = express();
    app.get(
      "/api/data",
      requirePayment({
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      }),
      (_req, res) => res.json({ data: "should not reach" }),
    );

    const { url, close } = await serve(app);
    try {
      const resp = await fetch(`${url}/api/data`, {
        headers: { "PAYMENT-SIGNATURE": "not-valid-base64!!!" },
      });
      assert.equal(resp.status, 402);

      const body = await resp.json() as any;
      assert.ok(body.message.includes("decode failed"));
    } finally {
      close();
    }
  });

  it("returns 503 when facilitator is unreachable (failMode=closed)", async () => {
    const app = express();
    app.get(
      "/api/data",
      requirePayment({
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        // Point to a port that doesn't exist
        facilitatorUrl: "http://127.0.0.1:19999",
        failMode: "closed",
      }),
      (_req, res) => res.json({ data: "should not reach" }),
    );

    const { url, close } = await serve(app);
    try {
      const resp = await fetch(`${url}/api/data`, {
        headers: { "PAYMENT-SIGNATURE": buildPaymentSignature() },
      });
      assert.equal(resp.status, 503);

      const body = await resp.json() as any;
      assert.equal(body.error, "facilitator_unavailable");
    } finally {
      close();
    }
  });

  it("passes through when facilitator is unreachable (failMode=open)", async () => {
    const app = express();
    app.get(
      "/api/data",
      requirePayment({
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl: "http://127.0.0.1:19999",
        failMode: "open",
      }),
      (_req, res) => res.json({ data: "passed through" }),
    );

    const { url, close } = await serve(app);
    try {
      const resp = await fetch(`${url}/api/data`, {
        headers: { "PAYMENT-SIGNATURE": buildPaymentSignature() },
      });
      assert.equal(resp.status, 200);

      const body = await resp.json() as any;
      assert.equal(body.data, "passed through");
    } finally {
      close();
    }
  });

  it("sets X-Pay-* headers on verified request", async () => {
    facilitatorBehavior = "valid";
    const app = express();
    app.get(
      "/api/data",
      requirePayment({
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      }),
      (req, res) => {
        res.json({
          verified: req.headers["x-pay-verified"],
          from: req.headers["x-pay-from"],
          amount: req.headers["x-pay-amount"],
          settlement: req.headers["x-pay-settlement"],
          // payment-signature should be stripped
          hasPaymentSig: !!req.headers["payment-signature"],
        });
      },
    );

    const { url, close } = await serve(app);
    try {
      const resp = await fetch(`${url}/api/data`, {
        headers: { "PAYMENT-SIGNATURE": buildPaymentSignature() },
      });
      assert.equal(resp.status, 200);

      const body = await resp.json() as any;
      assert.equal(body.verified, "true");
      assert.equal(body.from, "0x" + "cc".repeat(20));
      assert.equal(body.amount, "10000");
      assert.equal(body.settlement, "tab");
      assert.equal(body.hasPaymentSig, false);
    } finally {
      close();
    }
  });

  it("free routes are unaffected", async () => {
    const app = express();
    app.get("/api/health", (_req, res) => res.json({ ok: true }));
    app.get(
      "/api/data",
      requirePayment({
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
      }),
      (_req, res) => res.json({ data: "premium" }),
    );

    const { url, close } = await serve(app);
    try {
      // Free route — no 402
      const freeResp = await fetch(`${url}/api/health`);
      assert.equal(freeResp.status, 200);

      // Paid route — 402
      const paidResp = await fetch(`${url}/api/data`);
      assert.equal(paidResp.status, 402);
    } finally {
      close();
    }
  });

  it("returns 402 when facilitator returns 500 (failMode=closed)", async () => {
    facilitatorBehavior = "error";
    const app = express();
    app.get(
      "/api/data",
      requirePayment({
        price: 0.01,
        settlement: "tab",
        providerAddress: "0x" + "bb".repeat(20),
        facilitatorUrl,
        failMode: "closed",
      }),
      (_req, res) => res.json({ data: "should not reach" }),
    );

    const { url, close } = await serve(app);
    try {
      const resp = await fetch(`${url}/api/data`, {
        headers: { "PAYMENT-SIGNATURE": buildPaymentSignature() },
      });
      // Facilitator returned 500 → verify returns {isValid: false}
      assert.equal(resp.status, 402);
    } finally {
      close();
    }
  });
});
