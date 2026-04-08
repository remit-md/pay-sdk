/**
 * Signer interface and implementations.
 *
 * Three modes:
 * 1. CLI signer (default): subprocess call to `pay sign`
 * 2. Raw key: from PAYSKILL_KEY environment variable (dev/testing only)
 * 3. Custom: user provides a sign(hash) -> signature callback
 */

import { execFileSync } from "node:child_process";
import { type Hex } from "viem";
import {
  privateKeyToAccount,
  sign as viemSign,
  serializeSignature,
} from "viem/accounts";

/** Abstract signer interface. */
export interface Signer {
  /** Sign a 32-byte hash. Returns 65-byte signature (r || s || v). */
  sign(hash: Uint8Array): Uint8Array;
  /** The signer's Ethereum address (0x-prefixed, checksummed). */
  readonly address: string;
}

/** Signs via the `pay sign` CLI subprocess. */
export class CliSigner implements Signer {
  private readonly command: string;
  readonly address: string;

  constructor(command = "pay", address = "") {
    this.command = command;
    if (address) {
      this.address = address;
    } else {
      try {
        this.address = execFileSync(this.command, ["address"], {
          encoding: "utf-8",
          timeout: 10_000,
        }).trim();
      } catch {
        this.address = "";
      }
    }
  }

  sign(hash: Uint8Array): Uint8Array {
    const hexHash = Buffer.from(hash).toString("hex");
    const result = execFileSync(this.command, ["sign"], {
      input: hexHash,
      encoding: "utf-8",
      timeout: 30_000,
    });
    return Buffer.from(result.trim(), "hex");
  }
}

/** Signs with a raw private key using viem. Dev/testing only. */
export class RawKeySigner implements Signer {
  private readonly _key: Hex;
  readonly address: string;

  constructor(key?: string) {
    const rawKey = key ?? process.env.PAYSKILL_KEY ?? "";
    if (!rawKey) {
      throw new Error("No key provided and PAYSKILL_KEY not set");
    }
    this._key = rawKey.startsWith("0x")
      ? (rawKey as Hex)
      : (`0x${rawKey}` as Hex);
    const account = privateKeyToAccount(this._key);
    this.address = account.address;
  }

  sign(_hash: Uint8Array): Uint8Array {
    // viem's sign() does raw ECDSA signing (no EIP-191 prefix)
    // sign() is async but Signer interface is sync — we use the sync internal
    // For the sync interface, we need a workaround. Since RawKeySigner is
    // dev/testing only, we'll do a sync computation via signSync.
    // viem doesn't expose sync sign, but we can construct manually.
    // Use the async path via signAsync helper pattern.
    throw new Error(
      "RawKeySigner.sign() is synchronous but viem signing is async. " +
        "Use RawKeySigner.signAsync() or use buildAuthHeaders() directly with the private key."
    );
  }

  /** Async sign — preferred over sync sign(). */
  async signAsync(hash: Uint8Array): Promise<Uint8Array> {
    const hashHex = ("0x" + Buffer.from(hash).toString("hex")) as Hex;
    const raw = await viemSign({ hash: hashHex, privateKey: this._key });
    const sigHex = serializeSignature(raw);
    return hexToBytes(sigHex);
  }
}

/** Delegates signing to a user-provided callback. */
export class CallbackSigner implements Signer {
  private readonly callback: (hash: Uint8Array) => Uint8Array;
  readonly address: string;

  constructor(
    callback: (hash: Uint8Array) => Uint8Array,
    address = ""
  ) {
    this.callback = callback;
    this.address = address;
  }

  sign(hash: Uint8Array): Uint8Array {
    return this.callback(hash);
  }
}

/** Factory for creating signers. */
export function createSigner(
  mode: "cli" | "raw" | "custom" = "cli",
  options: {
    command?: string;
    key?: string;
    address?: string;
    callback?: (hash: Uint8Array) => Uint8Array;
  } = {}
): Signer {
  switch (mode) {
    case "cli":
      return new CliSigner(options.command, options.address);
    case "raw":
      return new RawKeySigner(options.key);
    case "custom":
      if (!options.callback) {
        throw new Error("custom signer requires a callback");
      }
      return new CallbackSigner(options.callback, options.address);
    default:
      throw new Error(`Unknown signer mode: ${mode as string}`);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
