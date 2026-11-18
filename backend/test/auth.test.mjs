import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  claimMessage,
  signMessage,
  submitMessage,
  verifyMessage,
} from "../dist/auth.js";

// base58 of 32 zero bytes is 32 ones; generated keys round-trip below.
describe("provider operation auth", () => {
  it("signs and verifies, and rejects wrong messages/keys/garbage", async () => {
    const { bs58Decode } = await import("@infermesh/sdk");
    // Owner = base58 of this process's key is not available; use a fixed
    // 32-byte key and sign with the matching secret.
    const { generateKeyPairSync: gen } = await import("node:crypto");
    const kp = gen("ed25519");
    const d = kp.privateKey.export({ format: "jwk" }).d;
    const x = kp.publicKey.export({ format: "jwk" }).x;
    const secret = Buffer.concat([Buffer.from(d, "base64url"), Buffer.from(x, "base64url")]).toString("base64");
    // Minimal base58 encode for the test (Bitcoin alphabet).
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const raw = Buffer.from(x, "base64url");
    let num = BigInt("0x" + raw.toString("hex"));
    let out = "";
    while (num > 0n) {
      out = ALPHABET[Number(num % 58n)] + out;
      num = num / 58n;
    }
    for (const b of raw) {
      if (b !== 0) break;
      out = "1" + out;
    }
    const owner = out;
    assert.deepEqual(bs58Decode(owner), new Uint8Array(raw));

    const good = signMessage(secret, claimMessage(7));
    assert.equal(verifyMessage(owner, claimMessage(7), good), true);
    assert.equal(verifyMessage(owner, claimMessage(8), good), false); // wrong job
    assert.equal(verifyMessage(owner, submitMessage(7), good), false); // wrong op
    assert.equal(verifyMessage(owner, claimMessage(7), "!!!not-base64!!!"), false);
    assert.equal(verifyMessage("DemoOperator1", claimMessage(7), good), false); // demo owner: no key
    assert.throws(() => signMessage("short", claimMessage(1)), /64-byte/);
  });
});
