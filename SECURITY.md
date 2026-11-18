# SECURITY.md — internal review record

Internal review, not a third-party audit: "audited" means something specific
to grant reviewers, and this isn't it. Two rounds so far — an initial
source review, then an EGM Goldfish round (fresh-eyes drift, idea-critique,
and readiness reviewers; reports in `docs/audit/`).

**Scope:** full `solana-infermesh` codebase (Anchor program, TS SDK, backend API +
daemon, React demo) as of v0.3.0.
**Method:** manual source review + sandboxed local verification (unit tests,
live end-to-end runs incl. a substituted-model cheat, hostile-input probes).
No external services were probed.

## Findings — all fixed, all regression-tested

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | Program recorded escrow accounting but moved no lamports | Vault PDA per job; atomic requester→vault at create, vault→provider+treasury at confirm, vault→requester at refund |
| 2 | High | Unclaimed-job funds could lock forever (`TimeoutRefund` required a provider account) | Provider account is now `Option`; refunds work with or without a claim |
| 3 | Medium | Anyone could claim jobs for anyone else's provider | `claim_job` requires the provider owner's signature |
| 4 | Medium | Anyone could list models under anyone else's provider | `list_model` requires the provider owner's signature |
| 5 | Medium | `min_stake` was a number only, never collected | Real lamport transfer into the provider PDA at registration |
| 6 | Medium | API had no request body limit (trivial DoS) | 64 KB cap → 413 |
| 7 | Medium | API had no rate limiting | 120 req/min/IP → 429 + `Retry-After`; bounded table |
| 8 | Medium | Unbounded/unchecked inputs (`requester`, `input`, `budget`) | Strict charset + length + range validation (`LIMITS`) |
| 9 | Low | Wide-open CORS, no security headers | `CORS_ORIGIN` env; `nosniff` / `DENY` / `no-referrer` headers |
| 10 | Low | Restart wiped all ledger state | Atomic JSON snapshots (tmp + rename) with restore validation |
| 11 | Low | Snapshot/event/rate-limit structures grew unboundedly | Caps: newest 1k terminal jobs, 500 events, 10k rate-limit entries |
| 12 | High | Onchain `submit_result` could never be signed (required PDA key as `Signer`) | Submit takes the provider PDA plus an owner `submitter` signer (the ClaimJob pattern) |
| 13 | High | Onchain claim ignored listings: any provider could claim any model | Claim re-derives the listing PDA from the job's model hash; inactive/missing listing or over-cap job fails |
| 14 | Medium | Trust model: buyer-is-judge (confirm is a veto, disputes freeze funds) | Optimistic escrow: permissionless `finalize_job` after the window; bonded disputes; named rotatable arbiter; stale-dispute auto-refund |
| 15 | Medium | Stake with no slashing is a badge, not security | 5% slash on timeouts + lost disputes, paid to the requester; value-weighted reputation |
| 16 | Medium | Spot-check signal had no economic consequence | Failed spot-check auto-opens a bonded dispute; sampling follows the public `auditRate` formula funded by the fee |
| 17 | Medium | Daemon/API had no identity; anyone could claim/submit as any provider | Ed25519-signed claim/submit when the owner is a real pubkey (demo string owners stay open) |
| 18 | Medium | Hosted fallback silently submitted mock output as hosted work | `INFERMESH_REQUIRE_HOSTED=1` refuses mock submits; failed jobs expire |
| 19 | Low | No spend controls beyond rate limiting | Per-requester escrow cap (`MAX_SPEND_PER_REQUESTER`); admin fee update + arbiter rotation instructions |
| 20 | Low | Rent leaked per job (vault + job accounts never closed) | `close = requester` on every terminal path |
| 21 | Low | Stake locked one-way (no unstake) | `unstake`: owner-signed, deactivates, returns stake |
| 22 | Low | SDK PDA helpers hashed display strings instead of raw keys | Byte-exact seed builders + Anchor-discriminator client builders with re-deriving tests |

## Accepted limitations (documented, tracked in grant milestones)

- Program integration tests on a local validator are missing (toolchain
  unavailable in this environment); `cargo test` covers pure logic, and a
  validator run is milestone-1 acceptance.
- Settlement is SOL-denominated; USDC + per-token metered payout is milestone-1
  exit criteria (token counts are already recorded and capped).
- Demo escrow settles in `MockLedger`, which mirrors the program's state
  machine including disputes, finalize, slashing, and weighted scores;
  devnet deployment replaces the ledger.
- Mock inference by default; hosted models via `OPENAI_API_KEY`. The daemon
  never submits mock output as hosted work when `INFERMESH_REQUIRE_HOSTED=1`.
- Spot-checks catch lazy substitution, not close-rival models; independent
  verifiers + TEE receipts are milestone 2.

## Verification

- `npm test` — 28/28 pass (SDK 23, backend 5: lifecycle, spot-checks,
  disputes/finalize/slash, auth signatures, persistence, hosted fallback)
- `npm run test:program` — 6/6 pass (fee math, weighted reputation,
  bond/slash math, state discriminants + framework `test_id`)
- Live runs: hostile input → 400; full lifecycle → confirmed with correct
  payout/fee; substituted-model cheat → agreement 0.22 → auto-disputed;
  dispute → resolve (requester wins) → refunded with slash; OpenAI shim →
  200 with escrowed job; security headers present.

## Reporting

Found something? Email **kishan04586@gmail.com** with repro steps. Please do not
open public issues for undisclosed vulnerabilities.
