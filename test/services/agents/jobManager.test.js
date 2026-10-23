const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJobManager, STALL_MS } = require("../../../src/services/agents/jobManager");
const { createClaudeRunner } = require("../../../src/services/agents/claudeRunner");
const fakeCli = path.join(__dirname, "../../fixtures/fakeClaude.js");
function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-jobs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const notes = [];
  const db = {
    getPrivateSpaceId: () => 7,
    getFolders: () => [{ id: 9, name: "Agent jobs", space_id: 7 }],
    saveNote: (...args) => {
      notes.push(args);
      return { success: true, note: { id: notes.length } };
    },
  };
  let clock = 1000;
  const manager = createJobManager({
    file: path.join(dir, "jobs.json"),
    projectStore: {
      read: () => ({
        projects: [
          {
            name: "openwhispr",
            folder: dir,
            defaultHarness: "claude",
            mode: "read-only",
            model: "sonnet",
          },
        ],
      }),
    },
    resolver: {
      authStatus: async () => "authenticated",
      resolve: async () => ({ ok: true, path: fakeCli }),
    },
    runnerFactory: (cliPath) => createClaudeRunner({ cliPath }),
    databaseManager: db,
    now: () => clock,
    pidFile: { write() {}, clear() {} },
    ...overrides,
  });
  t.after(() => manager.stopAll());
  return {
    manager,
    notes,
    dir,
    advance: (ms) => {
      clock += ms;
      manager.checkStalls();
    },
  };
}
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out");
}
test("approval required and auth failure blocks prepare", async (t) => {
  const { manager, notes } = setup(t);
  const prepared = await manager.prepare({ project: "openwhispr", task: "hello" });
  assert.equal(manager.get(prepared.jobId).status, "pending");
  assert.equal(notes.length, 0);
  const blocked = setup(t, { resolver: { authStatus: async () => "not_authenticated" } });
  await assert.rejects(
    blocked.manager.prepare({ project: "openwhispr", task: "hello" }),
    /not_authenticated/
  );
});
test("two run and third queues FIFO then starts", async (t) => {
  const { manager } = setup(t);
  const ids = await Promise.all(
    ["slow one", "slow two", "third"].map(
      async (task) => (await manager.prepare({ project: "openwhispr", task })).jobId
    )
  );
  await manager.approve(ids[0]);
  await manager.approve(ids[1]);
  await manager.approve(ids[2]);
  assert.equal(manager.get(ids[2]).status, "queued");
  assert.equal(manager.get(ids[2]).position, 1);
  await until(() => manager.get(ids[2]).status === "done");
  assert.equal(manager.get(ids[0]).status, "done");
});
test("cancel stops running process group and stall is display only", async (t) => {
  const { manager, advance } = setup(t);
  const { jobId } = await manager.prepare({ project: "openwhispr", task: "hang" });
  await manager.approve(jobId);
  advance(STALL_MS + 1);
  assert.equal(manager.get(jobId).stalled, true);
  assert.equal(manager.get(jobId).status, "running");
  manager.cancel(jobId);
  assert.equal(manager.get(jobId).status, "cancelled");
});
test("success saves private note and failure saves none", async (t) => {
  const { manager, notes } = setup(t);
  const success = (await manager.prepare({ project: "openwhispr", task: "okay" })).jobId;
  await manager.approve(success);
  await until(() => manager.get(success).status === "done");
  assert.equal(notes[0][6], 7);
  assert.equal(notes[0][5], 9);
  const failure = (await manager.prepare({ project: "openwhispr", task: "fail" })).jobId;
  await manager.approve(failure);
  await until(() => manager.get(failure).status === "failed");
  assert.equal(notes.length, 1);
});
test("running on disk becomes failed/interrupted", (t) => {
  const { manager, dir } = setup(t);
  manager.stopAll();
  const file = path.join(dir, "jobs.json");
  fs.writeFileSync(file, JSON.stringify({ jobs: [{ jobId: "old", status: "running" }] }));
  const loaded = createJobManager({
    file,
    projectStore: {},
    resolver: {},
    runnerFactory: () => {},
    databaseManager: {},
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    pidFile: {},
  });
  assert.equal(loaded.get("old").status, "failed");
  assert.equal(loaded.get("old").reason, "interrupted");
});
test("edited approval expires after ten minutes", async (t) => {
  const { manager, advance } = setup(t);
  const first = (await manager.prepare({ project: "openwhispr", task: "initial" })).jobId;
  await manager.approve(first, { prompt: "edited" });
  assert.equal(manager.get(first).prompt, "edited");
  const second = (await manager.prepare({ project: "openwhispr", task: "later" })).jobId;
  advance(10 * 60 * 1000);
  await assert.rejects(manager.approve(second), /expired/);
  assert.equal(manager.get(second).status, "failed");
});
test("policy denial blocks prepare", async (t) => {
  const { manager } = setup(t, { policyAllowed: async () => false });
  await assert.rejects(
    manager.prepare({ project: "openwhispr", task: "task" }),
    /agent_disallowed/
  );
});
