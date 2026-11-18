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
}

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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
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

export function settleAmounts(budget: number, feeBps: number): { payout: number; fee: number } {
  const fee = Math.floor((budget * feeBps) / 10_000);
  return { payout: budget - fee, fee };
}

export function bumpScore(scoreX100: number, success: boolean): number {
  if (success) return Math.min(10_000, scoreX100 + 25);
  return Math.max(0, scoreX100 - 150);
}

// ---------------------------------------------------------------- PDA seeds

export function marketplaceSeeds(): Uint8Array[] {
  return [new TextEncoder().encode("marketplace")];
}

export function providerSeeds(marketplace: string, owner: string): Uint8Array[] {
  const enc = new TextEncoder();
  return [enc.encode("provider"), enc.encode(marketplace), enc.encode(owner)];
}

export function jobSeeds(marketplace: string, jobId: number): Uint8Array[] {
  const enc = new TextEncoder();
  const id = new ArrayBuffer(8);
  new DataView(id).setBigUint64(0, BigInt(jobId), true);
  return [enc.encode("job"), enc.encode(marketplace), new Uint8Array(id)];
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
}

export class MockLedger {
  providers = new Map<string, ProviderInfo>();
  jobs = new Map<number, JobInfo>();
  events: LedgerEvent[] = [];
  feeBps: number;
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

  async submitResult(jobId: number, providerId: string, output: string, latencyMs: number): Promise<JobInfo> {
    const job = this.mustJob(jobId);
    if (job.state !== JobState.Claimed) throw new Error("job is not claimed");
    if (job.providerId !== providerId) throw new Error("not the assigned provider");
    job.output = output;
    job.resultHash = await resultCommitment(job.input, output, job.modelId);
    job.latencyMs = latencyMs;
    job.state = JobState.Submitted;
    this.emit("job.submitted", jobId, providerId, `${output.length} chars`);
    return job;
  }

  confirmResult(jobId: number, requester: string): { job: JobInfo; payout: number; fee: number } {
    const job = this.mustJob(jobId);
    if (job.state !== JobState.Submitted) throw new Error("no result to confirm");
    if (job.requester !== requester) throw new Error("only the requester can confirm");
    const provider = this.mustProvider(job.providerId!);
    const { payout, fee } = settleAmounts(job.budgetLamports, this.feeBps);
    job.state = JobState.Confirmed;
    provider.completedJobs += 1;
    provider.scoreX100 = bumpScore(provider.scoreX100, true);
    provider.avgLatencyMs =
      (provider.avgLatencyMs * (provider.completedJobs - 1) + (job.latencyMs ?? 0)) / provider.completedJobs;
    this.emit("job.confirmed", jobId, provider.id, `payout=${payout} fee=${fee}`);
    return { job, payout, fee };
  }

  timeoutRefund(jobId: number): JobInfo {
    const job = this.mustJob(jobId);
    if (job.state !== JobState.Open && job.state !== JobState.Claimed) {
      throw new Error("job is not refundable");
    }
    if (Date.now() < job.deadlineAt) throw new Error("deadline has not passed");
    job.state = JobState.Refunded;
    if (job.providerId) {
      const provider = this.mustProvider(job.providerId);
      provider.failedJobs += 1;
      provider.scoreX100 = bumpScore(provider.scoreX100, false);
    }
    this.emit("job.refunded", jobId, job.providerId ?? undefined);
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
    const jobs = [...this.jobs.values()];
    const unsettled = jobs.filter((j) => j.state <= JobState.Submitted);
    const terminal = jobs.filter((j) => j.state > JobState.Submitted).slice(-1_000);
    return {
      version: 1,
      feeBps: this.feeBps,
      nextJobId: this.nextJobId,
      providers: [...this.providers.values()],
      jobs: [...unsettled, ...terminal].sort((a, b) => a.id - b.id),
      events: this.events.slice(-500),
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
    this.providers = new Map(snap.providers.map((p) => [p.id, p]));
    this.jobs = new Map(snap.jobs.map((j) => [j.id, j]));
    this.events = snap.events;
    this.nextJobId = snap.nextJobId;
    if (Number.isInteger(snap.feeBps)) this.feeBps = snap.feeBps;
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
