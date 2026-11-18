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

- **Choose:** onchain provider registry with stake, listed models, per-token
  prices, plus a live leaderboard (score, latency, completed jobs).
- **Verify:** `result_hash = sha256(input || output || modelId)` recorded per
  job; one click in the UI recomputes it. Wrong-model substitution fails loudly.
- **Pay:** per-job escrow — requester locks budget, confirmation releases
  `budget − fee`, expiry refunds. No custodial credits.
- **Working demo:** React app + REST API + provider daemon + Anchor program,
  mock inference offline, hosted-model upgrade via `OPENAI_API_KEY`.

## 6. Public good for Solana

- New demand for SOL-denominated micropayments (per-job escrow at sub-cent fees
  — only viable on Solana).
- Open provider registry and commitment standard any wallet/agent can reuse.
- All code MIT; program, SDK, and verification scheme documented for
  integrators (agent frameworks, DePIN GPU networks like Nosana).

## 7. Milestones + budget

| # | Milestone (acceptance) | Amount |
|---|---|---|
| 1 | **Devnet launch** — program deployed to devnet, escrow settled onchain end-to-end (create → claim → submit → confirm), explorer links in UI, audit-ready README | $7,000 |
| 2 | **Hosted + TEE providers** — 3+ hosted models behind the standard interface, signed latency/attestation receipts, provider staking UI | $9,000 |
| 3 | **Mainnet beta + first integrators** — mainnet deploy, 100+ real jobs, 1 external integrator (agent framework or GPU network), public metrics dashboard | $9,000 |
| Total | | **$25,000** |

Timeline: M1 in 4 weeks from funding, M2 +5 weeks, M3 +6 weeks.

## 8. Team

**Kotala Kishan Reddy** ([@KotalaKishanReddy](https://github.com/KotalaKishanReddy),
kishan04586@gmail.com) — solo builder, full-stack (Rust/Anchor, TypeScript, React).

Relevant proof of work (all public on GitHub):

- [shrinkgate](https://github.com/KotalaKishanReddy/shrinkgate) (Rust, ★5) —
  local context-shrinking gateway for coding agents (Claude Code, Codex,
  OpenCode), cross-platform (Linux/macOS/Windows). Systems-level Rust plus
  day-to-day work inside AI agent tooling — directly relevant to an inference
  marketplace for agent-driven demand.

Beyond that, private proof-of-concept work spanning numerical methods and
document-AI pipelines backs the verification rigor behind InferMesh's hash
commitments and mirrored onchain/offchain state machine; happy to walk through
it on a call. Details stay private for now.

## 9. Links

- Repo: https://github.com/KotalaKishanReddy/infermesh
- Live demo: `npm install && npm run build && node demo.mjs` runs a narrated
  end-to-end cycle (open → claim → submit → verify → confirm) with zero setup.
  Full interactive UI: `npm run dev:backend`, `npm run dev:daemon`,
  `npm run dev:app` (see README), or follow `DEMO.md`. No recorded video.
- Contact: kishan04586@gmail.com

## 10. Why now

The RFS explicitly requests this; agent-driven apps are about to 10× inference
demand; Solana is the only chain where per-call escrow is economically sane.
First neutral marketplace captures the standard.
