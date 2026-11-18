/**
 * Hand-rolled onchain instruction builders for the InferMesh Anchor program.
 *
 * Zero-dependency on purpose: borsh here is only fixed-size little-endian
 * integers, 32-byte arrays, and bools, so a 40-line writer beats pulling in
 * a serialization framework. Layouts follow the Anchor IDL convention:
 *   data = discriminator ++ borsh(args)
 *   discriminator = sha256("global:<snake_case_name>")[0..8]
 * Accounts are listed in context-struct field order (see
 * programs/infermesh/src/lib.rs). Discriminators are hardcoded for
 * offline use AND re-derived in sdk/test/instructions.test.mjs — if Anchor
 * ever changes the preimage scheme, that test fails loudly instead of
 * silently building bad transactions.
 */

export interface InstructionAccount {
  pubkey: Uint8Array;
  isSigner: boolean;
  isWritable: boolean;
}

export interface BuiltInstruction {
  programId: string;
  accounts: InstructionAccount[];
  data: Uint8Array;
}

export const DISCRIMINANTS: Record<string, string> = {
  initialize_marketplace: "2f51400060386907",
  set_admin: "fba300345bc2bb5c",
  set_arbiter: "0fcdc2b4acd571d3",
  set_fee_bps: "02a1f58d6f2027c6",
  register_provider: "fed136b82ec56d4e",
  unstake: "5a5f6b2acd7c32e1",
  list_model: "090380c981d3d6db",
  create_job: "b282d96e641b5277",
  claim_job: "09a005e7747bc60e",
  submit_result: "f02a59b40aef09d6",
  confirm_result: "dd92c7bc8343944a",
  finalize_job: "8d34239628068c1b",
  timeout_refund: "c2cd8d25e7769309",
  raise_dispute: "29f30133965ff649",
  cancel_dispute: "179bdc5e4c8de77c",
  resolve_dispute: "e706ca0660670ce6",
};

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const BS58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58 Solana address to 32 raw bytes. */
export function bs58Decode(s: string): Uint8Array {
  const out = new Uint8Array(32);
  for (const ch of s) {
    const digit = BS58.indexOf(ch);
    if (digit < 0) throw new Error("invalid base58 character");
    let carry = digit;
    for (let i = 31; i >= 0; i--) {
      const v = out[i] * 58 + carry;
      out[i] = v & 0xff;
      carry = v >> 8;
    }
    if (carry !== 0) throw new Error("base58 value overflows 32 bytes");
  }
  return out;
}

function unhex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("bad hex discriminator");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

