/**
 * Keychain integration tests — prove Wallet.create() reads from real OS keychain.
 *
 * Requires: libsecret-1-dev + gnome-keyring + dbus session on Linux.
 * Run via: dbus-run-session -- bash -c 'echo "" | gnome-keyring-daemon --unlock && node --import tsx --test tests/test_keychain.ts'
 *
 * Skips gracefully when keytar is not installed or Secret Service is unavailable.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "../src/index.js";

const TEST_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

type Keytar = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

let keytar: Keytar | null = null;

async function loadKeytar(): Promise<Keytar | null> {
  try {
    const mod = (await import("keytar")) as { default: Keytar };
    return mod.default;
  } catch {
    return null;
  }
}

async function keychainAvailable(kt: Keytar): Promise<boolean> {
  try {
    // Probe: try to write and delete a sentinel value
    await kt.setPassword("pay-test-probe", "probe", "1");
    await kt.deletePassword("pay-test-probe", "probe");
    return true;
  } catch {
    return false;
  }
}

// Save/restore env
let savedKey: string | undefined;

function clearEnv() {
  savedKey = process.env.PAYSKILL_KEY;
  delete process.env.PAYSKILL_KEY;
}

function restoreEnv() {
  if (savedKey !== undefined) process.env.PAYSKILL_KEY = savedKey;
  else delete process.env.PAYSKILL_KEY;
}

describe("Wallet.create() OS keychain integration", () => {
  afterEach(async () => {
    restoreEnv();
    if (keytar) await keytar.deletePassword("pay", "default").catch(() => {});
  });

  it("reads private key from OS keychain", async (t) => {
    keytar = await loadKeytar();
    if (!keytar) return t.skip("keytar not installed");
    if (!(await keychainAvailable(keytar))) return t.skip("OS keychain not available");

    clearEnv();

    await keytar.setPassword("pay", "default", TEST_KEY);
    const wallet = await Wallet.create({ testnet: true });
    assert.equal(wallet.address.toLowerCase(), TEST_ADDRESS.toLowerCase());
  });

  it("prefers keychain over env var", async (t) => {
    keytar = await loadKeytar();
    if (!keytar) return t.skip("keytar not installed");
    if (!(await keychainAvailable(keytar))) return t.skip("OS keychain not available");

    // Set a different key in env var
    const differentKey =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    process.env.PAYSKILL_KEY = differentKey;

    await keytar.setPassword("pay", "default", TEST_KEY);
    const wallet = await Wallet.create({ testnet: true });

    // Should use keychain key, not env var
    assert.equal(wallet.address.toLowerCase(), TEST_ADDRESS.toLowerCase());
  });

  it("falls back to env var when keychain entry missing", async (t) => {
    keytar = await loadKeytar();
    if (!keytar) return t.skip("keytar not installed");
    if (!(await keychainAvailable(keytar))) return t.skip("OS keychain not available");

    // No keychain entry
    await keytar.deletePassword("pay", "default").catch(() => {});

    process.env.PAYSKILL_KEY = TEST_KEY;
    const wallet = await Wallet.create({ testnet: true });
    assert.equal(wallet.address.toLowerCase(), TEST_ADDRESS.toLowerCase());
  });
});
