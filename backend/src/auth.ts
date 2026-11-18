/**
 * Provider operation authentication (demo REST layer).
 *
 * If a provider's owner is a real 32-byte base58 pubkey, claim/submit calls
 * must carry an Ed25519 signature over the operation message. Demo string
 * owners (e.g. "DemoOperator1") stay open so the demo runs keyless.
 *
 * Operator setup:
 *   1. Generate an Ed25519 keypair (any Solana tooling; the secret key is
 *      64-byte base64: 32-byte seed + 32-byte pubkey).
 *   2. Register the provider with owner = base58 pubkey.
 *   3. Run the daemon with INFERMESH_OWNER_SECRET=<base64 64-byte secret>.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { bs58Decode } from "@infermesh/sdk";

export function ownerKeyBytes(owner: string): Uint8Array | null {
  try {
    return bs58Decode(owner);
  } catch {
    return null; // not a pubkey: demo string owner, auth stays open
  }
}

export function claimMessage(jobId: number): Uint8Array {
  return new TextEncoder().encode(`infermesh-claim:${jobId}`);
}

export function submitMessage(jobId: number): Uint8Array {
  return new TextEncoder().encode(`infermesh-submit:${jobId}`);
}

function privateKeyFromSecret(secretB64: string) {
  const raw = Buffer.from(secretB64, "base64");
  if (raw.length !== 64) {
    throw new Error("INFERMESH_OWNER_SECRET must be base64 of a 64-byte Solana secret key");
  }
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: raw.subarray(0, 32).toString("base64url"),
      x: raw.subarray(32).toString("base64url"),
    },
    format: "jwk",
  });
}

export function signMessage(secretB64: string, message: Uint8Array): string {
  return sign(null, Buffer.from(message), privateKeyFromSecret(secretB64)).toString("base64");
}

export function verifyMessage(owner: string, message: Uint8Array, sigB64: string): boolean {
  const pub = ownerKeyBytes(owner);
  if (!pub) return false;
  try {
    const key = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(pub).toString("base64url"),
      },
      format: "jwk",
    });
    return verify(null, Buffer.from(message), key, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}
