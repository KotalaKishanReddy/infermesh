/**
 * One-command live demo (no video needed): spawns the API + provider daemon,
 * runs a full open -> claim -> submit -> verify -> confirm cycle, prints each
 * step like a narrated walkthrough, then shuts everything down.
 *
 *   npm run build && node demo.mjs
 */
import { spawn } from "node:child_process";
import { verifyResult } from "./sdk/dist/index.js";

const API = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(name, args, env = {}) {
  const child = spawn("node", args, {
    cwd: new URL("./backend/", import.meta.url),
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  child.on("error", (err) => {
    console.error(`[${name}] failed to start: ${err.message}`);
    process.exit(1);
  });
  return child;
}

async function req(path, init) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const api = start("api", ["dist/server.js"], { SPOT_CHECK_RATE: "1" });
const daemon = start("daemon", ["dist/daemon.js"]);
const stop = () => {
  api.kill();
  daemon.kill();
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

try {
  for (let i = 0; i < 30; i++) {
    try {
      await req("/api/health");
      break;
    } catch {
      await sleep(500);
    }
  }
  console.log("1. API + provider daemon are up (3 seeded GPU providers).");

  const { job } = await req("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      requester: "reviewer",
      modelId: "llama-3-8b",
      input: "Why is Solana a good fit for AI micropayments? One sentence.",
      budgetLamports: 60000,
      maxTokens: 256,
    }),
  });
  console.log(`2. Job #${job.id} opened, ${job.budgetLamports} lamports escrowed.`);

  let cur = job;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    cur = (await req("/api/jobs")).jobs.find((j) => j.id === job.id);
    if (cur.state === 2) break;
  }
  if (cur.state !== 2) throw new Error("daemon did not settle the job in time");
  console.log(`3. Provider ${cur.providerId} claimed it and submitted a result (${cur.latencyMs}ms).`);
  console.log(`   Output: ${cur.output.slice(0, 100)}...`);

  const ok = await verifyResult(cur.input, cur.output, cur.modelId, cur.resultHash);
  console.log(`4. Hash verifies: ${ok ? "PASS — output untampered since submission" : "FAIL"}`);
  if (!ok) throw new Error("commitment verification failed");
  console.log(`   Spot-check agreement: ${cur.spotCheckAgreement} (reference re-run of ${cur.modelId})`);

  const receipt = await req(`/api/jobs/${cur.id}/confirm`, {
    method: "POST",
    body: JSON.stringify({ requester: "reviewer" }),
  });
  console.log(`5. Confirmed: provider paid ${receipt.payout}, protocol fee ${receipt.fee}.`);

  const { providers } = await req("/api/providers");
  console.log(`6. Leader: ${providers[0].id} (score ${(providers[0].scoreX100 / 100).toFixed(2)}).`);
  console.log("Demo complete — shut down API + daemon.");
} catch (err) {
  console.error(`DEMO FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  stop();
}
