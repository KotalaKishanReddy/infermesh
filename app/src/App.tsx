import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CONFIRM_WINDOW_MS, JobState, PROGRAM_ID, SPOT_CHECK_THRESHOLD, disputeBond, verifyResult, type JobInfo, type ProviderInfo } from "@infermesh/sdk";
import { api } from "./api.js";
import { explorerAddress, explorerTx, marketplacePda } from "./solana.js";
import "./styles.css";

const MODELS = ["llama-3-8b", "mistral-7b", "code-7b"];
const STATE_LABEL: Record<number, string> = {
  [JobState.Open]: "open",
  [JobState.Claimed]: "claimed",
  [JobState.Submitted]: "submitted",
  [JobState.Confirmed]: "confirmed",
  [JobState.Refunded]: "refunded",
  [JobState.Disputed]: "disputed",
  [JobState.Finalized]: "finalized",
};

export default function App() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [events, setEvents] = useState<Array<{ type: string; at: number; jobId?: number; detail?: string }>>([]);
  const [requester, setRequester] = useState("alice");
  const [modelId, setModelId] = useState(MODELS[0]);
  const [input, setInput] = useState("Explain why Solana is a good fit for micropayments in two sentences.");
  const [budget, setBudget] = useState(50_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<number, boolean | null>>({});
  const [receipts, setReceipts] = useState<Record<number, { payout: number; fee: number }>>({});
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [airdropSig, setAirdropSig] = useState<string | null>(null);
  const [pda, setPda] = useState<string>("");
  const [walletBusy, setWalletBusy] = useState(false);

  useEffect(() => {
    if (!connected || !publicKey) {
      setBalanceSol(null);
      return;
    }
    connection.getBalance(publicKey).then((lamports) => setBalanceSol(lamports / LAMPORTS_PER_SOL)).catch(() => setBalanceSol(null));
  }, [connected, publicKey, connection]);

  const refresh = useCallback(async () => {
    try {
      const [p, j, e] = await Promise.all([api.providers(), api.jobs(), api.events()]);
      setProviders(p.providers);
      setJobs(j.jobs);
      setEvents(e.events);
    } catch (err) {
      setError(`Backend unreachable — start it with: npm run dev:backend (${(err as Error).message})`);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    marketplacePda().then(setPda).catch(() => setPda(""));
  }, []);

  async function submitJob(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createJob({ requester, modelId, input, budgetLamports: budget, maxTokens: 512 });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmJob(id: number) {
    try {
      const r = await api.confirm(id, requester);
      setReceipts((prev) => ({ ...prev, [id]: { payout: r.payout, fee: r.fee } }));
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function act(promise: Promise<unknown>, receipt?: { payout: number; fee: number }, id?: number) {
    try {
      const r = (await promise) as { payout?: number; fee?: number };
      if (receipt && id !== undefined) {
        setReceipts((prev) => ({ ...prev, [id]: { payout: receipt.payout, fee: receipt.fee } }));
      } else if (id !== undefined && typeof r?.payout === "number" && typeof r?.fee === "number") {
        setReceipts((prev) => ({ ...prev, [id]: { payout: r.payout as number, fee: r.fee as number } }));
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function verifyJob(job: JobInfo) {
    if (!job.output || !job.resultHash) return;
    const ok = await verifyResult(job.input, job.output, job.modelId, job.resultHash);
    setVerified((prev) => ({ ...prev, [job.id]: ok }));
  }

  async function airdrop() {
    if (!publicKey) return;
    setWalletBusy(true);
    try {
      const sig = await connection.requestAirdrop(publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      setAirdropSig(sig);
      const lamports = await connection.getBalance(publicKey);
      setBalanceSol(lamports / LAMPORTS_PER_SOL);
    } catch (err) {
      setError(`Airdrop failed: ${(err as Error).message}`);
    } finally {
      setWalletBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="topbar">
        <div className="brand">
          <svg width="24" height="20" viewBox="0 0 22 18" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="sol-g" x1="0" y1="0" x2="22" y2="18">
                <stop stopColor="#14F195" />
                <stop offset="1" stopColor="#9945FF" />
              </linearGradient>
            </defs>
            <path d="M6 0h16l-5 4.5H1L6 0z" fill="url(#sol-g)" />
            <path d="M6 6.75h16l-5 4.5H1l5-4.5z" fill="url(#sol-g)" />
            <path d="M6 13.5h16l-5 4.5H1l5-4.5z" fill="url(#sol-g)" />
          </svg>
          <span className="brand-name">InferMesh</span>
          <span className="brand-sub">demo · mock inference</span>
        </div>
        <div className="net"><span className="dot" />Built on Solana</div>
      </div>

      <header className="hero">
        <h1>The open marketplace for <span className="grad">AI inference</span>.</h1>
        <p>Choose a provider, verify which model handled your request, and pay per job — settled on Solana.</p>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="grid">
        <section className="card">
          <h2>New inference job</h2>
          <form onSubmit={submitJob}>
            <label>
              Requester
              <input value={requester} maxLength={128} onChange={(e) => setRequester(e.target.value)} />
            </label>
            <label>
              Model
              <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              Prompt
              <textarea value={input} maxLength={4000} onChange={(e) => setInput(e.target.value)} rows={3} />
            </label>
            <label>
              Budget (lamports)
              <input type="number" value={budget} min={1} onChange={(e) => setBudget(Number(e.target.value))} />
            </label>
            <button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit job (escrow)"}</button>
          </form>
        </section>

        <section className="card">
          <h2>Solana wiring</h2>
          <p className="muted">Program ID: <code>{PROGRAM_ID}</code></p>
          <p className="muted">Marketplace PDA: {pda ? (<a href={explorerAddress(pda)} target="_blank" rel="noreferrer"><code>{pda.slice(0, 12)}…</code></a>) : "…"}</p>
          <WalletMultiButton />
          {connected && publicKey && (
            <div>
              <p>Wallet <code>{publicKey.toBase58().slice(0, 8)}…</code> · {balanceSol !== null ? `${balanceSol.toFixed(2)} SOL (devnet)` : "…"}</p>
              <button className="ghost" onClick={airdrop} disabled={walletBusy}>
                {walletBusy ? "Requesting…" : "Airdrop 1 SOL (devnet)"}
              </button>
              {airdropSig && (
                <p><a href={explorerTx(airdropSig)} target="_blank" rel="noreferrer">View airdrop on explorer</a></p>
              )}
            </div>
          )}
          <p className="muted small">
            Demo escrow settles in the local ledger, which mirrors the Anchor
            program's optimistic-escrow state machine (vault PDA, bonded
            disputes, slashable stake, permissionless finalize). Connect a
            wallet to act as requester on devnet at milestone 1.
          </p>
        </section>
      </div>

      <section className="card">
        <h2>Providers ({providers.length})</h2>
        <table>
          <thead>
            <tr><th>Provider</th><th>Models</th><th>Price / 1k tok</th><th>Stake</th><th>Done</th><th>Score</th><th>Avg latency</th><th>Spot-check</th></tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td><code>{p.id}</code></td>
                <td>{p.modelIds.join(", ")}</td>
                <td>{p.pricePer1kTokensLamports.toLocaleString()}</td>
                <td>{p.stakeLamports.toLocaleString()}</td>
                <td>{p.completedJobs}</td>
                <td>{(p.scoreX100 / 100).toFixed(2)}</td>
                <td>{p.avgLatencyMs ? `${Math.round(p.avgLatencyMs)}ms` : "—"}</td>
                <td>{p.spotCheckTotal ? `${p.spotCheckPass}/${p.spotCheckTotal}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Jobs ({jobs.length})</h2>
        {jobs.map((job) => (
          <div key={job.id} className="job">
            <div className="job-head">
              <strong>#{job.id}</strong>
              <span className={`chip ${STATE_LABEL[job.state]}`}>{STATE_LABEL[job.state]}</span>
              <code>{job.modelId}</code>
              <span className="muted">{job.budgetLamports.toLocaleString()} lamports</span>
              {job.providerId && <span>→ <code>{job.providerId}</code></span>}
            </div>
            <p className="prompt">“{job.input}”</p>
            {job.output && <p className="output">{job.output}</p>}
            <div className="job-actions">
              {job.state === JobState.Submitted && job.output && job.resultHash && (
                <>
                  <button className="ghost" onClick={() => verifyJob(job)}>Verify result hash</button>
                  <button onClick={() => confirmJob(job.id)}>Confirm + release payout</button>
                  <button className="ghost" onClick={() => act(api.dispute(job.id, requester))}>
                    Dispute (bond {disputeBond(job.budgetLamports).toLocaleString()})
                  </button>
                  {job.submittedAt !== null && Date.now() > job.submittedAt + CONFIRM_WINDOW_MS && (
                    <button className="ghost" onClick={() => act(api.finalize(job.id), undefined, job.id)}>
                      Finalize (window passed)
                    </button>
                  )}
                </>
              )}
              {job.state === JobState.Disputed && (
                <>
                  <button className="ghost" onClick={() => act(api.cancelDispute(job.id, requester))}>
                    Cancel dispute
                  </button>
                  <button className="ghost" onClick={() => act(api.resolve(job.id, "provider"))}>
                    Resolve: provider wins
                  </button>
                  <button className="ghost" onClick={() => act(api.resolve(job.id, "requester"))}>
                    Resolve: requester wins
                  </button>
                </>
              )}
              {(job.state === JobState.Open || job.state === JobState.Claimed) && (
                <button className="ghost" onClick={() => act(api.refund(job.id))}>
                  Refund (after deadline)
                </button>
              )}
              {verified[job.id] !== undefined && verified[job.id] !== null && (
                <span className={verified[job.id] ? "ok" : "bad"}>
                  {verified[job.id] ? "✓ hash verifies — output untampered" : "✗ hash mismatch"}
                </span>
              )}
              {job.spotCheckAgreement !== null && job.spotCheckAgreement !== undefined && (
                <span className={job.spotCheckAgreement >= SPOT_CHECK_THRESHOLD ? "ok" : "bad"}>
                  {job.spotCheckAgreement >= SPOT_CHECK_THRESHOLD
                    ? `◉ spot-check ${job.spotCheckAgreement.toFixed(2)} — matches ${job.modelId}`
                    : `◉ spot-check ${job.spotCheckAgreement.toFixed(2)} — FLAGGED, may not be ${job.modelId}`}
                </span>
              )}
              {receipts[job.id] && (
                <span className="ok">
                  paid {receipts[job.id].payout.toLocaleString()} · fee {receipts[job.id].fee.toLocaleString()}
                </span>
              )}
            </div>
            {job.resultHash && <p className="muted small">result_hash <code>{job.resultHash.slice(0, 24)}…</code></p>}
          </div>
        ))}
        {jobs.length === 0 && <p className="muted">No jobs yet — submit the first one above.</p>}
      </section>

      <section className="card">
        <h2>Activity</h2>
        <ul className="events">
          {events.slice(0, 12).map((e, i) => (
            <li key={i}><code>{e.type}</code>{e.jobId ? ` #${e.jobId}` : ""}{e.detail ? ` — ${e.detail}` : ""}</li>
          ))}
        </ul>
      </section>

      <footer className="footer">
        <span>InferMesh · open marketplace for AI inference · MIT</span>
        <span>Program <code>{PROGRAM_ID}</code> · escrow settles onchain at mainnet beta</span>
      </footer>
    </div>
  );
}
