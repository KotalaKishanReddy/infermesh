import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRM_WINDOW_MS,
  JobState,
  MockLedger,
  SPOT_CHECK_THRESHOLD,
  auditRate,
  bumpScore,
  disputeBond,
  resultCommitment,
  scorePoints,
  settleAmounts,
  slashAmount,
  textSimilarity,
  validateJobParams,
  verifyResult,
} from "../dist/index.js";

describe("fee math mirrors the on-chain program", () => {
  it("splits 2.5% fee correctly", () => {
    assert.deepEqual(settleAmounts(1_000_000, 250), { payout: 975_000, fee: 25_000 });
  });
  it("handles zero fee", () => {
    assert.deepEqual(settleAmounts(500, 0), { payout: 500, fee: 0 });
  });
});

describe("value-weighted reputation math", () => {
  it("scales points with budget and saturates", () => {
    assert.equal(scorePoints(1_000, true), 5);
    assert.equal(scorePoints(1_000, false), 25);
    assert.equal(scorePoints(250_000, true), 50);
    assert.equal(scorePoints(1_000_000_000_000, true), 100);
    assert.equal(scorePoints(1_000_000_000_000, false), 400);
    assert.equal(bumpScore(9990, true, 100), 10_000);
    assert.equal(bumpScore(100, false, 400), 0);
  });

  it("bonds, slashes, and audit rates follow the onchain formulas", () => {
    assert.equal(disputeBond(1_000_000), 100_000);
    assert.equal(disputeBond(100_000), 50_000); // floored, mirrors MIN_DISPUTE_BOND
    assert.equal(slashAmount(500_000), 25_000); // 5%
    assert.equal(auditRate(50_000, 250_000), 1); // high value / low stake: always
    assert.ok(auditRate(10_000, 1_000_000) < 0.3); // micro-job, deep stake: rarely
    assert.equal(auditRate(10_000, 0), 1); // no stake info: audit
  });
});

describe("commitment scheme", () => {
  it("verifies the model that handled a request", async () => {
    const hash = await resultCommitment("say hi", "hello there", "llama-3-8b");
    assert.equal(await verifyResult("say hi", "hello there", "llama-3-8b", hash), true);
    // Wrong model id must NOT verify — this is the anti-spoofing property.
    assert.equal(await verifyResult("say hi", "hello there", "other-model", hash), false);
  });
});

