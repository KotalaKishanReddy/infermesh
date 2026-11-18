# SECURITY.md — audit record

**Scope:** full `solana-infermesh` codebase (Anchor program, TS SDK, backend API +
daemon, React demo) as of v0.2.0.
**Method:** manual source audit + sandboxed local verification (unit tests,
live end-to-end run, hostile-input probes). No external services were probed.

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

## Accepted limitations (documented, tracked in grant milestones)

- Dispute resolution is flag-based (`flag_dispute` / `cancel_dispute`); a
  multisig arbiter ships in milestone 2. `cancel_dispute` guarantees funds can
  never freeze permanently.
- Provider stake has no `unstake` instruction yet (milestone 2).
- Demo escrow settles in `MockLedger`, which mirrors the program's exact state
  machine, fee math, and score math; devnet deployment replaces it (milestone 1).
- Mock inference by default; hosted models via `OPENAI_API_KEY` (fail-closed to
  mock, never crashes the daemon).

## Verification

- `npm test` — 13/13 pass (SDK 9, backend 4, incl. hostile-input + snapshot tests)
- `npm run test:program` — 5/5 pass (fee math, reputation, state discriminants)
- Live run: hostile input → 400, full job lifecycle → confirmed with correct
  payout/fee split, security headers present.

## Reporting

Found something? Email **kishan04586@gmail.com** with repro steps. Please do not
open public issues for undisclosed vulnerabilities.
