/**
 * Provider daemon: external worker process. Polls the API for open jobs it
 * can serve, claims one, runs inference (mock by default, hosted when
 * OPENAI_API_KEY is set), and submits the result back through the API —
 * the same separation a real GPU operator would have from the chain.
 *
 *   npm run daemon   (in backend/, with the API running)
 */
import { runInference } from "./inference.js";

const API = process.env.INFERMESH_API ?? "http://localhost:8787";
const PROVIDER_ID = process.env.INFERMESH_PROVIDER_ID ?? "sol-gpu-01";
const POLL_MS = Number(process.env.INFERMESH_POLL_MS ?? 2000);

interface Job {
  id: number;
  state: number;
  modelId: string;
  input: string;
  maxTokens: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `request failed: ${res.status}`);
  return data as T;
}

let consecutiveFailures = 0;
let lastFailureAt = 0;

async function tick() {
  if (consecutiveFailures > 0) {
    // Back off while the API is down instead of log-spamming every poll.
    const skipUntil = Math.min(2 ** Math.min(consecutiveFailures, 6), 60);
    if (Date.now() - lastFailureAt < skipUntil * 1000) return;
  }
  let jobs: Job[];
  try {
    jobs = (await req<{ jobs: Job[] }>("/api/jobs")).jobs;
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures += 1;
    lastFailureAt = Date.now();
    console.warn(`[daemon] api unreachable (attempt ${consecutiveFailures}): ${(err as Error).message}`);
    return;
  }
  for (const job of jobs) {
    if (job.state !== 0) continue; // only Open
    try {
      await req(`/api/jobs/${job.id}/claim`, {
        method: "POST",
        body: JSON.stringify({ providerId: PROVIDER_ID }),
      });
    } catch {
      continue; // claimed by someone else or wrong model
    }
    console.log(`[daemon] claimed job #${job.id} (${job.modelId})`);
    try {
      const result = await runInference(job.modelId, job.input, job.maxTokens);
      if (result.output.length > 16_000) {
        console.warn(`[daemon] job #${job.id}: output too large, skipping submit`);
        continue;
      }
      await req(`/api/jobs/${job.id}/submit`, {
        method: "POST",
        body: JSON.stringify({
          providerId: PROVIDER_ID,
          output: result.output,
          latencyMs: result.latencyMs,
        }),
      });
      console.log(
        `[daemon] submitted job #${job.id} via ${result.backend} backend (${result.latencyMs}ms)`,
      );
    } catch (err) {
      console.warn(`[daemon] job #${job.id}: ${(err as Error).message}`);
    }
  }
}

console.log(`[daemon] provider=${PROVIDER_ID} api=${API} poll=${POLL_MS}ms (mock unless OPENAI_API_KEY set)`);
await tick();
setInterval(tick, POLL_MS);
