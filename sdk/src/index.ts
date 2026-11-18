/**
 * @infermesh/sdk — zero-dependency client helpers for the InferMesh
 * open AI-inference marketplace (Solana RFS: "An open marketplace
 * for AI inference").
 *
 * What this covers:
 * - canonical commitment scheme: result_hash = sha256(input || output || modelId)
 * - fee math identical to the on-chain program (`settle_amounts`)
 * - reputation math identical to the on-chain program (`bump_score`)
 * - PDA seed builders (combine with @solana/web3.js in the app)
 * - an in-memory MockLedger implementing the same job state machine,
 *   so the demo runs with zero chain dependency (demo mode).
 */

export const PROGRAM_ID = "FMesh11111111111111111111111111111111111111";

export enum JobState {
  Open = 0,
  Claimed = 1,
  Submitted = 2,
  Confirmed = 3,
  Refunded = 4,
  Disputed = 5,
  /** Paid out via permissionless finalize after the confirm window. */
  Finalized = 6,
}

/** Demo confirm window (mirrors CONFIRM_WINDOW_SLOTS onchain). */
export const CONFIRM_WINDOW_MS = 120_000;
/** Demo arbiter timeout for stale disputes (mirrors ARBITER_TIMEOUT_SLOTS). */
export const ARBITER_TIMEOUT_MS = 300_000;

export interface ProviderInfo {
  id: string;
  owner: string;
  modelIds: string[];
  pricePer1kTokensLamports: number;
  stakeLamports: number;
  completedJobs: number;
  failedJobs: number;
  /** 0..10000 (100x). Starts at 1000. */
  scoreX100: number;
  avgLatencyMs: number;
  /** Spot-check record: reference-output agreement vs the claimed model. */
  spotCheckPass: number;
  spotCheckTotal: number;
  active: boolean;
}

export interface JobInfo {
  id: number;
  requester: string;
  providerId: string | null;
  modelId: string;
  input: string;
  inputHash: string;
  output: string | null;
  resultHash: string | null;
  /** Token-overlap vs a reference run of the claimed model; null = not sampled. */
  spotCheckAgreement: number | null;
  /** Metering records (self-reported by the provider, capped by maxTokens). */
  inputTokens: number;
  outputTokens: number;
  submittedAt: number | null;
  /** Bond posted on dispute; goes to the winner at resolution. */
  disputeBond: number;
  disputedAt: number | null;
  budgetLamports: number;
  maxTokens: number;
  state: JobState;
  createdAt: number;
  deadlineAt: number;
  latencyMs: number | null;
}

// ---------------------------------------------------------------- crypto

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  // Copy into a plain ArrayBuffer: newer @types/node types TextEncoder
  // output as Uint8Array<ArrayBufferLike>, which lib.dom's BufferSource
  // rejects. Runtime value is always an ArrayBuffer (never shared).
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(digest);
}

/** Canonical input commitment. */
export function inputCommitment(input: string, modelId: string): Promise<string> {
  return sha256Hex(`${modelId}\n${input}`);
}

/** Canonical result commitment: sha256(input || output || modelId). */
export function resultCommitment(input: string, output: string, modelId: string): Promise<string> {
  return sha256Hex(`${input}\n${output}\n${modelId}`);
}

/**
 * Recompute and compare — this proves the output was NOT TAMPERED WITH after
 * submission. It does NOT prove which model ran: the hash is computed from the
 * model the requester asked for, so a provider that quietly substitutes a
 * cheaper model still verifies. Model authenticity comes from spot-checks
 * (see textSimilarity / recordSpotCheck), not from this hash.
 */
export async function verifyResult(
  input: string,
  output: string,
  modelId: string,
  expectedHash: string,
): Promise<boolean> {
  return (await resultCommitment(input, output, modelId)) === expectedHash;
}

// ---------------------------------------------------------------- spot-checks
//
// First version of real model-authenticity verification: the marketplace
// re-runs a sampled job through a trusted reference backend for the CLAIMED
// model and compares the two outputs. Same-model outputs share vocabulary and
// structure (high token overlap); a substituted cheaper model diverges.
// Probabilistic, not a proof — TEE/attestation receipts are the upgrade path.

