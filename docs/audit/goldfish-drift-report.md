Drift report — docs vs code. Each bullet is "DOC says X but CODE does Y" with file:line on both sides.

## README.md

- README.md:61 says "20/20 tests green — SDK 11, backend 4 (npm test), program 5 (npm run test:program: 4 logic + 1 Anchor-generated ID check)". CODE has SDK 11 (`sdk/test/lifecycle.test.mjs`, 11 `it(` blocks), backend 4 (`backend/test/smoke.test.mjs` 3 + `backend/test/persistence.test.mjs` 1), program 4 (`programs/infermesh/src/lib.rs`, 4 `#[test]` fns). Total is 19, not 20. There is no 5th program test and no Anchor-generated ID check anywhere in `lib.rs`.
- README.md:61 says "`npm test`" covers "SDK 11, backend 4". This part matches (`package.json` root `test` script runs both workspace suites, and `npm test` run passed 11 + 4). No drift on the script itself.
- README.md:59 says "provider actions are owner-checked". CODE `claim_job` (`lib.rs:126-129`) and `list_model` (`lib.rs:69-72`) check the owner, but `submit_result` (`lib.rs:143-153` with `SubmitResult` at `lib.rs:391-397`) requires the signer key to equal `job.provider`, which is the provider PDA set at claim time (`lib.rs:138`) — a PDA cannot sign, and the owner is never checked. So the submit path is not owner-checked as claimed.
- README.md:47 says the demo settles "the identical state machine in MockLedger". CODE `MockLedger.claimJob` (`sdk/src/index.ts:310`) rejects a claim when the provider does not serve the job's model; the onchain `claim_job` (`lib.rs:123-141`) has no model check. The machines differ by that rule.
- No drift: quickstart scripts/ports (`package.json`, `backend/src/server.ts:26`, `app/vite.config.ts:7`), Verify/Confirm buttons (`app/src/App.tsx:212-213`), config table values (`backend/src/store.ts:7`, `backend/src/daemon.ts:12`, `backend/src/server.ts:28,30,295`).

## ARCHITECTURE.md

- ARCHITECTURE.md:41-42 says substituted families "diverge (measured 0.375–0.429)". CODE `textSimilarity` (`sdk/src/index.ts:113-128`) run on the actual mock templates from the spot-check test gives 0.143 (same-model gives 1.0), and the test (`sdk/test/lifecycle.test.mjs:113-124`) only asserts `< SPOT_CHECK_THRESHOLD`, never the 0.375–0.429 range. The quoted measurement does not match the code's mock outputs.
- ARCHITECTURE.md:59-60 says "PDAs give every provider, listing, and job a deterministic address the frontend links straight to the explorer." CODE frontend (`app/src/App.tsx:153-158`, `app/src/solana.ts:29-37`) derives and displays only the marketplace PDA as text; the only explorer link is the wallet airdrop transaction. No provider/listing/job PDA is linked to the explorer.
- ARCHITECTURE.md:66-68 says MockLedger "mirrors the program's state machine exactly". Same divergence as README: `sdk/src/index.ts:310` model-serving check in `claimJob` has no onchain counterpart in `lib.rs:123-141`.
- No drift: fee math (`settle_amounts`, `lib.rs:456-459` vs `sdk/src/index.ts:132-135`), reputation math (`bump_score`, `lib.rs:462-468` vs `sdk/src/index.ts:137-140`), score start 1000 / +25 / -150 / cap [0,10000], `SPOT_CHECK_RATE` default 1.0 (`backend/src/server.ts:240`), threshold 0.5 (`sdk/src/index.ts:110`), flag-based disputes with funds locked (`lib.rs:239-251`).

## GRANT_APPLICATION.md

- Section 5 says "Working demo: React app + REST API + provider daemon + Anchor program". CODE demo (`demo.mjs:36-37`, `backend/src/store.ts:32-57`) settles escrow in `MockLedger` with 3 seeded providers; the Anchor program (`programs/infermesh`) is never invoked by the API, daemon, or UI. The program exists as code but is not part of the working demo loop as the sentence implies.
- Section 5 says "one click recomputes" the hash for verification. CODE `verifyJob` (`app/src/App.tsx:76-80`) recomputes via `verifyResult`, which matches. No drift.
- Section 9 says `node demo.mjs` runs "open → claim → submit → verify → confirm". CODE `demo.mjs:56-86` does exactly this (daemon performs claim+submit). No drift, except the verify step inherits the DEMO.md overclaim below.
- Milestone/budget/team/landscape text describes future work and external projects; nothing in it contradicts current code. No code drift detected (external claims unverifiable from repo).

## DEMO.md

- DEMO.md:31-34 instructs the narrator to click "Verify result hash" and say "a provider that silently swaps in a cheaper model fails verification." CODE `verifyResult` (`sdk/src/index.ts:92-99`) recomputes `sha256(input || output || modelId)` using the requested modelId, so a substituted model still verifies — the SDK's own comment (`sdk/src/index.ts:86-91`) and ARCHITECTURE.md:34-36 state this explicitly. The script line is false against the code.
- DEMO.md:22-24 says "Three GPU operators". CODE seeds exactly 3 providers (`backend/src/store.ts:33-54`). No drift.
- DEMO.md:47 checklist item "`npm test` and `npm run test:program` pass" — both scripts exist and pass (15 JS tests, 4 program tests), but see README counts: the "20/20" framing the checklist feeds into is wrong. The commands themselves work. No drift on the commands.

## SECURITY.md

- SECURITY.md:37 says "`npm test` — 13/13 pass (SDK 9, backend 4)". CODE has SDK 11 and backend 4, total 15. Verified by running `npm test` (11 pass + 4 pass, 0 fail). Both the total and the SDK count are wrong.
- SECURITY.md:38 says "`npm run test:program` — 5/5 pass (fee math, reputation, state discriminants)". CODE has 4 `#[test]` functions (`lib.rs:500+`: fee_math_splits_budget, fee_zero_and_full_range, score_moves_and_saturates, job_state_discriminants_stable_for_clients). The 5th test does not exist.
- SECURITY.md:22 caps row says "10k rate-limit entries". CODE `backend/src/server.ts:41-44` drops the oldest entry when `hits.size > 10_000`. Matches. Snapshot caps (1k terminal jobs, 500 events in `sdk/src/index.ts:383-396`) match. No drift.
- Findings 1–10 rows match code (`lib.rs` vault PDA/Option provider/owner checks/stake transfer; `server.ts` 64KB cap, 120/min + Retry-After, `LIMITS`, CORS/headers, `store.ts` tmp+rename). No drift.
- Accepted limitations match code: `cancel_dispute` exists (`lib.rs:225-237`), no `unstake` instruction exists, mock-by-default with hosted fallback (`backend/src/inference.ts:64+`). No drift.

## demo.mjs header comment

- Header (`demo.mjs:1-7`) says it "runs a full open -> claim -> submit -> verify -> confirm cycle". CODE does this. No drift on the flow.
- `demo.mjs:79` prints "PASS — correct model, untampered output" on hash verification. CODE `verifyResult` proves only untampered output, not the correct model (same substitution blind spot as DEMO.md). The "correct model" half of the message is false against the code.