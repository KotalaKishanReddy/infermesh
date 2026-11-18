import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInference } from "../dist/inference.js";
import { ledger } from "../dist/store.js";

describe("mock inference backend", () => {
  it("returns deterministic demo output offline", async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await runInference("llama-3-8b", "hello world", 128);
    assert.equal(r.backend, "mock");
    assert.match(r.output, /hello world/);
    assert.ok(r.latencyMs > 0);
  });

  it("falls back to mock when the hosted backend is unreachable", async () => {
    process.env.OPENAI_API_KEY = "test-key-unreachable";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/v1";
    const r = await runInference("mistral-7b", "fallback check", 64);
    assert.equal(r.backend, "mock");
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });
});

describe("seeded demo ledger", () => {
  it("ships with three providers covering three models", () => {
    assert.equal(ledger.providers.size, 3);
    const models = new Set([...ledger.providers.values()].flatMap((p) => p.modelIds));
    assert.ok(models.has("llama-3-8b"));
    assert.ok(models.has("mistral-7b"));
    assert.ok(models.has("code-7b"));
  });
});