/** Agreement at or above this counts as a passed spot-check. */
export const SPOT_CHECK_THRESHOLD = 0.5;

/** Jaccard similarity over lowercase alphanumeric tokens (length > 1). */
export function textSimilarity(a: string, b: string): number {
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1),
    );
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------------------------------------------------------------- math (mirrors programs/infermesh)

export const MIN_DISPUTE_BOND = 50_000;

export function settleAmounts(budget: number, feeBps: number): { payout: number; fee: number } {
  const fee = Math.floor((budget * feeBps) / 10_000);
  return { payout: budget - fee, fee };
}

/** Value-weighted reputation points (mirrors score_points onchain). */
export function scorePoints(budget: number, success: boolean): number {
  if (!Number.isFinite(budget) || budget < 0) return success ? 5 : 25;
  if (success) return Math.min(100, Math.max(5, Math.floor(budget / 5_000)));
  return Math.min(400, Math.max(25, Math.floor(budget / 2_500)));
}

export function bumpScore(scoreX100: number, success: boolean, points: number): number {
  if (success) return Math.min(10_000, scoreX100 + points);
  return Math.max(0, scoreX100 - points);
}

/** Dispute bond: 10% of budget floored (mirrors dispute_bond onchain). */
export function disputeBond(budget: number): number {
  return Math.max(MIN_DISPUTE_BOND, Math.floor(budget / 10));
}

/** Stake slashed on timeouts and lost disputes: 5% (mirrors slash_amount). */
export function slashAmount(stake: number): number {
  return Math.floor(stake / 20);
}

/**
 * Audit sampling rate for a job: high-value jobs on low-stake providers get
 * audited near-always; micro-jobs on deep-stake providers rarely. Who pays
 * is explicit: the protocol fee funds reference runs, and the rate formula
 * is public so requesters see what detection their fee bought.
 */
export function auditRate(budget: number, stake: number): number {
  if (!(stake > 0)) return 1;
  return Math.min(1, 0.15 + (5 * budget) / stake);
}

// ---------------------------------------------------------------- PDA seeds
// Byte-exact mirrors of the onchain seeds in programs/infermesh/src/lib.rs.
// All keys are raw 32-byte public keys; pass them straight to
// PublicKey.findProgramAddress along with these seed arrays.

function assertKey(bytes: Uint8Array, name: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error(`${name} must be a 32-byte public key`);
  }
}

function u64le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error("counter must be a non-negative integer");
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(n), true);
  return new Uint8Array(buf);
}

export function marketplaceSeedBytes(): Uint8Array[] {
  return [new TextEncoder().encode("marketplace")];
}

export function providerSeedBytes(marketplace: Uint8Array, owner: Uint8Array): Uint8Array[] {
  assertKey(marketplace, "marketplace");
  assertKey(owner, "owner");
  return [new TextEncoder().encode("provider"), marketplace, owner];
}

export function listingSeedBytes(provider: Uint8Array, modelIdHash: Uint8Array): Uint8Array[] {
  assertKey(provider, "provider");
  if (!(modelIdHash instanceof Uint8Array) || modelIdHash.length !== 32) {
    throw new Error("modelIdHash must be 32 bytes");
  }
  return [new TextEncoder().encode("listing"), provider, modelIdHash];
}

export function jobSeedBytes(marketplace: Uint8Array, jobCounter: number): Uint8Array[] {
  assertKey(marketplace, "marketplace");
  return [new TextEncoder().encode("job"), marketplace, u64le(jobCounter)];
}

export function vaultSeedBytes(job: Uint8Array): Uint8Array[] {
  assertKey(job, "job");
  return [new TextEncoder().encode("vault"), job];
}

// ---------------------------------------------------------------- validation

export const LIMITS = {
  maxInputChars: 4_000,
  maxRequesterChars: 128,
  maxModelIdChars: 128,
  maxProviderIdChars: 64,
  maxBudgetLamports: 1_000_000_000_000, // 1000 SOL
  maxTokens: 8_192,
  maxModelsPerProvider: 16,
} as const;

const ID_CHARSET = /^[A-Za-z0-9_.-]+$/;

function checkId(value: string, field: string, max: number): void {
  if (!value || value.length > max) throw new Error(`${field} must be 1-${max} chars`);
  if (!ID_CHARSET.test(value)) throw new Error(`${field} uses invalid characters`);
}

