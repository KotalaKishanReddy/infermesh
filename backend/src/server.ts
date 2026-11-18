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
import { ledger, saveLedger } from "./store.js";

const PORT = Number(process.env.PORT ?? 8787);
const VERSION = "0.2.0";
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
      const job = await ledger.submitResult(
        Number(submit[1]),
        body.providerId,
        body.output,
        checkedLatency(body.latencyMs),
      );
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