describe("MockLedger job lifecycle", () => {
  it("open -> claim -> submit -> confirm pays out and builds reputation", async () => {
    const ledger = new MockLedger(250);
    ledger.registerProvider({
      id: "gpu-1",
      owner: "owner1",
      modelIds: ["llama-3-8b"],
      pricePer1kTokensLamports: 5000,
      stakeLamports: 100_000,
    });
    const job = await ledger.createJob("alice", "llama-3-8b", "summarize solana", 100_000, 512);
    assert.equal(job.state, JobState.Open);

    ledger.claimJob(job.id, "gpu-1");
    assert.equal(ledger.jobs.get(job.id).state, JobState.Claimed);

    await ledger.submitResult(job.id, "gpu-1", "Solana is fast.", 320);
    assert.equal(ledger.jobs.get(job.id).state, JobState.Submitted);

    const { payout, fee } = ledger.confirmResult(job.id, "alice");
    assert.equal(payout, 97_500);
    assert.equal(fee, 2_500);
    assert.equal(ledger.providers.get("gpu-1").completedJobs, 1);
  });

  it("rejects claim by a provider that does not serve the model", async () => {
    const ledger = new MockLedger();
    ledger.registerProvider({
      id: "gpu-2",
      owner: "owner2",
      modelIds: ["mistral-7b"],
      pricePer1kTokensLamports: 4000,
      stakeLamports: 50_000,
    });
    const job = await ledger.createJob("bob", "llama-3-8b", "hi", 10_000, 128);
    assert.throws(() => ledger.claimJob(job.id, "gpu-2"), /does not serve/);
  });

  it("rejects hostile or oversized job params", async () => {
    assert.throws(() => validateJobParams("a".repeat(200), "m", "hi", 10, 8), /requester/);
    assert.throws(() => validateJobParams("alice", "m;rm -rf", "hi", 10, 8), /invalid characters/);
    assert.throws(() => validateJobParams("alice", "m", "x".repeat(5000), 10, 8), /exceeds/);
    assert.throws(() => validateJobParams("alice", "m", "hi", 0, 8), /positive integer/);
    assert.throws(() => validateJobParams("alice", "m", "hi", 10, 99999), /maxTokens/);
  });

  it("snapshot/restore round-trips and rejects garbage", async () => {
    const ledger = new MockLedger(250);
    ledger.registerProvider({
      id: "gpu-9",
      owner: "owner9",
      modelIds: ["llama-3-8b"],
      pricePer1kTokensLamports: 1000,
      stakeLamports: 10_000,
    });
    await ledger.createJob("zed", "llama-3-8b", "hello", 5000, 64);
    const snap = ledger.snapshot();

    const clone = new MockLedger(999);
    clone.restore(snap);
    assert.equal(clone.jobs.size, 1);
    assert.equal(clone.nextJobId, 2);
    assert.equal(clone.feeBps, 250);

    const legacy = JSON.parse(JSON.stringify(snap));
    delete legacy.providers[0].spotCheckPass;
    delete legacy.providers[0].spotCheckTotal;
    delete legacy.jobs[0].inputTokens;
    const legacyClone = new MockLedger();
    legacyClone.restore(legacy); // must not throw; missing fields get defaults
    assert.equal(legacyClone.providers.get("gpu-9").spotCheckPass, 0);
    assert.equal(legacyClone.providers.get("gpu-9").spotCheckTotal, 0);
    assert.equal(legacyClone.jobs.get(1).inputTokens, 0);
    assert.equal(legacyClone.jobs.get(1).disputeBond, 0);

    assert.throws(() => clone.restore({}), /version/);
    assert.throws(() => clone.restore({ version: 1, providers: [], jobs: [], events: [], nextJobId: 0 }), /malformed/);
    assert.throws(
      () => clone.restore({ version: 1, providers: [], jobs: new Array(100_001).fill(0), events: [], nextJobId: 1 }),
      /size limits/,
    );
  });

  it("spot-checks separate same-model output from substituted models", () => {
    const llamaA = "Here's a concise take on micropayments: key points first, details on demand. (demo inference)";
    const llamaB = "Here's a concise take on micropayments: key points first, details on demand. (demo inference)";
    const codeOut = "// demo code-model response for micropayments\nfunction answer() {\n  return \"wire a hosted model here\";\n}";
    // Identical reference runs agree fully.
    assert.ok(textSimilarity(llamaA, llamaB) >= 0.9);
    // A substituted family diverges below the pass threshold (measured 0.375-0.429 on mock templates).
    assert.ok(textSimilarity(llamaA, codeOut) < SPOT_CHECK_THRESHOLD);
    assert.equal(textSimilarity("", ""), 1);
    assert.equal(textSimilarity("", "hello world"), 0);
  });

  it("recordSpotCheck tracks pass/total and rejects bad scores", async () => {
    const ledger = new MockLedger();
    ledger.registerProvider({
      id: "gpu-spot",
      owner: "ownerS",
      modelIds: ["llama-3-8b"],
      pricePer1kTokensLamports: 1000,
      stakeLamports: 10_000,
    });
    assert.deepEqual(ledger.recordSpotCheck("gpu-spot", 1.0), { passed: true, agreement: 1.0 });
    assert.deepEqual(ledger.recordSpotCheck("gpu-spot", 0.1), { passed: false, agreement: 0.1 });
    const p = ledger.providers.get("gpu-spot");
    assert.equal(p.spotCheckPass, 1);
    assert.equal(p.spotCheckTotal, 2);
    assert.throws(() => ledger.recordSpotCheck("gpu-spot", 1.5), /\[0, 1\]/);
    assert.throws(() => ledger.recordSpotCheck("nope", 0.9), /unknown provider/);
  });

  it("disputes bond, cancel returns to submitted, finalize auto-releases", async () => {
    const ledger = new MockLedger(250);
    ledger.registerProvider({
      id: "gpu-d",
      owner: "ownerD",
      modelIds: ["llama-3-8b"],
      pricePer1kTokensLamports: 1000,
      stakeLamports: 200_000,
    });
    const job = await ledger.createJob("dave", "llama-3-8b", "dispute me", 100_000, 128);
    ledger.claimJob(job.id, "gpu-d");
    await ledger.submitResult(job.id, "gpu-d", "an answer", 100);
    // Confirm works inside the window.
    assert.equal(ledger.jobs.get(job.id).state, 2);

    const disputed = ledger.flagDispute(job.id, "dave");
    assert.equal(disputed.state, JobState.Disputed);
    assert.equal(disputed.disputeBond, 50_000); // floored, not 10k
    assert.throws(() => ledger.confirmResult(job.id, "dave"), /no result to confirm/);
    assert.throws(() => ledger.finalizeJob(job.id), /not finalizable/);

    const undisputed = ledger.cancelDispute(job.id, "dave");
    assert.equal(undisputed.state, JobState.Submitted);
    assert.equal(undisputed.disputeBond, 0);

    // Past the window, anyone finalizes — no requester signature needed.
    ledger.jobs.get(job.id).submittedAt = Date.now() - CONFIRM_WINDOW_MS - 1;
    assert.throws(() => ledger.confirmResult(job.id, "dave"), /confirm window passed/);
    const { payout } = ledger.finalizeJob(job.id);
    assert.equal(payout, 97_500);
    assert.equal(ledger.jobs.get(job.id).state, JobState.Finalized);
  });

  it("stale disputes refund with bond, timeouts slash stake", async () => {
    const ledger = new MockLedger(250);
    ledger.registerProvider({
      id: "gpu-s",
      owner: "ownerS",
      modelIds: ["llama-3-8b"],
      pricePer1kTokensLamports: 1000,
      stakeLamports: 200_000,
    });
    const job = await ledger.createJob("sam", "llama-3-8b", "ghost me", 100_000, 128, 1);
    ledger.claimJob(job.id, "gpu-s");
    await ledger.submitResult(job.id, "gpu-s", "an answer", 100);
    ledger.flagDispute(job.id, "sam");
    ledger.jobs.get(job.id).disputedAt = Date.now() - 400_000; // past arbiter timeout
    ledger.timeoutRefund(job.id); // stale dispute: no throw
    assert.equal(ledger.jobs.get(job.id).state, JobState.Refunded);
    const p = ledger.providers.get("gpu-s");
    assert.equal(p.stakeLamports, 190_000); // 5% slash
    assert.equal(p.failedJobs, 1);
  });

  it("spend caps stop lockup spam", async () => {
    const ledger = new MockLedger(250);
    ledger.maxSpendPerRequester = 60_000;
    await ledger.createJob("capped", "llama-3-8b", "one", 50_000, 64);
    await assert.rejects(
      ledger.createJob("capped", "llama-3-8b", "two", 50_000, 64),
      /spend cap exceeded/,
    );
  });

  it("refunds after the deadline and slashes score", async () => {
    const ledger = new MockLedger();
    ledger.registerProvider({
      id: "gpu-3",
      owner: "owner3",
      modelIds: ["llama-3-8b"],
      pricePer1kTokensLamports: 4000,
      stakeLamports: 50_000,
    });
    const job = await ledger.createJob("carol", "llama-3-8b", "hi", 10_000, 128, 60_000);
    ledger.claimJob(job.id, "gpu-3");
    assert.throws(() => ledger.timeoutRefund(job.id + 999), /unknown job/);
    assert.throws(() => ledger.timeoutRefund(job.id), /deadline has not passed/);
    job.deadlineAt = Date.now() - 1; // simulate expiry
    const refunded = ledger.timeoutRefund(job.id);
    assert.equal(refunded.state, JobState.Refunded);
    assert.equal(ledger.providers.get("gpu-3").failedJobs, 1);
  });
});