export function validateJobParams(
  requester: string,
  modelId: string,
  input: string,
  budgetLamports: number,
  maxTokens: number,
): void {
  checkId(requester, "requester", LIMITS.maxRequesterChars);
  checkId(modelId, "modelId", LIMITS.maxModelIdChars);
  if (!input.trim()) throw new Error("input must be non-empty");
  if (input.length > LIMITS.maxInputChars) {
    throw new Error(`input exceeds ${LIMITS.maxInputChars} chars`);
  }
  if (!Number.isInteger(budgetLamports) || budgetLamports <= 0) {
    throw new Error("budget must be a positive integer");
  }
  if (budgetLamports > LIMITS.maxBudgetLamports) {
    throw new Error("budget exceeds maximum");
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > LIMITS.maxTokens) {
    throw new Error(`maxTokens must be 1-${LIMITS.maxTokens}`);
  }
}

export function validateProviderParams(
  id: string,
  modelIds: string[],
  pricePer1kTokensLamports: number,
  stakeLamports: number,
): void {
  checkId(id, "provider id", LIMITS.maxProviderIdChars);
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    throw new Error("provider must serve at least one model");
  }
  if (modelIds.length > LIMITS.maxModelsPerProvider) {
    throw new Error("too many models for one provider");
  }
  for (const m of modelIds) checkId(m, "model id", LIMITS.maxModelIdChars);
  for (const [v, name] of [
    [pricePer1kTokensLamports, "price"],
    [stakeLamports, "stake"],
  ] as const) {
    if (!Number.isInteger(v) || v <= 0 || v > LIMITS.maxBudgetLamports) {
      throw new Error(`${name} must be a positive integer within limits`);
    }
  }
}

// ---------------------------------------------------------------- MockLedger (demo mode)

export interface LedgerEvent {
  type: string;
  at: number;
  jobId?: number;
  providerId?: string;
  detail?: string;
}

export interface LedgerSnapshot {
  version: 1;
  feeBps: number;
  nextJobId: number;
  providers: ProviderInfo[];
  jobs: JobInfo[];
  events: LedgerEvent[];
  spend: Array<[string, number]>;
  maxSpendPerRequester: number | null;
}

export class MockLedger {
  providers = new Map<string, ProviderInfo>();
  jobs = new Map<number, JobInfo>();
  events: LedgerEvent[] = [];
  feeBps: number;
  /** Optional per-requester escrow cap (lamports). Null = unlimited. */
  maxSpendPerRequester: number | null = null;
  spentByRequester = new Map<string, number>();
  private nextJobId = 1;

  constructor(feeBps = 250) {
    this.feeBps = feeBps;
  }

  private emit(type: string, jobId?: number, providerId?: string, detail?: string) {
    this.events.push({ type, at: Date.now(), jobId, providerId, detail });
  }

  registerProvider(p: Omit<ProviderInfo, "completedJobs" | "failedJobs" | "scoreX100" | "avgLatencyMs" | "spotCheckPass" | "spotCheckTotal" | "active">): ProviderInfo {
    validateProviderParams(p.id, p.modelIds, p.pricePer1kTokensLamports, p.stakeLamports);
    if (this.providers.has(p.id)) throw new Error(`provider ${p.id} already registered`);
    const full: ProviderInfo = {
      ...p,
      completedJobs: 0,
      failedJobs: 0,
      scoreX100: 1000,
      avgLatencyMs: 0,
      spotCheckPass: 0,
      spotCheckTotal: 0,
      active: true,
    };
    this.providers.set(p.id, full);
    this.emit("provider.registered", undefined, p.id, p.modelIds.join(","));
    return full;
  }

