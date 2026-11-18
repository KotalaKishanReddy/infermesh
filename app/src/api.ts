import type { JobInfo, ProviderInfo } from "@infermesh/sdk";

const BASE = "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `request failed: ${res.status}`);
  return data as T;
}

export const api = {
  health: () => req<{ ok: boolean; jobs: number; providers: number }>("/api/health"),
  providers: () => req<{ providers: ProviderInfo[] }>("/api/providers"),
  jobs: () => req<{ jobs: JobInfo[] }>("/api/jobs"),
  events: () => req<{ events: Array<{ type: string; at: number; jobId?: number; providerId?: string; detail?: string }> }>("/api/events"),
  createJob: (body: { requester: string; modelId: string; input: string; budgetLamports: number; maxTokens: number }) =>
    req<{ job: JobInfo }>("/api/jobs", { method: "POST", body: JSON.stringify(body) }),
  confirm: (id: number, requester: string) =>
    req<{ job: JobInfo; payout: number; fee: number }>(`/api/jobs/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ requester }),
    }),
  refund: (id: number) => req<{ job: JobInfo }>(`/api/jobs/${id}/refund`, { method: "POST" }),
  dispute: (id: number, requester: string) =>
    req<{ job: JobInfo }>(`/api/jobs/${id}/dispute`, {
      method: "POST",
      body: JSON.stringify({ requester }),
    }),
  cancelDispute: (id: number, requester: string) =>
    req<{ job: JobInfo }>(`/api/jobs/${id}/cancel-dispute`, {
      method: "POST",
      body: JSON.stringify({ requester }),
    }),
  finalize: (id: number) =>
    req<{ job: JobInfo; payout: number; fee: number }>(`/api/jobs/${id}/finalize`, { method: "POST" }),
  resolve: (id: number, winner: "provider" | "requester") =>
    req<{ job: JobInfo }>(`/api/jobs/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ winner }),
    }),
};