class Writer {
  buf: number[] = [];
  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.buf.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  u32(v: number): this {
    this.buf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    return this;
  }
  u64(v: number | bigint): this {
    let x = BigInt(v);
    for (let i = 0; i < 8; i++) {
      this.buf.push(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }
  fixed32(v: Uint8Array, name: string): this {
    if (!(v instanceof Uint8Array) || v.length !== 32) throw new Error(`${name} must be 32 bytes`);
    this.buf.push(...v);
    return this;
  }
  bool(v: boolean): this {
    this.buf.push(v ? 1 : 0);
    return this;
  }
  bytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

function dataFor(name: string, write: (w: Writer) => void): Uint8Array {
  const w = new Writer();
  write(w);
  const out = new Uint8Array(8 + w.buf.length);
  out.set(unhex(DISCRIMINANTS[name]), 0);
  out.set(w.bytes(), 8);
  return out;
}

function acct(pubkey: Uint8Array, isSigner: boolean, isWritable: boolean): InstructionAccount {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32) {
    throw new Error("account pubkey must be 32 bytes");
  }
  return { pubkey, isSigner, isWritable };
}

export interface Keyset {
  marketplace: Uint8Array;
  admin?: Uint8Array;
  arbiter?: Uint8Array;
  provider?: Uint8Array;
  owner?: Uint8Array;
  listing?: Uint8Array;
  job?: Uint8Array;
  vault?: Uint8Array;
  requester?: Uint8Array;
  claimer?: Uint8Array;
  submitter?: Uint8Array;
  caller?: Uint8Array;
  providerRecipient?: Uint8Array;
  treasury?: Uint8Array;
  systemProgram?: Uint8Array;
}

const SYS = new Uint8Array(32); // placeholder; pass the real 1111... address at call time

function sys(k?: Uint8Array): Uint8Array {
  return k ?? SYS;
}

function build(programId: string, name: string, accounts: InstructionAccount[], data: Uint8Array): BuiltInstruction {
  return { programId, accounts, data };
}

export const Instructions = {
  initializeMarketplace(k: Keyset, admin: Uint8Array, arbiter: Uint8Array, feeBps: number, programId: string) {
    return build(programId, "initialize_marketplace", [
      acct(k.marketplace, false, true),
      acct(k.admin!, true, true),
      acct(sys(k.systemProgram), false, false),
    ], dataFor("initialize_marketplace", (w) => w.fixed32(admin, "admin").fixed32(arbiter, "arbiter").u16(feeBps)));
  },
  setAdmin(k: Keyset, newAdmin: Uint8Array, programId: string) {
    return build(programId, "set_admin", [
      acct(k.marketplace, false, true),
      acct(k.admin!, true, false),
    ], dataFor("set_admin", (w) => w.fixed32(newAdmin, "newAdmin")));
  },
  setArbiter(k: Keyset, newArbiter: Uint8Array, programId: string) {
    return build(programId, "set_arbiter", [
      acct(k.marketplace, false, true),
      acct(k.admin!, true, false),
    ], dataFor("set_arbiter", (w) => w.fixed32(newArbiter, "newArbiter")));
  },
  setFeeBps(k: Keyset, feeBps: number, programId: string) {
    return build(programId, "set_fee_bps", [
      acct(k.marketplace, false, true),
      acct(k.admin!, true, false),
    ], dataFor("set_fee_bps", (w) => w.u16(feeBps)));
  },
  registerProvider(k: Keyset, endpointHash: Uint8Array, minStake: number, programId: string) {
    return build(programId, "register_provider", [
      acct(k.marketplace, false, true),
      acct(k.provider!, false, true),
      acct(k.owner!, true, true),
      acct(sys(k.systemProgram), false, false),
    ], dataFor("register_provider", (w) => w.fixed32(endpointHash, "endpointHash").u64(minStake)));
  },
  unstake(k: Keyset, programId: string) {
    return build(programId, "unstake", [
      acct(k.provider!, false, true),
      acct(k.owner!, true, true),
    ], dataFor("unstake", () => undefined));
  },
  listModel(k: Keyset, modelIdHash: Uint8Array, pricePer1k: number, maxTokens: number, programId: string) {
    return build(programId, "list_model", [
      acct(k.provider!, false, false),
      acct(k.listing!, false, true),
      acct(k.owner!, true, true),
      acct(sys(k.systemProgram), false, false),
    ], dataFor("list_model", (w) => w.fixed32(modelIdHash, "modelIdHash").u64(pricePer1k).u32(maxTokens)));
  },
  createJob(
    k: Keyset, inputHash: Uint8Array, modelIdHash: Uint8Array,
    budget: number, maxTokens: number, deadlineSlots: number, programId: string,
  ) {
    return build(programId, "create_job", [
      acct(k.marketplace, false, true),
      acct(k.job!, false, true),
      acct(k.vault!, false, true),
      acct(k.requester!, true, true),
      acct(sys(k.systemProgram), false, false),
    ], dataFor("create_job", (w) =>
      w.fixed32(inputHash, "inputHash").fixed32(modelIdHash, "modelIdHash")
        .u64(budget).u32(maxTokens).u64(deadlineSlots)));
  },
  claimJob(k: Keyset, programId: string) {
    return build(programId, "claim_job", [
      acct(k.job!, false, true),
      acct(k.provider!, false, false),
      acct(k.listing!, false, false),
      acct(k.claimer!, true, false),
    ], dataFor("claim_job", () => undefined));
  },
  submitResult(k: Keyset, resultHash: Uint8Array, inputTokens: number, outputTokens: number, programId: string) {
    return build(programId, "submit_result", [
      acct(k.job!, false, true),
      acct(k.provider!, false, false),
      acct(k.submitter!, true, false),
    ], dataFor("submit_result", (w) =>
      w.fixed32(resultHash, "resultHash").u32(inputTokens).u32(outputTokens)));
  },
  confirmResult(k: Keyset, programId: string) {
    return build(programId, "confirm_result", [
      acct(k.marketplace, false, false),
      acct(k.job!, false, true),
      acct(k.provider!, false, true),
      acct(k.requester!, true, true),
      acct(k.providerRecipient!, false, true),
      acct(k.treasury!, false, true),
      acct(k.vault!, false, true),
    ], dataFor("confirm_result", () => undefined));
  },
  finalizeJob(k: Keyset, programId: string) {
    return build(programId, "finalize_job", [
      acct(k.marketplace, false, false),
      acct(k.job!, false, true),
      acct(k.provider!, false, true),
      acct(k.requester!, false, true),
      acct(k.providerRecipient!, false, true),
      acct(k.treasury!, false, true),
      acct(k.vault!, false, true),
      acct(k.caller!, true, false),
    ], dataFor("finalize_job", () => undefined));
  },
  timeoutRefund(k: Keyset, provider: Uint8Array | null, programId: string) {
    // Anchor decodes a mid-list Option<Account> by program-ID filler: when
    // the account key equals the program ID it pops it and treats it as None
    // (anchor-lang/src/accounts/option.rs). Positions of the accounts after
    // it are unchanged, so the filler keeps requester/vault aligned.
    const filler = provider ?? bs58Decode(programId);
    const accounts = [
      acct(k.job!, false, true),
      acct(filler, false, provider !== null),
      acct(k.requester!, false, true),
      acct(k.vault!, false, true),
    ];
    return build(programId, "timeout_refund", accounts, dataFor("timeout_refund", () => undefined));
  },
  raiseDispute(k: Keyset, programId: string) {
    return build(programId, "raise_dispute", [
      acct(k.job!, false, true),
      acct(k.vault!, false, true),
      acct(k.requester!, true, true),
      acct(sys(k.systemProgram), false, false),
    ], dataFor("raise_dispute", () => undefined));
  },
  cancelDispute(k: Keyset, programId: string) {
    return build(programId, "cancel_dispute", [
      acct(k.job!, false, true),
      acct(k.vault!, false, true),
      acct(k.requester!, true, true),
    ], dataFor("cancel_dispute", () => undefined));
  },
  resolveDispute(k: Keyset, providerWins: boolean, programId: string) {
    return build(programId, "resolve_dispute", [
      acct(k.marketplace, false, false),
      acct(k.arbiter!, true, false),
      acct(k.job!, false, true),
      acct(k.provider!, false, true),
      acct(k.requester!, false, true),
      acct(k.providerRecipient!, false, true),
      acct(k.treasury!, false, true),
      acct(k.vault!, false, true),
    ], dataFor("resolve_dispute", (w) => w.bool(providerWins)));
  },
};

export { hex };