  async createJob(requester: string, modelId: string, input: string, budgetLamports: number, maxTokens: number, ttlMs = 120_000): Promise<JobInfo> {
    validateJobParams(requester, modelId, input, budgetLamports, maxTokens);
    const spent = this.spentByRequester.get(requester) ?? 0;
    if (this.maxSpendPerRequester !== null && spent + budgetLamports > this.maxSpendPerRequester) {
      throw new Error("requester spend cap exceeded");
    }
    this.spentByRequester.set(requester, spent + budgetLamports);
    const now = Date.now();
    const job: JobInfo = {
      id: this.nextJobId++,
      requester,
      providerId: null,
      modelId,
      input,
      inputHash: await inputCommitment(input, modelId),
      output: null,
      resultHash: null,
      spotCheckAgreement: null,
      inputTokens: 0,
      outputTokens: 0,
      submittedAt: null,
      disputeBond: 0,
      disputedAt: null,
      budgetLamports,
      maxTokens,
      state: JobState.Open,
      createdAt: now,
      deadlineAt: now + ttlMs,
      latencyMs: null,
    };
    this.jobs.set(job.id, job);
    this.emit("job.opened", job.id, undefined, modelId);
    return job;
  }

  claimJob(jobId: number, providerId: string): JobInfo {
    const job = this.mustJob(jobId);
    const provider = this.mustProvider(providerId);
    if (job.state !== JobState.Open) throw new Error("job is not open");
    if (Date.now() > job.deadlineAt) throw new Error("job expired");
    if (!provider.active) throw new Error("provider inactive");
    if (!provider.modelIds.includes(job.modelId)) throw new Error("provider does not serve this model");
    job.providerId = providerId;
    job.state = JobState.Claimed;
    this.emit("job.claimed", jobId, providerId);
    return job;
  }

  async submitResult(
    jobId: number,
    providerId: string,
    output: string,
    latencyMs: number,
    inputTokens?: number,
    outputTokens?: number,
  ): Promise<JobInfo> {
    const job = this.mustJob(jobId);
    if (job.state !== JobState.Claimed) throw new Error("job is not claimed");
    if (job.providerId !== providerId) throw new Error("not the assigned provider");
    const estimate = (s: string) => Math.max(1, Math.floor(s.length / 4));
    job.inputTokens = inputTokens ?? estimate(job.input);
    job.outputTokens = outputTokens ?? estimate(output);
    if (job.inputTokens <= 0 || job.outputTokens <= 0) {
      throw new Error("token counts must be positive");
    }
    if (job.inputTokens > job.maxTokens || job.outputTokens > job.maxTokens) {
      throw new Error("token counts exceed job maxTokens");
    }
    job.output = output;
    job.resultHash = await resultCommitment(job.input, output, job.modelId);
    job.latencyMs = latencyMs;
    job.submittedAt = Date.now();
    job.state = JobState.Submitted;
    this.emit("job.submitted", jobId, providerId, `${output.length} chars`);
    return job;
  }

  /** Shared payout path; terminal is Confirmed (requester) or Finalized (anyone). */
  private payOut(job: JobInfo, terminal: JobState.Confirmed | JobState.Finalized): { payout: number; fee: number } {
    const provider = this.mustProvider(job.providerId!);
    const { payout, fee } = settleAmounts(job.budgetLamports, this.feeBps);
    job.state = terminal;
    provider.completedJobs += 1;
    provider.scoreX100 = bumpScore(
      provider.scoreX100,
      true,
      scorePoints(job.budgetLamports, true),
    );
    provider.avgLatencyMs =
      (provider.avgLatencyMs * (provider.completedJobs - 1) + (job.latencyMs ?? 0)) / provider.completedJobs;
    const label = terminal === JobState.Confirmed ? "job.confirmed" : "job.finalized";
    this.emit(label, job.id, provider.id, `payout=${payout} fee=${fee}`);
    return { payout, fee };
  }

  /** Shared slash path: 5% of stake to the requester + weighted score hit. */
  private slash(job: JobInfo): number {
    if (!job.providerId) return 0;
    const provider = this.mustProvider(job.providerId);
    const slashed = Math.min(provider.stakeLamports, slashAmount(provider.stakeLamports));
    provider.stakeLamports -= slashed;
    provider.failedJobs += 1;
    provider.scoreX100 = bumpScore(
      provider.scoreX100,
      false,
      scorePoints(job.budgetLamports, false),
    );
    return slashed;
  }

  confirmResult(jobId: number, requester: string): { job: JobInfo; payout: number; fee: number } {
    const job = this.mustJob(jobId);
    if (job.state !== JobState.Submitted) throw new Error("no result to confirm");
    if (job.requester !== requester) throw new Error("only the requester can confirm");
    if (job.submittedAt !== null && Date.now() > job.submittedAt + CONFIRM_WINDOW_MS) {
      throw new Error("confirm window passed; anyone may finalize instead");
    }
    return { job, ...this.payOut(job, JobState.Confirmed) };
  }

