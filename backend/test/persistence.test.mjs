import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("ledger persistence", () => {
  let dir;
  let store;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "infermesh-test-"));
    process.env.INFERMESH_DATA_DIR = dir;
    store = await import("../dist/store.js");
  });

  it("writes an atomic snapshot that restores state", async () => {
    const { ledger, saveLedger } = store;
    await ledger.createJob("persist-alice", "llama-3-8b", "remember me", 7000, 64);
    saveLedger();
    const snapPath = path.join(dir, "ledger.json");
    assert.ok(fs.existsSync(snapPath));
    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    assert.equal(snap.version, 1);
    assert.ok(snap.jobs.some((j) => j.requester === "persist-alice"));
    // No temp files left behind by the atomic rename.
    assert.deepEqual(fs.readdirSync(dir), ["ledger.json"]);
  });
});
