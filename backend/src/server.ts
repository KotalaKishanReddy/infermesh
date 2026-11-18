/**
 * Demo REST API (zero dependencies, plain node:http).
 *
 * Production posture for a demo service:
 * - 64 KB request body cap (413 otherwise)
 * - 120 req/min/IP rate limit (429 + Retry-After)
 * - strict input validation via @infermesh/sdk LIMITS
 * - atomic ledger snapshots after every mutation (see store.ts)
 * - security headers; CORS origin configurable via CORS_ORIGIN
 *
 *   GET  /api/health
 *   GET  /api/providers
 *   GET  /api/jobs
 *   POST /api/jobs                    { requester, modelId, input, budgetLamports, maxTokens }
 *   POST /api/jobs/:id/claim          { providerId }
 *   POST /api/jobs/:id/submit         { providerId, output, latencyMs }
 *   POST /api/jobs/:id/confirm        { requester }
 *   POST /api/jobs/:id/refund
 *   GET  /api/events
 */
import http from "node:http";
import { SPOT_CHECK_THRESHOLD, auditRate, textSimilarity } from "@infermesh/sdk";
import { claimMessage, ownerKeyBytes, submitMessage, verifyMessage } from "./auth.js";
import { runInference } from "./inference.js";
import { ledger, saveLedger } from "./store.js";

const PORT = Number(process.env.PORT ?? 8787);
const VERSION = "0.3.0";
const MAX_BODY_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";

// ---------------------------------------------------------------- rate limit

const hits = new Map<string, number[]>();

function rateLimited(ip: string): number {
  const now = Date.now();
  // Bound memory: drop the oldest entry when the table gets large, and
  // opportunistically purge fully-expired windows.
  if (hits.size > 10_000) {
    const oldest = hits.keys().next();
    if (!oldest.done) hits.delete(oldest.value);
  }
  const window = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (window.length === 0 && hits.has(ip)) hits.delete(ip);
  window.push(now);
  hits.set(ip, window);
  if (window.length > RATE_MAX) {
    return Math.ceil((window[0] + RATE_WINDOW_MS - now) / 1000);
  }
  return 0;
}

// ---------------------------------------------------------------- helpers

function clientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : "request failed";
  return msg.slice(0, 300);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let raw = "";
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES && !rejected) {
        rejected = true;
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (rejected) return;
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function checkedLatency(v: unknown): number {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > 3_600_000) throw new Error("invalid latencyMs");
  return Math.floor(n);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const method = req.method ?? "GET";

  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const retryAfter = rateLimited(clientIp(req));
  if (retryAfter > 0) {
    res.setHeader("Retry-After", String(retryAfter));
    json(res, 429, { error: "rate limit exceeded, slow down" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const log = (status: number) =>
    console.log(`[api] ${method} ${path} -> ${status} (${Date.now() - started}ms)`);

  try {
    if (method === "GET" && path === "/api/health") {
      json(res, 200, {
        ok: true,
        version: VERSION,
        jobs: ledger.jobs.size,
        providers: ledger.providers.size,
      });
      log(200);
      return;
    }
    if (method === "GET" && path === "/api/providers") {
      json(res, 200, { providers: ledger.leaderboard() });
      log(200);
      return;
    }
    if (method === "GET" && path === "/api/jobs") {
      const jobs = [...ledger.jobs.values()].sort((a, b) => b.id - a.id).slice(0, 500);
      json(res, 200, { jobs });
      log(200);
      return;
    }
    if (method === "GET" && path === "/api/events") {
      json(res, 200, { events: [...ledger.events].reverse().slice(0, 100) });
      log(200);
      return;
    }
    if (method === "POST" && path === "/api/jobs") {
      const body = (await readBody(req)) as {
        requester?: string;
        modelId?: string;
        input?: string;
        budgetLamports?: number;
        maxTokens?: number;
      };
      const job = await ledger.createJob(
        String(body.requester ?? ""),
        String(body.modelId ?? ""),
        typeof body.input === "string" ? body.input : "",
        Number(body.budgetLamports ?? 50_000),
        Number(body.maxTokens ?? 512),
      );
      saveLedger();
      json(res, 201, { job });
      log(201);
      return;
    }
    // Provider authentication: if a provider's owner is a real 32-byte pubkey,
    // claim/submit must carry an Ed25519 signature (X-Signature) over the
    // operation message. Demo string owners (e.g. "DemoOperator1") stay open.
    function authedProvider(providerId: string, message: Uint8Array): { ok: boolean; reason?: string } {
      const provider = ledger.providers.get(providerId);
      if (!provider) return { ok: false, reason: "unknown provider" };
      if (ownerKeyBytes(provider.owner) === null) return { ok: true }; // demo mode
      const sig = req.headers["x-signature"];
      if (typeof sig !== "string" || !sig) return { ok: false, reason: "missing X-Signature" };
      try {
        if (!verifyMessage(provider.owner, message, sig)) {
          return { ok: false, reason: "bad signature" };
        }
      } catch {
        return { ok: false, reason: "bad signature" };
      }
      return { ok: true };
    }

    if (path === "/api/providers" && method === "POST") {
      const body = (await readBody(req)) as {
        id?: string;
        owner?: string;
        modelIds?: string[];
        pricePer1kTokensLamports?: number;
        stakeLamports?: number;
      };
      try {
        const provider = ledger.registerProvider({
          id: String(body.id ?? ""),
          owner: String(body.owner ?? ""),
          modelIds: Array.isArray(body.modelIds) ? body.modelIds.map(String) : [],
          pricePer1kTokensLamports: Number(body.pricePer1kTokensLamports ?? 0),
          stakeLamports: Number(body.stakeLamports ?? 0),
        });
        saveLedger();
        json(res, 201, { provider });
        log(201);
      } catch (err) {
        json(res, 400, { error: safeError(err) });
        log(400);
      }
      return;
    }
    const claim = path.match(/^\/api\/jobs\/(\d+)\/claim$/);
    if (claim) {
      if (method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        log(405);
        return;
      }
      const body = (await readBody(req)) as { providerId?: string };
      if (typeof body.providerId !== "string" || !body.providerId) {
        json(res, 400, { error: "providerId is required" });
        log(400);
        return;
      }
      const auth = authedProvider(body.providerId, claimMessage(Number(claim[1])));
      if (!auth.ok) {
        json(res, 401, { error: auth.reason ?? "unauthorized" });
        log(401);
        return;
      }
      json(res, 200, { job: ledger.claimJob(Number(claim[1]), body.providerId) });
      saveLedger();
      log(200);
      return;
    }
    const submit = path.match(/^\/api\/jobs\/(\d+)\/submit$/);
    if (submit) {
      if (method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        log(405);
        return;
      }
      const body = (await readBody(req)) as {
        providerId?: string;
        output?: string;
        latencyMs?: number;
      };
      if (typeof body.providerId !== "string" || !body.providerId) {
        json(res, 400, { error: "providerId is required" });
        log(400);
        return;
      }
      if (typeof body.output !== "string" || !body.output.trim()) {
        json(res, 400, { error: "output is required" });
        log(400);
        return;
      }
      if (body.output.length > 16_000) {
        json(res, 413, { error: "output too large" });
        log(413);
        return;
      }
      const auth = authedProvider(body.providerId, submitMessage(Number(submit[1])));
      // The signature binds provider+job (no replay across jobs). Output
      // authenticity itself is covered by the hash commitment + spot-checks.
      if (!auth.ok) {
        json(res, 401, { error: auth.reason ?? "unauthorized" });
        log(401);
        return;
      }
      const job = await ledger.submitResult(
        Number(submit[1]),
        body.providerId,
        body.output,
        checkedLatency(body.latencyMs),
      );
      // Model-authenticity spot-check: re-run the input through a trusted
      // reference backend for the CLAIMED model and compare outputs. Sampling
      // follows the public auditRate formula (value up, stake down); the
      // protocol fee funds these reference runs. A failed check auto-opens a
      // bonded dispute — the signal now has economic consequence.
      try {
        const stake = ledger.providers.get(body.providerId)?.stakeLamports ?? 0;
        const envRate = process.env.SPOT_CHECK_RATE;
        const rate = envRate !== undefined
          ? Math.min(1, Math.max(0, Number(envRate)))
          : auditRate(job.budgetLamports, stake);
        if (rate > 0 && Math.random() < rate) {
          const ref = await runInference(job.modelId, job.input, job.maxTokens);
          const agreement = textSimilarity(job.output ?? "", ref.output);
          job.spotCheckAgreement = agreement;
          ledger.recordSpotCheck(body.providerId, agreement);
          if (agreement < SPOT_CHECK_THRESHOLD) {
            console.warn(`[api] spot-check FLAG job #${job.id} provider=${body.providerId} agreement=${agreement.toFixed(3)} — auto-disputing`);
            ledger.flagDispute(job.id, job.requester);
          }
        }
      } catch (err) {
        console.warn(`[api] spot-check skipped for job ${job.id}: ${(err as Error).message}`);
      }
      saveLedger();
      json(res, 200, { job });
      log(200);
      return;
    }
    const confirm = path.match(/^\/api\/jobs\/(\d+)\/confirm$/);
    if (confirm) {
      if (method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        log(405);
        return;
      }
      const body = (await readBody(req)) as { requester?: string };
      const receipt = ledger.confirmResult(Number(confirm[1]), String(body.requester ?? ""));
      saveLedger();
      json(res, 200, receipt);
      log(200);
      return;
    }
    const refund = path.match(/^\/api\/jobs\/(\d+)\/refund$/);
    if (refund) {
      if (method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        log(405);
        return;
      }
      // Drain any body so the socket stays reusable.
      await readBody(req).catch(() => ({}));
      json(res, 200, { job: ledger.timeoutRefund(Number(refund[1])) });
      saveLedger();
      log(200);
      return;
    }
    const dispute = path.match(/^\/api\/jobs\/(\d+)\/dispute$/);
    if (dispute) {
      if (method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        log(405);
        return;
      }
      const body = (await readBody(req)) as { requester?: string };
      json(res, 200, { job: ledger.flagDispute(Number(dispute[1]), String(body.requester ?? "")) });
      saveLedger();
      log(200);
      return;
    }
    const cancelDispute = path.match(/^\/api\/jobs\/(\d+)\/cancel-dispute$/);
    if (cancelDispute) {
      if (method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        log(405);
        return;
      }
      const body = (await readBody(req)) as { requester?: string };
      json(res, 200, { job: ledger.cancelDispute(Number(cancelDispute[1]), String(body.requester ?? "")) });
      saveLedger();
      log(200);
      return;
    }
    const finalize = path.match(/^\/api\/jobs\/(\d+)\/finalize$/);
    if (finalize) {
      if (method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        log(405);
        return;
      }
      await readBody(req).catch(() => ({}));
      const receipt = ledger.finalizeJob(Number(finalize[1]));
      saveLedger();
      json(res, 200, receipt);
      log(200);
      return;
    }
    const resolve = path.match(/^\/api\/jobs\/(\d+)\/resolve$/);
    if (resolve) {
      // Demo stand-in for the named onchain arbiter: in production this is
      // resolve_dispute signed by the marketplace arbiter key.
      if (method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        log(405);
        return;
      }
      const body = (await readBody(req)) as { winner?: string };
      const gate = process.env.INFERMESH_ARBITER_KEY;
      if (gate && req.headers["x-arbiter-key"] !== gate) {
        json(res, 401, { error: "arbiter key required" });
        log(401);
        return;
      }
      const receipt = ledger.resolveDispute(Number(resolve[1]), body.winner === "provider");
      saveLedger();
      json(res, 200, receipt);
      log(200);
      return;
    }
    if (path === "/v1/chat/completions") {
      // Drop-in OpenAI-compatible gateway: the distribution wedge. Agent
      // frameworks point their base URL here and pay per call through escrow
      // without touching marketplace mechanics. The shim acts as requester
      // and auto-confirms on delivery; verification (hash + spot-check) and
      // the public job record still apply to every call.
      if (method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        log(405);
        return;
      }
      const body = (await readBody(req)) as {
        model?: string;
        messages?: Array<{ role?: string; content?: unknown }>;
        max_tokens?: number;
      };
      const model = String(body.model ?? "");
      const prompt = Array.isArray(body.messages)
        ? body.messages.map((m) => String(m?.content ?? "")).join("\n").slice(0, 4000)
        : "";
      if (!model || !prompt.trim()) {
        json(res, 400, { error: "model and messages are required" });
        log(400);
        return;
      }
      if (![...ledger.providers.values()].some((p) => p.active && p.modelIds.includes(model))) {
        json(res, 400, { error: `model_not_found: no active provider serves ${model.slice(0, 64)}` });
        log(400);
        return;
      }
      const maxTokens = Math.min(1024, Math.max(16, Number(body.max_tokens ?? 512) || 512));
      try {
        const job = await ledger.createJob("shim", model, prompt, 50_000, maxTokens);
        let cur = job;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 1200));
          cur = ledger.jobs.get(job.id)!;
          if (cur.state === 2 /* Submitted */ || cur.state > 2) break;
        }
        if (cur.state !== 2 || !cur.output) {
          json(res, 504, { error: "inference timed out; check job status", job_id: job.id });
          log(504);
          return;
        }
        ledger.confirmResult(job.id, "shim");
        saveLedger();
        json(res, 200, {
          id: `job-${job.id}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content: cur.output }, finish_reason: "stop" }],
          usage: { prompt_tokens: cur.inputTokens, completion_tokens: cur.outputTokens, total_tokens: cur.inputTokens + cur.outputTokens },
          infermesh: { job_id: job.id, provider: cur.providerId, spot_check: cur.spotCheckAgreement },
        });
        log(200);
      } catch (err) {
        json(res, 400, { error: safeError(err) });
        log(400);
      }
      return;
    }
    json(res, 404, { error: "not found" });
    log(404);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    json(res, status, { error: safeError(err) });
    log(status);
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 16_000;

server.listen(PORT, () => {
  console.log(`[api] InferMesh demo API v${VERSION} on http://localhost:${PORT}`);
});