  /**
   * Permissionless optimistic auto-release: once the confirm window passes
   * with no dispute, anyone can finalize payout. Getting paid is never
   * optional for the buyer.
   */
  finalizeJob(jobId: number): { job: JobInfo; payout: number; fee: number } {
    const job = this.mustJob(jobId);
    if (job.state !== JobState.Submitted) throw new Error("job is not finalizable");
    if (job.submittedAt === null || Date.now() < job.submittedAt + CONFIRM_WINDOW_MS) {
      throw new Error("confirm window has not passed");
    }
    return { job, ...this.payOut(job, JobState.Finalized) };
  }

  /**
   * Requester opens a bonded dispute. The bond goes to the winner at
   * resolution, so frivolous disputes cost money.
   */
  flagDispute(jobId: number, requester: string): JobInfo {
    const job = this.mustJob(jobId);
    if (job.state !== JobState.Submitted) throw new Error("only submitted jobs can be disputed");
    if (job.requester !== requester) throw new Error("only the requester can dispute");
    job.disputeBond = disputeBond(job.budgetLamports);
    job.disputedAt = Date.now();
    job.state = JobState.Disputed;
    this.emit("job.disputed", jobId, job.providerId ?? undefined, `bond=${job.disputeBond}`);
    return job;
  }

  /** Requester withdraws their own dispute; the job returns to Submitted. */
  cancelDispute(jobId: number, requester: string): JobInfo {
    const job = this.mustJob(jobId);
    if (job.state !== JobState.Disputed) throw new Error("job is not disputed");
    if (job.requester !== requester) throw new Error("only the requester can cancel");
    job.disputeBond = 0;
    job.disputedAt = null;
    job.state = JobState.Submitted;
    this.emit("job.undisputed", jobId, job.providerId ?? undefined);
    return job;
  }

  /**
   * Demo stand-in for the named onchain arbiter (resolve_dispute). Provider
   * wins: payout like a confirm plus the bond as compensation. Requester
   * wins: budget + bond back, stake slashed, score down.
   */
  resolveDispute(jobId: number, providerWins: boolean): { job: JobInfo; payout: number; fee: number } {
    const job = this.mustJob(jobId);
    if (job.state !== JobState.Disputed) throw new Error("job is not disputed");
    const provider = this.mustProvider(job.providerId!);
    if (providerWins) {
      const bond = job.disputeBond;
      job.disputeBond = 0;
      job.disputedAt = null;
      const receipt = this.payOut(job, JobState.Confirmed);
      this.emit("dispute.resolved", jobId, provider.id, `winner=provider bond=${bond}`);
      return { job, ...receipt };
    }
    const refund = job.budgetLamports + job.disputeBond;
    job.disputeBond = 0;
    job.disputedAt = null;
    const slashed = this.slash(job);
    job.state = JobState.Refunded;
    this.emit("dispute.resolved", jobId, provider.id, `winner=requester refund=${refund} slash=${slashed}`);
    return { job, payout: 0, fee: 0 };
  }

  timeoutRefund(jobId: number): JobInfo {
    const job = this.mustJob(jobId);
    const staleDispute =
      job.state === JobState.Disputed &&
      job.disputedAt !== null &&
      Date.now() >= job.disputedAt + ARBITER_TIMEOUT_MS;
    if (!staleDispute) {
      if (job.state !== JobState.Open && job.state !== JobState.Claimed) {
        throw new Error("job is not refundable");
      }
      if (Date.now() < job.deadlineAt) throw new Error("deadline has not passed");
    }
    job.state = JobState.Refunded;
    // A stale dispute also returns the bond (the arbiter never showed).
    const returned = staleDispute ? job.disputeBond : 0;
    job.disputeBond = 0;
    const slashed = this.slash(job);
    this.emit(
      "job.refunded",
      jobId,
      job.providerId ?? undefined,
      `slash=${slashed} bond_returned=${returned}`,
    );
    return job;
  }

