/**
 * Inference backends.
 *
 * Demo default: deterministic mock inference (works offline, no keys).
 * Grant upgrade path: set OPENAI_API_KEY (+ optional OPENAI_BASE_URL and
 * INFERMESH_MODEL_MAP) to route jobs to real hosted models through an
 * OpenAI-compatible chat-completions endpoint. The commitment scheme is
 * unchanged either way — the chain only ever sees hashes.
 */

export interface InferenceResult {
  output: string;
  latencyMs: number;
  modelId: string;
  backend: "mock" | "hosted";
}

const MOCK_STYLES: Record<string, (input: string) => string> = {
  "llama-3-8b": (input) =>
    `Here's a concise take on ${JSON.stringify(input)}: key points first, ` +
    `details on demand. (demo inference — connect a hosted model for production quality)`,
  "mistral-7b": (input) =>
    `Instruction processed: ${input
      .split(/\s+/)
      .slice(0, 40)
      .join(" ")}${input.split(/\s+/).length > 40 ? "…" : ""} [mistral-7b demo output]`,
  "code-7b": (input) =>
    `// demo code-model response for: ${input.slice(0, 80)}\nfunction answer() {\n  return "wire a hosted code model here post-grant";\n}`,
};

function mockInference(modelId: string, input: string): InferenceResult {
  const started = Date.now();
  const family = Object.keys(MOCK_STYLES).find((k) => modelId.startsWith(k)) ?? "llama-3-8b";
  // Simulated GPU latency: 150–600ms scaled by input length.
  const latencyMs = 150 + Math.min(450, input.length * 2);
  return { output: MOCK_STYLES[family](input), latencyMs, modelId, backend: "mock" };
}

async function hostedInference(modelId: string, input: string, maxTokens: number): Promise<InferenceResult> {
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const started = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.INFERMESH_MODEL_MAP?.split(",").find((m) => m.startsWith(modelId + "="))?.split("=")[1] ?? modelId,
      messages: [{ role: "user", content: input }],
      max_tokens: Math.min(maxTokens, 1024),
    }),
  });
  if (!res.ok) throw new Error(`hosted inference failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const output = data.choices?.[0]?.message?.content?.trim();
  if (!output) throw new Error("hosted inference returned no content");
  return { output, latencyMs: Date.now() - started, modelId, backend: "hosted" };
}

export async function runInference(modelId: string, input: string, maxTokens: number): Promise<InferenceResult> {
  // Opt-in hosted path; any failure falls back to mock so the demo never dies.
  if (process.env.OPENAI_API_KEY) {
    try {
      return await hostedInference(modelId, input, maxTokens);
    } catch (err) {
      console.warn(`[inference] hosted backend failed, using mock: ${(err as Error).message}`);
    }
  }
  const r = mockInference(modelId, input);
  await new Promise((resolve) => setTimeout(resolve, Math.min(r.latencyMs, 400)));
  return r;
}
