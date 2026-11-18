# InferMesh — Open Marketplace for AI Inference on Solana

![InferMesh banner](assets/banner.png)

[![CI](https://github.com/KotalaKishanReddy/infermesh/actions/workflows/ci.yml/badge.svg)](https://github.com/KotalaKishanReddy/infermesh/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/KotalaKishanReddy/infermesh?color=14F195)](https://github.com/KotalaKishanReddy/infermesh/releases)
[![License: MIT](https://img.shields.io/github/license/KotalaKishanReddy/infermesh?color=9945FF)](LICENSE)
[![Built on Solana](https://img.shields.io/badge/Built_on-Solana-14F195?logo=solana)](https://solana.com)
[![Anchor](https://img.shields.io/badge/Anchor-0.31-9945FF)](https://www.anchor-lang.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-1.96-CE422B?logo=rust)](https://www.rust-lang.org)
[![Last commit](https://img.shields.io/github/last-commit/KotalaKishanReddy/infermesh)](https://github.com/KotalaKishanReddy/infermesh/commits/main)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-14F195)](https://github.com/KotalaKishanReddy/infermesh/pulls)

One interface where developers **choose, verify, and pay** AI inference providers.
Built for the Solana [Request for Startups](https://solana.com/request-for-startups)
prompt *"An open marketplace for AI inference"*.

> **Choose** from staked, slashable providers · **Verify** outputs are untampered
> (hash commitment) and providers really ran the claimed model (reference
> spot-checks that auto-open bonded disputes) · **Pay** through optimistic escrow
> that no buyer can stall — auto-release, bonded disputes, named arbiter.

## Why this design (the worthy version)

Most marketplaces trust the requester to pay and the provider to be honest.
InferMesh enforces both onchain:

- **Optimistic escrow + auto-release.** Confirming is a dispute window, not a
  veto. After the window, anyone can finalize payout — getting paid is never
  optional for the buyer.
- **Bonded disputes + named arbiter.** Disputing costs a bond (10% of budget,
  floored); the winner takes it. A rotatable arbiter key resolves; stale
  disputes auto-refund.
- **Slashable stake.** Timeouts and lost disputes slash 5% of stake to the
  requester. Reputation deltas scale with job value — micro-jobs can't farm
  score.
- **Verification with teeth.** Spot-checks re-run sampled inputs against a
  reference backend; a failed check auto-opens a bonded dispute instead of
  just logging a flag. Sampling follows a public formula (value up, stake
  down), funded by the protocol fee.
- **Drop-in agent gateway.** `POST /v1/chat/completions` speaks OpenAI's API
  shape and settles through escrow — the distribution wedge for agent
  frameworks, not just another dashboard.

## ✨ Quickstart (2 minutes, no keys, no SOL)

```bash
npm install
npm run build
npm test          # sdk + backend tests
node demo.mjs     # narrated end-to-end run, no video needed
```

Full interactive UI (3 terminals):

```bash
npm run dev:backend   # REST API  → http://localhost:8787
npm run dev:daemon     # provider worker (mock inference; set OPENAI_API_KEY for hosted)
npm run dev:app   # React demo → http://localhost:5173
```

Submit a prompt: the daemon claims the job, runs inference, posts the result.
Click **Verify result hash** (tamper-evidence), then **Confirm + release payout**
— or **Dispute** to post a bond, and watch **Finalize** appear after the window.

Try the agent gateway (needs API + daemon running):

```bash
curl localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama-3-8b","messages":[{"role":"user","content":"Say hi in five words."}]}'
```

## 🧩 Repo layout

| Path | What it is |
|---|---|
| `programs/infermesh/` | Anchor program: optimistic escrow (vault PDA), bonded disputes, arbiter resolution, slashable stake, unstake, rent-returning closes, owner-checked claims, listing-enforced model checks |
| `sdk/` | Zero-dependency TS SDK: commitments, spot-check similarity, fee/reputation/bond/slash math, audit-rate formula, PDA seeds, hand-rolled onchain instruction builders |
| `backend/` | Hardened REST API (body cap, rate limit, security headers, atomic persistence, spend caps, signed provider ops) + provider daemon + OpenAI-compatible shim |
| `app/` | React demo in Solana ecosystem theme (real wallet adapter, dispute/finalize UI) |
| `demo.mjs` | Self-running narrated end-to-end demo |
| `docs/audit/` | EGM Goldfish review reports (drift, idea critique, readiness) |
| `GRANT_APPLICATION.md` | Paste-ready grant application ($25k / 3 milestones) |
| `ARCHITECTURE.md` · `DEMO.md` · `SECURITY.md` | Design notes, reviewer walkthrough, internal review record |

## 🔐 Security

Internally reviewed in-repo — see [SECURITY.md](SECURITY.md) for the full
record (original 11 findings, this-turn EGM round, all fixed or explicitly
deferred). Highlights: real lamport escrow (no accounting-only payouts),
owner-checked provider actions, unclaimable funds impossible, signed provider
ops, validated + rate-limited API with spend caps, atomic persistence. 34/34
tests green — SDK 23, backend 5 (`npm test`), program 6 (`npm run test:program`:
5 unit tests + framework `test_id`).

Known non-goals for this milestone: program integration tests need a local
validator (toolchain unavailable here — `cargo test` covers pure logic);
settlement is SOL-denominated with USDC + per-token metering recorded and
roadmapped for milestone 1; the demo arbiter endpoint stands in for the
onchain arbiter key.

## ⚙️ Config

| Var | Effect |
|---|---|
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `INFERMESH_MODEL_MAP` | Route jobs to real hosted models (OpenAI-compatible). Falls back to mock |
| `INFERMESH_REQUIRE_HOSTED=1` | Daemon refuses to submit mock output as hosted work |
| `INFERMESH_OWNER_SECRET` | Base64 64-byte ed25519 keypair: daemon signs claim/submit (required when the provider owner is a real pubkey) |
| `SPOT_CHECK_RATE` | Override audit sampling (default: public `auditRate` formula) |
| `MAX_SPEND_PER_REQUESTER` | Per-requester escrow cap in lamports (unset = unlimited) |
| `INFERMESH_ARBITER_KEY` | Gates the demo resolve endpoint (production = arbiter-signed ix) |
| `INFERMESH_PROVIDER_ID` | Which seeded provider the daemon runs as (default `sol-gpu-01`) |
| `INFERMESH_DATA_DIR` | Ledger snapshot directory (default `./data`, atomic writes) |
| `CORS_ORIGIN` | Allowed CORS origin (default `*`; set to the app origin in production) |
| `PORT` | API port (default `8787`) |

API posture: 64 KB body cap, 120 req/min/IP rate limit, strict input
validation, security headers, 15 s request timeouts.

## 📄 License

MIT © 2026 Kotala Kishan Reddy — see [LICENSE](LICENSE).
Built by [@KotalaKishanReddy](https://github.com/KotalaKishanReddy) ·
contact: kishan04586@gmail.com