  leaderboard(): ProviderInfo[] {
    return [...this.providers.values()].sort((a, b) => b.scoreX100 - a.scoreX100);
  }

  /**
   * Record a spot-check outcome for a provider. The agreement score comes
   * from comparing the submitted output against a trusted reference run of
   * the CLAIMED model (see textSimilarity). Never call with a score computed
   * against any other model — that would invert the signal.
   */
  recordSpotCheck(providerId: string, agreement: number): { passed: boolean; agreement: number } {
    const provider = this.mustProvider(providerId);
    if (!Number.isFinite(agreement) || agreement < 0 || agreement > 1) {
      throw new Error("agreement must be in [0, 1]");
    }
    const passed = agreement >= SPOT_CHECK_THRESHOLD;
    provider.spotCheckTotal += 1;
    if (passed) provider.spotCheckPass += 1;
    this.emit("spotcheck", undefined, providerId, `agreement=${agreement.toFixed(3)} ${passed ? "pass" : "FLAG"}`);
    return { passed, agreement };
  }

  /** Serialize full ledger state for crash-safe persistence. */
  snapshot(): LedgerSnapshot {
    // Cap growth: always keep unsettled jobs, plus the newest terminal ones.
    // Note: Disputed counts as terminal for pruning but is never pruned while
    // open — disputed jobs stay until resolved, refunded, or finalized.
    const jobs = [...this.jobs.values()];
    const keep = (j: JobInfo) =>
      j.state <= JobState.Submitted || j.state === JobState.Disputed;
    const unsettled = jobs.filter(keep);
    const terminal = jobs.filter((j) => !keep(j)).slice(-1_000);
    return {
      version: 1,
      feeBps: this.feeBps,
      nextJobId: this.nextJobId,
      providers: [...this.providers.values()],
      jobs: [...unsettled, ...terminal].sort((a, b) => a.id - b.id),
      events: this.events.slice(-500),
      spend: [...this.spentByRequester],
      maxSpendPerRequester: this.maxSpendPerRequester,
    };
  }

  /** Restore from a snapshot; rejects malformed or oversized payloads. */
  restore(snap: LedgerSnapshot): void {
    if (!snap || snap.version !== 1) throw new Error("unsupported snapshot version");
    if (!Array.isArray(snap.providers) || !Array.isArray(snap.jobs) || !Array.isArray(snap.events)) {
      throw new Error("malformed snapshot");
    }
    if (snap.providers.length > 10_000 || snap.jobs.length > 100_000 || snap.events.length > 500) {
      throw new Error("snapshot exceeds size limits");
    }
    if (!Number.isInteger(snap.nextJobId) || snap.nextJobId < 1) {
      throw new Error("malformed snapshot");
    }
    // Forward-migrate older snapshots: fields added by later versions
    // default to their zero values instead of staying undefined.
    for (const p of snap.providers) {
      p.spotCheckPass ??= 0;
      p.spotCheckTotal ??= 0;
    }
    for (const j of snap.jobs) {
      j.spotCheckAgreement ??= null;
      j.inputTokens ??= 0;
      j.outputTokens ??= 0;
      j.submittedAt ??= null;
      j.disputeBond ??= 0;
      j.disputedAt ??= null;
    }
    this.providers = new Map(snap.providers.map((p) => [p.id, p]));
    this.jobs = new Map(snap.jobs.map((j) => [j.id, j]));
    this.events = snap.events;
    this.nextJobId = snap.nextJobId;
    if (Number.isInteger(snap.feeBps)) this.feeBps = snap.feeBps;
    if (Array.isArray(snap.spend)) {
      this.spentByRequester = new Map(
        snap.spend.filter(([k, v]) => typeof k === "string" && Number.isInteger(v)),
      );
    }
    if (snap.maxSpendPerRequester === null || Number.isInteger(snap.maxSpendPerRequester)) {
      this.maxSpendPerRequester = snap.maxSpendPerRequester;
    }
  }

  private mustJob(jobId: number): JobInfo {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    return job;
  }

  private mustProvider(providerId: string): ProviderInfo {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`unknown provider ${providerId}`);
    return provider;
  }
}

// Onchain client builders (discriminators, account layouts, PDA seeds).
export { DISCRIMINANTS, Instructions, bs58Decode } from "./instructions.js";
