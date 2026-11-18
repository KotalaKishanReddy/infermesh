# Architecture

## Problem (from the RFS)

> Developers want one interface for accessing AI models. Today's inference is
> fragmented: every provider has its own API, pricing, and trust story. There is
> no neutral place to choose between providers, verify which model actually
> handled a request, or pay per job without custodial risk.

## Design

```text
requester (app) ──POST /api/jobs──▶ API + ledger ──poll──▶ provider daemon
      │                                │                       │
      │                          escrow recorded          runInference()
      │                          (lamports,               mock │ hosted
      │                           deadline)                   ▼
      │◀──────── result + result_hash ────────────────── submitResult()
      │                                │
      └──── confirm ──▶ payout = budget − fee ──▶ provider reputation ++
            timeout ──▶ refund ──▶ provider reputation --
```

**Trust anchor (onchain, `programs/infermesh`):** `Marketplace`, `Provider`
(stake + rolling score), `ModelListing` (price per 1k tokens), `Job` (budget,
deadline, input/result hashes, state). Money movement is escrow-shaped:
requester locks budget at `create_job`; `confirm_result` releases
`budget − fee`; `timeout_refund` returns funds after the deadline.

**Verification (offchain + onchain-compatible):**
`result_hash = sha256(input || output || modelId)`. The chain stores only
hashes (cheap); full inputs/outputs live offchain with the requester. A wrong
model ID fails verification — providers cannot silently substitute a cheaper
model. This is the "verify which model handled it" requirement, implemented.

**Reputation:** `score_x100` starts at 1000 (10.00), +25 per confirmed job,
−150 per timeout, saturating at [0, 10000]. The leaderboard sorts by score,
breaking the cold-start problem: new providers stake to signal quality.

## Why Solana

- Sub-cent fees make per-job escrow (often a few thousand lamports in fees)
  economically sane — impossible on L1s with dollar-scale gas.
- 400ms slots make claim → submit → confirm feel like an API call, not a
  governance process.
- PDAs give every provider, listing, and job a deterministic address the
  frontend links straight to the explorer.

## Security notes (honest)

- v1 disputes are flag-based (`flag_dispute` marks `Disputed`; funds stay
  locked). Milestone 2 adds arbiter-signed resolution.
- Demo escrow settles in `MockLedger`, which mirrors the program's state
  machine exactly (same fee math, same score math, same state discriminants —
  all covered by tests). Devnet deployment replaces the ledger, not the UX.
- Mock inference is deterministic and clearly labeled; the hosted path
  (`OPENAI_API_KEY`) is a swap-in, and commitments are backend-agnostic.

## Upgrade path (post-grant, "top tier")

1. Deploy program to devnet → mainnet; frontend switches escrow calls onchain.
2. TEE/attestation receipts from GPU providers attached to `submit_result`.
3. Streaming jobs + per-token metering instead of flat per-job budgets.
4. Arbiter multisig + staking/slashing for disputes.
