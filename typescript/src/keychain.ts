/**
 * OS keychain reader — reads the private key stored by `pay` CLI.
 * Service: "pay", account: "default".
 *
 * The CLI stores keys as 0x-prefixed hex strings (66 chars). Legacy entries
 * stored as raw 32 bytes are converted to hex on read.
 *
 * keytar is an optional dependency. If not installed, returns null.
 */

const HEX_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export async function readFromKeychain(): Promise<string | null> {
  try {
    const moduleName = "keytar";
    const keytar = (await import(moduleName)) as {
      default: { getPassword(service: string, account: string): Promise<string | null> };
    };
    const value = await keytar.default.getPassword("pay", "default");
    if (!value) return null;

    // New format: 0x-prefixed hex string (written by CLI >= 0.3)
    const trimmed = value.trim();
    if (HEX_KEY_RE.test(trimmed)) return trimmed;

    // Legacy format: raw 32 bytes stored via set_secret().
    // keytar.getPassword reads them as a string — convert byte values to hex.
    if (value.length === 32) {
      const hex =
        "0x" +
        Array.from(value, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      if (HEX_KEY_RE.test(hex)) return hex;
    }

    // Unrecognised format
    return null;
  } catch {
    return null;
  }
}
