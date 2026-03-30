/**
 * Signer interface and implementations.
 *
 * Three modes:
 * 1. CLI signer (default): subprocess call to `pay sign`
 * 2. Raw key: from PAYSKILL_KEY environment variable (dev/testing only)
 * 3. Custom: user provides a sign(hash) -> signature callback
 */

import { execFileSync } from "node:child_process";

/** Abstract signer interface. */
export interface Signer {
  sign(hash: Uint8Array): Uint8Array;
}

/** Signs via the `pay sign` CLI subprocess. */
export class CliSigner implements Signer {
  private readonly command: string;

  constructor(command = "pay") {
    this.command = command;
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

/** Signs with a raw private key. Dev/testing only. */
export class RawKeySigner implements Signer {
  private readonly _key: string;

  constructor(key?: string) {
    this._key = key ?? process.env.PAYSKILL_KEY ?? "";
    if (!this._key) {
      throw new Error("No key provided and PAYSKILL_KEY not set");
    }
  }

  sign(_hash: Uint8Array): Uint8Array {
    throw new Error("Raw key signing not yet implemented");
  }
}

/** Delegates signing to a user-provided callback. */
export class CallbackSigner implements Signer {
  private readonly callback: (hash: Uint8Array) => Uint8Array;

  constructor(callback: (hash: Uint8Array) => Uint8Array) {
    this.callback = callback;
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
    callback?: (hash: Uint8Array) => Uint8Array;
  } = {}
): Signer {
  switch (mode) {
    case "cli":
      return new CliSigner(options.command);
    case "raw":
      return new RawKeySigner(options.key);
    case "custom":
      if (!options.callback) {
        throw new Error("custom signer requires a callback");
      }
      return new CallbackSigner(options.callback);
    default:
      throw new Error(`Unknown signer mode: ${mode as string}`);
  }
}
