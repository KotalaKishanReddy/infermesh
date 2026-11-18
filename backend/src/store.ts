import fs from "node:fs";
import path from "node:path";
import { MockLedger, type LedgerSnapshot } from "@infermesh/sdk";

/** Shared demo ledger with atomic JSON persistence across restarts. */

const DATA_DIR = process.env.INFERMESH_DATA_DIR ?? path.resolve("data");
const SNAPSHOT_PATH = path.join(DATA_DIR, "ledger.json");

export const ledger = new MockLedger(250);

function loadSnapshot(): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
  } catch {
    return false; // first boot: seed below
  }
  try {
    const snap = JSON.parse(raw) as LedgerSnapshot;
    ledger.restore(snap);
    console.log(`[store] restored snapshot: ${ledger.providers.size} providers, ${ledger.jobs.size} jobs`);
    return true;
  } catch (err) {
    console.warn(`[store] ignoring corrupt snapshot: ${(err as Error).message}`);
    return false;
  }
}

const restored = loadSnapshot();

if (!restored || ledger.providers.size === 0) {
  const SEED_PROVIDERS = [
    {
      id: "sol-gpu-01",
      owner: "DemoOperator1",
      modelIds: ["llama-3-8b", "mistral-7b"],
      pricePer1kTokensLamports: 5_000,
      stakeLamports: 500_000,
    },
    {
      id: "sol-gpu-02",
      owner: "DemoOperator2",
      modelIds: ["llama-3-8b", "code-7b"],
      pricePer1kTokensLamports: 4_000,
      stakeLamports: 250_000,
    },
    {
      id: "sol-gpu-03",
      owner: "DemoOperator3",
      modelIds: ["mistral-7b"],
      pricePer1kTokensLamports: 3_000,
      stakeLamports: 100_000,
    },
  ];

  for (const p of SEED_PROVIDERS) {
    try {
      ledger.registerProvider(p);
    } catch {
      // Already present (e.g. restored snapshot).
    }
  }
}

/** Persist ledger state atomically (tmp file + rename). Call after mutations. */
export function saveLedger(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${SNAPSHOT_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger.snapshot()));
    fs.renameSync(tmp, SNAPSHOT_PATH);
  } catch (err) {
    console.warn(`[store] snapshot failed: ${(err as Error).message}`);
  }
}
