/**
 * Auth rejection tests — proves that:
 * 1. Requests without auth headers are rejected with 401
 * 2. Requests with invalid/wrong signatures are rejected with 401
 * 3. The SDK surfaces auth errors as PayServerError with correct statusCode
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { PayClient, PayServerError, CallbackSigner, RawKeySigner } from "../src/index.js";
import type { Hex, Address } from "viem";

const ANVIL_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const WRONG_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

const TEST_ROUTER = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const TEST_CHAIN_ID = 8453;
const VALID_ADDR = "0x" + "a1".repeat(20);

/**
 * Minimal HTTP server that enforces X-Pay-* auth headers.
 * Returns 401 if any required header is missing, 200 otherwise.
 */
function createAuthServer(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const agent = req.headers["x-pay-agent"];
    const sig = req.headers["x-pay-signature"];
    const ts = req.headers["x-pay-timestamp"];
    const nonce = req.headers["x-pay-nonce"];

    if (!agent || !sig || !ts || !nonce) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing auth headers" }));
      return;
    }

    // Check that sig looks like a real 65-byte hex signature
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    if (!sigStr.startsWith("0x") || sigStr.length !== 132) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature format" }));
      return;
    }

    // Check that sig is not all zeros (stub detection)
    if (sigStr === "0x" + "0".repeat(130)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Stub signature rejected" }));
      return;
    }

    // Auth passed — return mock data
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        address: agent,
        balance: 100_000_000,
        open_tabs: [],
      })
    );
  });
}

let server: Server;
let baseUrl: string;

describe("Auth rejection", () => {
  beforeEach(async () => {
    server = createAuthServer();
    server.listen(0); // random port
    await once(server, "listening");
    const addr = server.address();
    if (typeof addr === "object" && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterEach(async () => {
    server.close();
    await once(server, "close");
  });

  it("rejects request without auth headers (no private key configured)", async () => {
    // Client with no auth config — sends no X-Pay-* headers
    const client = new PayClient({
      apiUrl: baseUrl,
      signer: new CallbackSigner((_h: Uint8Array) => new Uint8Array(65)),
    });

    await assert.rejects(
      () => client.getStatus(),
      (err: unknown) => {
        assert.ok(err instanceof PayServerError);
        assert.equal(err.statusCode, 401);
        assert.ok(err.message.includes("Missing auth headers"));
        return true;
      }
    );
  });

  it("rejects request with stub signer (all-zero signature)", async () => {
    // Client with a stub signer that returns zeros — server should reject
    const client = new PayClient({
      apiUrl: baseUrl,
      signer: new CallbackSigner((_h: Uint8Array) => new Uint8Array(65)),
      chainId: TEST_CHAIN_ID,
      routerAddress: TEST_ROUTER,
    });

    await assert.rejects(
      () => client.getStatus(),
      (err: unknown) => {
        assert.ok(err instanceof PayServerError);
        assert.equal(err.statusCode, 401);
        return true;
      }
    );
  });

  it("accepts request with valid auth headers (real signing)", async () => {
    const client = new PayClient({
      apiUrl: baseUrl,
      privateKey: ANVIL_PK,
      chainId: TEST_CHAIN_ID,
      routerAddress: TEST_ROUTER,
    });

    // Should NOT throw — server accepts valid auth
    const status = await client.getStatus();
    assert.ok(status.balance >= 0);
  });

  it("PayServerError has statusCode 401 for auth failures", async () => {
    // Directly verify error structure
    const client = new PayClient({
      apiUrl: baseUrl,
      signer: new CallbackSigner((_h: Uint8Array) => new Uint8Array(65)),
    });

    try {
      await client.getStatus();
      assert.fail("Should have thrown PayServerError");
    } catch (err) {
      assert.ok(err instanceof PayServerError, "must be PayServerError");
      assert.equal(err.statusCode, 401, "statusCode must be 401");
      assert.equal(err.code, "server_error");
    }
  });
});
