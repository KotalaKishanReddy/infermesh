# Grant Application — InferMesh (ready to paste)

Target: **Solana Foundation Grants Program** (`solana.org/grants-funding`) and/or
the matching track on **Superteam Earn**. Submit once the demo is running;
link this repo + a 3-minute walkthrough (see DEMO.md).

---

## 1. Project name

**InferMesh — open marketplace for AI inference on Solana**

## 2. One-liner

One interface to choose, verify, and pay AI inference providers — permissionless,
on Solana.

## 3. Which RFS idea does this address?

"An open marketplace for AI inference" (AI track, proposed by Jacob Creech, VP
Technology, Solana Foundation): *"Let developers choose, verify, and pay
inference providers through one interface."* InferMesh implements exactly that
triangle: provider leaderboard (choose), hash commitments (verify), per-job
escrow (pay).

## 4. Problem

Inference is fragmented across closed APIs with opaque routing, pricing, and
quality. Developers cannot compare providers neutrally, cannot prove which model
served a request, and must pre-fund custodial credits per provider.

## 5. Solution (what exists today in this repo)

- **Choose:** provider registry with slashable stake, listed models, per-token
  prices, plus a live leaderboard (value-weighted score, latency, completed
  jobs, spot-check pass/total).
- **Verify:** tamper-evidence plus a money-backed audit path. (1) Hash
  commitment `sha256(input || output || modelId)` proves outputs are
  untampered — it cannot prove which model ran, and we don't claim it does.
  (2) Reference spot-checks sample jobs per a public value/stake formula; a
  failed check auto-opens a bonded dispute. Independent verifiers + TEE
  receipts are milestone 2.
- **Pay:** optimistic per-job escrow — requester locks budget, confirm OR
  permissionless finalize releases `budget − fee`, bonded disputes with a
  named arbiter resolve conflicts, timeouts slash stake and refund. Getting
  paid is never optional for the buyer. No custodial credits.
- **Working demo:** React app (real wallet adapter) + REST API + provider
  daemon + OpenAI-compatible agent gateway, mock inference offline,
  hosted-model upgrade via `OPENAI_API_KEY`. The Anchor program implements
  the same state machine onchain (vault escrow, bonds, slashing, finalize)
  and is unit-tested; devnet deployment with USDC settlement and metered
  payout is milestone 1.

## 6. Public good for Solana

- New demand for SOL-denominated micropayments (per-job escrow at sub-cent fees
  — only viable on Solana).
- Open provider registry and commitment standard any wallet/agent can reuse.
- All code MIT; program, SDK, and verification scheme documented for
  integrators (agent frameworks, DePIN GPU networks like Nosana).

## 7. Milestones + budget

| # | Milestone (acceptance) | Amount |
|---|---|---|
| 1 | **Enforced onchain behavior on devnet** — optimistic escrow with auto-release, bonded disputes + named arbiter, 5% slashable stake, value-weighted reputation, USDC settlement with per-token metered payout from recorded counts; third-party provider runbook; per-job explorer links. Acceptance: a full signed cycle (create → claim → submit → confirm/finalize, plus one dispute → resolve) executed by an external operator, not the team | $8,000 |
| 2 | **Independent verification + hosted supply** — staked verifier set paid from protocol fees (slashable on disagreement), TEE/attestation receipts attached to `submit_result`, 3+ hosted models with signed latency receipts, provider staking/unstaking UI | $9,000 |
| 3 | **Mainnet beta with paid volume** — mainnet deploy, 500+ paid jobs, 1 external integrator (agent framework via the OpenAI-compatible gateway, or a GPU network plugging into escrow+verification), public metrics dashboard. Final 20% released on hitting the volume target | $8,000 |
| Total | | **$25,000** |

Timeline: M1 in 5 weeks from funding, M2 +6 weeks, M3 +6 weeks. No milestone
pays for redeploying existing code — M1 buys the new enforced behavior above,
M2 buys external verification, M3 buys usage with a holdback.

## 8. Team

**Kotala Kishan Reddy** ([@KotalaKishanReddy](https://github.com/KotalaKishanReddy),
kishan04586@gmail.com) — solo builder, full-stack (Rust/Anchor, TypeScript, React).

Relevant proof of work (all public on GitHub):

- [shrinkgate](https://github.com/KotalaKishanReddy/shrinkgate) (Rust, ★5) —
  local context-shrinking gateway for coding agents (Claude Code, Codex,
  OpenCode), cross-platform (Linux/macOS/Windows). Systems-level Rust plus
  day-to-day work inside AI agent tooling — directly relevant to an inference
  marketplace for agent-driven demand.


## 9. Links

- Repo: https://github.com/KotalaKishanReddy/infermesh
- Live demo: `npm install && npm run build && node demo.mjs` runs a narrated
  end-to-end cycle (open → claim → submit → verify → confirm) with zero setup.
  Full interactive UI: `npm run dev:backend`, `npm run dev:daemon`,
  `npm run dev:app` (see README), or follow `DEMO.md`. No recorded video.
- Contact: kishan04586@gmail.com

## 10. Landscape and differentiation

This is not an empty lane. **Antseed** ("BitTorrent for AI inference", live on
Base with USDC settlement, $2.4M led by Spark Capital) does P2P discovery —
buyers connect directly to providers with no central gateway. **UsePod.ai** is
the Solana-native two-sided marketplace, focused on OpenAI/Anthropic-compatible
APIs, client-side encryption, and agent traffic; cryptographic proof-of-inference
is on their far-future roadmap.

InferMesh differentiates on **verifiable execution quality with escrow attached**:
per-job vault escrow plus hash commitments plus public reference spot-checks
per provider — a quality signal neither competitor publishes today — MIT
open-source, no token, Solana-settled. The bet: as agent-driven demand 10×es
inference volume, the marketplace that proves what ran (not just routes it)
captures the quality-sensitive segment both leave open.

## 11. Why now

The RFS explicitly requests this; Solana is the only chain where per-call
escrow is economically sane; and the current leaders compete on routing and
privacy, not on verifiable execution — that gap is open right now.
