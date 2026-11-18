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

## Script (record at 1080p, narrate each step)

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

**1:45–2:20 — Verify.**
Open the submitted job, click **Verify result hash**. Green check.
"Anyone can recompute `sha256(input || output || modelId)` — a provider that
silently swaps in a cheaper model fails verification."

**2:20–2:50 — Pay.**
Click **Confirm + release payout**. Show the payout/fee receipt and the
provider's score ticking up. "Sub-cent escrow economics — only possible on Solana."

**2:50–3:00 — What's next.**
Show `programs/infermesh/src/lib.rs`. "Same state machine as an Anchor program;
grant milestones deploy it to devnet, add hosted and TEE providers, and take it
to mainnet beta."

## Before submitting

- [ ] `npm test` and `npm run test:program` pass (paste output in application)
- [ ] Fresh `npm install` from a clean clone works
- [ ] Video uploaded (unlisted YouTube or Loom), link in GRANT_APPLICATION.md
- [ ] Repo pushed to GitHub with real Team section filled in
