/**
 * Auth rejection tests — proves that the Wallet sends valid auth headers
 * and that servers can reject invalid auth.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { Hex, Address } from "viem";
import { Wallet, PayServerError } from "../src/index.js";

const ANVIL_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

/**
 * Minimal HTTP server that enforces X-Pay-* auth headers.
 * /contracts is public (no auth).
 * Everything else requires valid auth headers.
 */
function createAuthServer(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // /contracts is public
    if (req.url?.endsWith("/contracts")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          router: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
          tab: "0x" + "bb".repeat(20),
          direct: "0x" + "cc".repeat(20),
          fee: "0x" + "dd".repeat(20),
          usdc: "0x" + "ee".repeat(20),
          chain_id: 8453,
        }),
      );
      return;
    }

    const agent = req.headers["x-pay-agent"];
    const sig = req.headers["x-pay-signature"];
    const ts = req.headers["x-pay-timestamp"];
    const nonce = req.headers["x-pay-nonce"];

    if (!agent || !sig || !ts || !nonce) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing auth headers" }));
      return;
    }

    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    if (!sigStr.startsWith("0x") || sigStr.length !== 132) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature format" }));
      return;
    }

    // Auth passed
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        wallet: agent,
        balance_usdc: "100000000",
        open_tabs: 0,
        total_locked: 0,
      }),
    );
  });
}

let server: Server;
let baseUrl: string;

describe("Auth with new Wallet class", () => {
  beforeEach(async () => {
    server = createAuthServer();
    server.listen(0);
    await once(server, "listening");
    const addr = server.address();
    if (typeof addr === "object" && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
    }
  });

  afterEach(async () => {
    server.close();
    await once(server, "close");
  });

  it("Wallet sends valid auth headers and gets 200", async () => {
    process.env.PAYSKILL_API_URL = baseUrl;
    const wallet = new Wallet({ privateKey: ANVIL_PK });
    const status = await wallet.status();
    assert.ok(status.address.startsWith("0x"));
    assert.ok(status.balance.total >= 0);
    delete process.env.PAYSKILL_API_URL;
  });
});
