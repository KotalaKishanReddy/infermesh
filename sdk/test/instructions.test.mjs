import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DISCRIMINANTS,
  Instructions,
  bs58Decode,
} from "../dist/instructions.js";
import {
  jobSeedBytes,
  listingSeedBytes,
  marketplaceSeedBytes,
  providerSeedBytes,
  vaultSeedBytes,
} from "../dist/index.js";

const key = (fill) => new Uint8Array(32).fill(fill);
const HEX = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("discriminators match the Anchor preimage scheme", () => {
  it("re-derives every discriminator from sha256('global:<name>')[0..8]", async () => {
    const names = {
      initialize_marketplace: "initialize_marketplace",
      set_admin: "set_admin",
      set_arbiter: "set_arbiter",
      set_fee_bps: "set_fee_bps",
      register_provider: "register_provider",
      unstake: "unstake",
      list_model: "list_model",
      create_job: "create_job",
      claim_job: "claim_job",
      submit_result: "submit_result",
      confirm_result: "confirm_result",
      finalize_job: "finalize_job",
      timeout_refund: "timeout_refund",
      raise_dispute: "raise_dispute",
      cancel_dispute: "cancel_dispute",
      resolve_dispute: "resolve_dispute",
    };
    for (const [keyName, ixName] of Object.entries(names)) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${ixName}`));
      assert.equal(HEX(new Uint8Array(digest).slice(0, 8)), DISCRIMINANTS[keyName], keyName);
    }
  });
});

describe("instruction account layouts mirror the program contexts", () => {
  const k = {
    marketplace: key(1),
    admin: key(2),
    arbiter: key(3),
    provider: key(4),
    owner: key(5),
    listing: key(6),
    job: key(7),
    vault: key(8),
    requester: key(9),
    claimer: key(10),
    submitter: key(11),
    caller: key(12),
    providerRecipient: key(13),
    treasury: key(14),
  };
  const P = "FMesh11111111111111111111111111111111111111";

  it("encodes create_job with escrow accounts in context order", () => {
    const ix = Instructions.createJob(k, key(21), key(22), 100_000, 512, 1000, P);
    assert.equal(ix.accounts.length, 5);
    assert.deepEqual(ix.accounts.map((a) => [a.isSigner, a.isWritable]), [
      [false, true], // marketplace
      [false, true], // job
      [false, true], // vault
      [true, true], // requester
      [false, false], // system program
    ]);
    // data = discriminator ++ inputHash ++ modelHash ++ u64 ++ u32 ++ u64
    assert.equal(ix.data.length, 8 + 32 + 32 + 8 + 4 + 8);
    assert.equal(HEX(ix.data.slice(0, 8)), DISCRIMINANTS.create_job);
  });

  it("submit_result pins the provider PDA and requires the owner signer", () => {
    const ix = Instructions.submitResult(k, key(23), 40, 60, P);
    assert.equal(ix.accounts.length, 3);
    assert.deepEqual(ix.accounts[1].pubkey, k.provider);
    assert.equal(ix.accounts[2].isSigner, true); // owner, not the PDA
    assert.equal(ix.data.length, 8 + 32 + 4 + 4);
  });

  it("finalize_job is permissionless except for the fee-paying caller", () => {
    const ix = Instructions.finalizeJob(k, P);
    assert.equal(ix.accounts.length, 8);
    const signers = ix.accounts.filter((a) => a.isSigner);
    assert.equal(signers.length, 1);
    assert.deepEqual(signers[0].pubkey, k.caller);
  });

  it("timeout_refund uses program-ID filler when the provider is absent", () => {
    const withP = Instructions.timeoutRefund(k, k.provider, P);
    assert.equal(withP.accounts.length, 4);
    assert.deepEqual(withP.accounts[1].pubkey, k.provider);

    const withoutP = Instructions.timeoutRefund({ ...k, provider: undefined }, null, P);
    assert.equal(withoutP.accounts.length, 4);
    // Filler keeps requester/vault positions aligned for Anchor's Option decode.
    assert.deepEqual(withoutP.accounts[2].pubkey, k.requester);
    assert.deepEqual(withoutP.accounts[3].pubkey, k.vault);
    // And the filler really is this program's ID.
    assert.deepEqual(withoutP.accounts[1].pubkey, bs58Decode(P));
  });

  it("resolve_dispute carries the boolean verdict", () => {
    const yes = Instructions.resolveDispute(k, true, P);
    const no = Instructions.resolveDispute(k, false, P);
    assert.equal(yes.data[8], 1);
    assert.equal(no.data[8], 0);
    assert.equal(yes.accounts[1].isSigner, true); // arbiter
  });
});

describe("PDA seeds are byte-exact mirrors of the program", () => {
  it("builds the documented seed vectors", () => {
    const m = key(1);
    const o = key(2);
    assert.deepEqual(
      providerSeedBytes(m, o).map((s) => HEX(s)),
      ["70726f7669646572", HEX(m), HEX(o)], // "provider"
    );
    const job = jobSeedBytes(m, 7);
    assert.equal(job.length, 3);
    assert.equal(HEX(job[2]), "0700000000000000"); // u64 LE counter
    assert.throws(() => providerSeedBytes(m, key(1).slice(0, 31)), /32-byte/);
    assert.throws(() => jobSeedBytes(m, -1), /non-negative/);
    assert.equal(marketplaceSeedBytes().length, 1);
    assert.equal(listingSeedBytes(key(4), key(5)).length, 3);
    assert.equal(vaultSeedBytes(key(7)).length, 2);
  });
});

describe("bs58", () => {
  it("decodes the all-ones system address to zeros and rejects garbage", () => {
    assert.deepEqual(bs58Decode("11111111111111111111111111111111"), new Uint8Array(32));
    assert.throws(() => bs58Decode("0OIl nope"), /invalid base58/);
  });
});
