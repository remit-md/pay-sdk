/**
 * EIP-712 authentication for pay API requests.
 *
 * Every authenticated request includes four headers:
 *   X-Pay-Agent     — wallet address (0x-prefixed, checksummed)
 *   X-Pay-Signature — EIP-712 signature (0x-prefixed hex, 65 bytes)
 *   X-Pay-Timestamp — unix timestamp in seconds
 *   X-Pay-Nonce     — random 32-byte hex (0x-prefixed)
 *
 * The EIP-712 domain:
 *   name: "pay"
 *   version: "0.1"
 *   chainId: <from config>
 *   verifyingContract: <router address>
 *
 * The typed data:
 *   APIRequest(string method, string path, uint256 timestamp, bytes32 nonce)
 */

import { type Hex, keccak256, encodePacked, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

export interface AuthConfig {
  chainId: number;
  routerAddress: Address;
}

export interface AuthHeaders {
  "X-Pay-Agent": string;
  "X-Pay-Signature": string;
  "X-Pay-Timestamp": string;
  "X-Pay-Nonce": string;
}

const EIP712_DOMAIN = {
  name: "pay",
  version: "0.1",
} as const;

const API_REQUEST_TYPES = {
  APIRequest: [
    { name: "method", type: "string" },
    { name: "path", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Build auth headers for an API request using a private key.
 */
export async function buildAuthHeaders(
  privateKey: Hex,
  method: string,
  path: string,
  config: AuthConfig
): Promise<AuthHeaders> {
  const account = privateKeyToAccount(privateKey);
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const nonce = ("0x" + randomBytes(32).toString("hex")) as Hex;

  const signature = await account.signTypedData({
    domain: {
      ...EIP712_DOMAIN,
      chainId: config.chainId,
      verifyingContract: config.routerAddress,
    },
    types: API_REQUEST_TYPES,
    primaryType: "APIRequest",
    message: {
      method: method.toUpperCase(),
      path,
      timestamp,
      nonce,
    },
  });

  return {
    "X-Pay-Agent": account.address,
    "X-Pay-Signature": signature,
    "X-Pay-Timestamp": timestamp.toString(),
    "X-Pay-Nonce": nonce,
  };
}

/**
 * Build auth headers using a generic signer (Signer interface).
 * Computes the EIP-712 hash manually and delegates signing to the signer.
 */
export function buildAuthHeadersWithSigner(
  signer: { sign(hash: Uint8Array): Uint8Array; address: string },
  method: string,
  path: string,
  config: AuthConfig
): AuthHeaders {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const nonce = ("0x" + randomBytes(32).toString("hex")) as Hex;

  const hash = computeEip712Hash(
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    config.chainId,
    config.routerAddress
  );

  const sigBytes = signer.sign(hash);
  const signature = ("0x" + Buffer.from(sigBytes).toString("hex")) as Hex;

  return {
    "X-Pay-Agent": signer.address,
    "X-Pay-Signature": signature,
    "X-Pay-Timestamp": timestamp.toString(),
    "X-Pay-Nonce": nonce,
  };
}

/**
 * Compute the EIP-712 hash for an APIRequest.
 * Must match the server's computation exactly.
 */
export function computeEip712Hash(
  method: string,
  path: string,
  timestamp: bigint,
  nonce: Hex,
  chainId: number,
  verifyingContract: Address
): Uint8Array {
  // Type hashes
  const domainTypehash = keccak256(
    encodePacked(
      ["string"],
      [
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
      ]
    )
  );
  const structTypehash = keccak256(
    encodePacked(
      ["string"],
      [
        "APIRequest(string method,string path,uint256 timestamp,bytes32 nonce)",
      ]
    )
  );

  // Domain separator
  const nameHash = keccak256(encodePacked(["string"], ["pay"]));
  const versionHash = keccak256(encodePacked(["string"], ["0.1"]));

  const domainSeparator = keccak256(
    encodePacked(
      ["bytes32", "bytes32", "bytes32", "uint256", "bytes32"],
      [
        domainTypehash,
        nameHash,
        versionHash,
        BigInt(chainId),
        ("0x000000000000000000000000" + verifyingContract.slice(2)) as Hex,
      ]
    )
  );

  // Struct hash
  const methodHash = keccak256(encodePacked(["string"], [method]));
  const pathHash = keccak256(encodePacked(["string"], [path]));

  // Pad nonce to bytes32
  const nonceClean = nonce.startsWith("0x") ? nonce.slice(2) : nonce;
  const noncePadded = ("0x" + nonceClean.padEnd(64, "0")) as Hex;

  const structHash = keccak256(
    encodePacked(
      ["bytes32", "bytes32", "bytes32", "uint256", "bytes32"],
      [structTypehash, methodHash, pathHash, timestamp, noncePadded]
    )
  );

  // Final hash: keccak256("\x19\x01" || domainSeparator || structHash)
  const finalHash = keccak256(
    encodePacked(
      ["bytes2", "bytes32", "bytes32"],
      ["0x1901" as Hex, domainSeparator, structHash]
    )
  );

  return hexToBytes(finalHash);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
