# DEMO.md — 3-minute reviewer walkthrough

Setup (two terminals):

```bash
npm install && npm run build
# Terminal 1:
npm run dev:backend
# Terminal 2:
npm run dev:daemon
# Terminal 3:
npm run dev:app   # → http://localhost:5173
```

## Script (narrate each step; record at 1080p if you want a video, otherwise run `node demo.mjs`)

**0:00–0:30 — The idea.**
Show the README header. Say: "InferMesh is the open marketplace for AI
inference from Solana's Request for Startups: one interface to choose, verify,
and pay providers."

**0:30–1:00 — Providers.**
Scroll the provider leaderboard. Point out stake, per-model pricing, score, and
latency. "Three GPU operators, competing openly — no closed API."

**1:00–1:45 — A job.**
Enter a prompt, pick `llama-3-8b`, submit. Watch the job go
open → claimed → submitted live as the daemon works. "Escrow is locked for the
job's budget; the provider only gets paid on confirmation."

**1:30–2:00 — Verify (two layers).**
Open the submitted job, click **Verify result hash**. Green check — "this
proves the output wasn't tampered with after submission." Then point at the
spot-check badge: "and this proves something ran the claimed model — the
marketplace re-ran the input through a reference backend and compared. Watch
what happens when a provider cheats." (If time: submit a wrong-family output
via the API and show the auto-dispute flag.)

**2:00–2:30 — Disputes with teeth.**
Click **Dispute** — a bond posts. Click **Resolve: requester wins** and show
the refund plus the provider's slashed stake. "Disputes cost money, winners
are paid, ghosting gets slashed."

**2:30–2:50 — Pay without permission.**
Click **Confirm + release payout**. Show the payout/fee receipt and the
provider's value-weighted score ticking up. "And if the requester never
clicks, anyone can hit Finalize after the window — getting paid is never
optional for the buyer."

**2:50–3:00 — What's next.**
Show `programs/infermesh/src/lib.rs`. "Same state machine as an Anchor
program — optimistic escrow, bonded disputes, slashable stake. Grant
milestone 1 puts it on devnet with USDC settlement; milestone 2 adds
independent verifiers and TEE receipts."

## Before submitting

- [ ] `npm test` and `npm run test:program` pass (paste output in application)
- [ ] Fresh `npm install` from a clean clone works
- [ ] No video required: `node demo.mjs` reproduces the walkthrough live. If you record one anyway (unlisted YouTube or Loom), link it in GRANT_APPLICATION.md
- [ ] Repo pushed to GitHub with real Team section filled in
