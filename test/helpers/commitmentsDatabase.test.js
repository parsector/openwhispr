const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

test("commitment schema survives repeated initialization", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-commitments-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => directory, isReady: () => false } };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  delete require.cache[require.resolve("../../src/helpers/database.js")];
  const DatabaseManager = require("../../src/helpers/database.js");
  let first;
  try { first = new DatabaseManager(); }
  catch (error) {
    if (/NODE_MODULE_VERSION|Could not locate the bindings file/.test(String(error))) {
      t.skip("better-sqlite3 binding unavailable");
      return;
    }
    throw error;
  }
  const names = ["commitments", "commitment_mentions", "commitment_proposals"];
  for (const name of names) {
    assert.equal(first.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(name).n, 1);
  }
  first.db.close();
  const second = new DatabaseManager();
  t.after(() => second.db.close());
  for (const name of names) {
    assert.equal(second.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(name).n, 1);
  }
});

test("legacy commitments gain attribution and agent job columns without changing existing rows or user_version", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-commitments-migrate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => directory, isReady: () => false } };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  delete require.cache[require.resolve("../../src/helpers/database.js")];
  const DatabaseManager = require("../../src/helpers/database.js");
  const { CommitmentStore } = require("../../src/helpers/commitments/store.js");
  const first = new DatabaseManager();
  const row = new CommitmentStore(first).create({ text: "Existing meeting todo" });
  const before = first.db.pragma("user_version", { simple: true });
  const columns = first.db.prepare("PRAGMA table_info(commitments)").all()
    .map((column) => column.name).filter((name) => !["source", "source_agent", "agent_job_id"].includes(name));
  first.db.exec(`CREATE TABLE commitments_legacy AS SELECT ${columns.join(",")} FROM commitments;
    DROP TABLE commitments; ALTER TABLE commitments_legacy RENAME TO commitments;`);
  first.db.close();
  const second = new DatabaseManager();
  assert.equal(second.db.pragma("user_version", { simple: true }), before);
  assert.equal(new CommitmentStore(second).get(row.id).source, "meeting");
  assert.equal(new CommitmentStore(second).get(row.id).source_agent, null);
  assert.equal(new CommitmentStore(second).get(row.id).agent_job_id, null);
  assert.ok(second.db.prepare("PRAGMA table_info(commitments)").all().some((column) => column.name === "agent_job_id"));
  const linked = new CommitmentStore(second).setAgentJob(row.id, "job-123");
  assert.equal(linked.agent_job_id, "job-123");
  assert.equal(linked.status, "open");
  second.db.close();
  const third = new DatabaseManager();
  t.after(() => third.db.close());
  assert.equal(new CommitmentStore(third).get(row.id).agent_job_id, "job-123");
});
