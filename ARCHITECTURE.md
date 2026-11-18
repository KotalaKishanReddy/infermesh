# Architecture

## Problem (from the RFS)

> Developers want one interface for accessing AI models. Today's inference is
> fragmented: every provider has its own API, pricing, and trust story. There is
> no neutral place to choose between providers, verify which model actually
> handled a request, or pay per job without custodial risk.

## Design

```text
requester (app / agent shim) ──POST /api/jobs or /v1/chat/completions──▶ API + ledger ──poll──▶ provider daemon
      │                                │                                            │
      │                          escrow recorded + budget locked                    runInference()
      │                          (lamports, deadline,                             mock │ hosted
      │                           spend cap)                                        ▼
      │◀──────── result + result_hash ── spot-check vs reference ──▶ auto-dispute on fail
      │                                │
      ├──── confirm (in window) ──▶ payout = budget − fee ──▶ provider score ++ (value-weighted)
      ├──── finalize (anyone, after window) ──▶ same payout ──▶ no buyer veto, ever
      ├──── dispute (bond posted) ──▶ arbiter resolves: winner takes bond + payout/refund
      └──── timeout / stale dispute ──▶ refund (+bond) + 5% stake slash ──▶ rent returned
```

## Trust model: enforced, not assumed

The classic marketplace flaw is buyer-is-judge: the requester takes the
output and may never click confirm. InferMesh removes the veto:

- **Optimistic escrow.** Every escrowed job pays out — by requester confirm,
  by anyone's finalize after `CONFIRM_WINDOW_SLOTS`, or by arbiter resolution.
  There is no state in which an honest provider's money depends on the
  requester's goodwill.
- **Bonded disputes.** Disputing locks 10% of budget (floored at 50k
  lamports). The winner takes the bond, so frivolous disputes cost money and
  honest disputes are free to raise.
- **Named arbiter from day one.** A rotatable arbiter key (`set_arbiter`,
  admin-gated) resolves disputes; if it never shows, stale disputes
  auto-refund with bond after `ARBITER_TIMEOUT_SLOTS`. Funds can never freeze.
- **Slashable stake.** Registration locks real lamports. Timeouts and lost
  disputes slash 5% to the requester plus a value-weighted reputation hit.
  Stake is withdrawable via `unstake` — nobody locks SOL one-way.
- **Rent hygiene.** Vault and job accounts close back to the requester on
  every terminal path. No per-job rent leaks.

## Verification: two layers, honestly scoped

**Integrity (hash commitment):** `result_hash = sha256(input || output ||
modelId)`, stored onchain, inputs/outputs offchain. Proves the output was not
tampered with after submission. It does NOT prove which model ran — the hash
is computed from the requested model, so a substituted model still verifies.
The UI says "output untampered", never "correct model". Never claim otherwise.

**Authenticity (reference spot-checks):** sampled jobs re-run the input
through a trusted reference backend for the CLAIMED model; token-overlap
(`textSimilarity`, Jaccard, pass ≥ 0.5) decides. Same-model outputs agree
(~1.0 on mock backends); substituted families diverge (0.14 on the maintained
test pair, 0.38–0.43 on full live mock outputs). A failed check auto-opens a
bonded dispute — the signal carries money, not just a flag. Pass/total per
provider is public.

Limits, stated plainly: spot-checks catch lazy substitution, not a determined
adversary running a close rival (small variant of the same family scores high
on overlap). They are also reference-backed, i.e. the marketplace operates the
oracle. The design answers both: the oracle is a *sampling input to disputes*,
not a consensus mechanism, and the upgrade path is independent verifiers paid
from the protocol fee plus TEE/attestation receipts attached to
`submit_result` (grant milestone 2).

**Verification economics (who pays):** the protocol fee funds reference runs.
Sampling follows the public `auditRate(budget, stake)` formula — high-value
jobs on low-stake providers audit near-always; micro-jobs on deep-stake
providers rarely. Requesters see exactly what detection their fee bought.
`SPOT_CHECK_RATE` overrides the formula for demos and tests.

## Settlement and metering

Jobs escrow a flat budget today (SOL-denominated); `input_tokens` /
`output_tokens` are recorded at submit, capped by the job and listing maxima,
as the metering records per-token settlement will consume. USDC settlement +
metered payout is milestone-1 exit criteria. The listing PDA (re-derived from
the job's own model hash at claim time) enforces onchain that the provider
serves the requested model in the same marketplace within its token cap —
the mock ledger's model check is not demo-only behavior.

## Why Solana

- Sub-cent fees make per-job escrow (and closes, disputes, slashes)
  economically sane — impossible on L1s with dollar-scale gas.
- 400ms slots make claim → submit → confirm/finalize feel like an API call.
- PDAs give every provider, listing, job, and vault a deterministic address.
  The frontend links the marketplace PDA and funding transactions to the
  explorer today; per-job explorer links ship with the devnet deployment.

## Distribution wedge

A second interface, not a second product: `POST /v1/chat/completions` speaks
OpenAI's request/response shape and settles through the same escrow, hash,
and spot-check path. Agent frameworks point their base URL at it and pay per
call — adoption without asking anyone to learn marketplace mechanics.

## Security notes (honest)

- Provider claim/submit over REST requires Ed25519 signatures when the
  provider owner is a real pubkey; demo string owners stay open by design.
- The daemon refuses to submit mock output as hosted work when
  `INFERMESH_REQUIRE_HOSTED=1`.
- Dispute resolution needs the arbiter; the demo `/resolve` endpoint is the
  stand-in, key-gated by `INFERMESH_ARBITER_KEY`.
- Demo escrow settles in `MockLedger`, which mirrors the program's state
  machine including disputes, finalize, slashing, and weighted scores;
  devnet deployment replaces the ledger, not the UX.

## Upgrade path (post-grant, "top tier")

1. Deploy program to devnet → mainnet; USDC settlement; metered payout from
   recorded token counts.
2. Independent verifier set (staked, paid from fees, slashed on disagreement)
   + TEE/attestation receipts from GPU providers.
3. Agent-framework plugins (LangChain / Eliza / Solana agent kit) on top of
   the OpenAI-compatible gateway; public metrics dashboard.
