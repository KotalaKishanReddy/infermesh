# InferMesh — Open Marketplace for AI Inference on Solana

One interface where developers **choose, verify, and pay** inference providers.
Built for the Solana [Request for Startups](https://solana.com/request-for-startups)
prompt *"An open marketplace for AI inference"* (Jacob Creech, Solana Foundation).

## How it works

1. **Choose** — providers register onchain with a staked identity, listed models,
   and a per-token price. A public leaderboard ranks them by success rate,
   latency, and stake.
2. **Verify** — every result commits to `sha256(input || output || modelId)`.
   Anyone can recompute the hash and prove which model handled a request.
3. **Pay** — requesters escrow lamports per job. Confirming the result releases
   payment minus a small protocol fee; expired jobs refund automatically.

## Repo layout

| Path | What it is |
|---|---|
| `programs/infermesh/` | Anchor program: marketplace, provider registry, model listings, job escrow state machine |
| `sdk/` | Zero-dependency TypeScript SDK: commitments, fee/reputation math, PDA seeds, `MockLedger` |
| `backend/` | Demo REST API + provider daemon. Mock inference offline; set `OPENAI_API_KEY` to route to hosted models |
| `app/` | React demo frontend: submit jobs, watch providers work, verify hashes, confirm payouts, devnet wallet panel |

## Quickstart (2 minutes, no keys, no SOL)

```bash
npm install
npm run build
npm test          # sdk + backend tests
node demo.mjs     # narrated end-to-end run, no video needed

# Terminal 1 — API
npm run dev:backend
# Terminal 2 — provider worker
npm run dev:daemon
# Terminal 3 — frontend
npm run dev:app   # open http://localhost:5173
```

Submit a prompt in the UI: the daemon claims the job, runs inference, and posts
the result hash. Click **Verify result hash**, then **Confirm + release payout**.

## Onchain program

```bash
npm run build:program   # cargo build (needs no local validator)
npm run test:program   # unit tests for fee math, reputation, state discriminants
```

`programs/infermesh/src/lib.rs` implements: `initialize_marketplace`,
`register_provider` (real lamport stake), `list_model`, `create_job` (atomic
requester → vault-PDA escrow), `claim_job` (owner-only), `submit_result`,
`confirm_result` (vault → provider + treasury), `timeout_refund` (works for
never-claimed jobs), `flag_dispute` / `cancel_dispute`. Demo escrow settles in
the local ledger, which mirrors the program's state machine; devnet deployment
is grant milestone 2.

## Config

| Var | Effect |
|---|---|
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `INFERMESH_MODEL_MAP` | Route jobs to real hosted models (OpenAI-compatible). Any failure falls back to mock |
| `INFERMESH_PROVIDER_ID` | Which seeded provider the daemon runs as (default `sol-gpu-01`) |
| `INFERMESH_DATA_DIR` | Ledger snapshot directory (default `./data`, atomic writes) |
| `CORS_ORIGIN` | Allowed CORS origin (default `*`; set to the app origin in production) |
| `PORT` | API port (default `8787`) |

API posture: 64 KB body cap, 120 req/min/IP rate limit, strict input
validation, security headers, 15 s request timeouts.

## Grant submission

See [GRANT_APPLICATION.md](GRANT_APPLICATION.md) (ready-to-paste application),
[ARCHITECTURE.md](ARCHITECTURE.md) (design + security notes), and
[DEMO.md](DEMO.md) (3-minute reviewer walkthrough script).

## License

MIT
