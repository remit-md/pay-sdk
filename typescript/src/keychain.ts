/**
 * OS keychain reader — reads the private key stored by `pay` CLI.
 * Service: "pay", account: "default".
 *
 * keytar is an optional dependency. If not installed, returns null.
 */

export async function readFromKeychain(): Promise<string | null> {
  try {
    const moduleName = "keytar";
    const keytar = (await import(moduleName)) as {
      default: { getPassword(service: string, account: string): Promise<string | null> };
    };
    return await keytar.default.getPassword("pay", "default");
  } catch {
    return null;
  }
}
