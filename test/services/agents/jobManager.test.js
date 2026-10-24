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
      authStatus: async () => ({ state: "authenticated", method: "claude.ai", detail: null }),
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
  const blocked = setup(t, {
    resolver: { authStatus: async () => ({ state: "not_authenticated" }) },
  });
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
  assert.equal(manager.get(success).noteId, 1);
  assert.equal(manager.get(success).lastError, null);
  assert.equal(notes[0][6], 7);
  assert.equal(notes[0][5], 9);
  const failure = (await manager.prepare({ project: "openwhispr", task: "fail" })).jobId;
  await manager.approve(failure);
  await until(() => manager.get(failure).status === "failed");
  assert.equal(manager.get(failure).lastError, "CLI rejected the request");
  assert.equal(notes.length, 1);
});
test("failed job stores and broadcasts the redacted last stderr line", async (t) => {
  const events = [];
  const { manager } = setup(t, {
    broadcast: (channel, job) => events.push({ channel, job }),
    runnerFactory: () => ({
      start: () => ({
        pid: 123,
        done: Promise.resolve({
          exitCode: 1,
          stderr: "first line\n\u001b[31mBearer secret sk-secret owk_secret\u001b[0m\n",
        }),
      }),
    }),
  });
  const { jobId } = await manager.prepare({ project: "openwhispr", task: "fail" });
  await manager.approve(jobId);
  await until(() => manager.get(jobId).status === "failed");
  assert.equal(manager.get(jobId).lastError, "Bearer <REDACTED> <REDACTED> <REDACTED>");
  assert.equal(events.at(-1).channel, "agent-job-updated");
  assert.equal(events.at(-1).job.lastError, manager.get(jobId).lastError);
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

test("Cursor routes to its runner with configured mode and keeps queue, stall and note behavior", async (t) => {
  const cursorCli = path.join(__dirname, "../../fixtures/fakeCursor.js");
  const { createCursorRunner } = require("../../../src/services/agents/cursorRunner");
  let cursorStarts = 0;
  const { manager, notes, dir, advance } = setup(t, {
    projectStore: {
      read: () => ({
        projects: [
          {
            name: "openwhispr",
            folder: dirPlaceholder(),
            defaultHarness: "cursor-agent",
            mode: "plan",
            model: "auto",
          },
        ],
      }),
    },
    resolver: {
      authStatus: async () => ({ state: "authenticated" }),
      resolve: async () => ({ ok: true, path: cursorCli }),
    },
    runnerFactories: {
      "cursor-agent": (cliPath) => {
        const actual = createCursorRunner({ cliPath });
        return {
          start: (input) => {
            cursorStarts++;
            assert.equal(input.mode, "plan");
            return actual.start(input);
          },
        };
      },
    },
  });
  function dirPlaceholder() {
    return dir;
  }
  await assert.rejects(
    manager.prepare({ project: "openwhispr", task: "x", mode: "agent" }),
    /requires --force/
  );
  await assert.rejects(
    manager.prepare({ project: "openwhispr", task: "x", mode: "ask" }),
    /Mode does not match/
  );
  await assert.rejects(
    manager.prepare({ project: "openwhispr", task: "x", harness: "claude" }),
    /Harness does not match/
  );
  const ids = await Promise.all(
    ["slow one", "slow two", "third"].map(
      async (task) => (await manager.prepare({ project: "openwhispr", task })).jobId
    )
  );
  assert.equal(manager.get(ids[0]).mode, "plan");
  await manager.approve(ids[0]);
  await manager.approve(ids[1]);
  await manager.approve(ids[2]);
  assert.equal(manager.get(ids[2]).status, "queued");
  advance(STALL_MS + 1);
  assert.equal(manager.get(ids[0]).stalled, true);
  await until(() => manager.get(ids[2]).status === "done");
  assert.equal(cursorStarts, 3);
  assert.equal(notes.length, 3);
  const failId = (await manager.prepare({ project: "openwhispr", task: "fail" })).jobId;
  await manager.approve(failId);
  await until(() => manager.get(failId).status === "failed");
  assert.equal(manager.get(failId).lastError, "Bearer <REDACTED> <REDACTED> <REDACTED>");
  assert.equal(notes.length, 3);
});

test("write job edits only its worktree and note records the branch and diff", async (t) => {
  const { execFileSync } = require("node:child_process");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-write-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "source.txt"), "before\n");
  git(repo, "add", "source.txt");
  git(repo, "commit", "-qm", "initial");
  const notes = [];
  const manager = createJobManager({
    file: path.join(root, "userData", "agents", "jobs.json"),
    projectStore: { read: () => ({ projects: [{ name: "project", folder: repo, defaultHarness: "claude", mode: "write", model: null }] }) },
    resolver: { authStatus: async () => ({ state: "authenticated" }), resolve: async () => ({ ok: true, path: process.execPath }) },
    runnerFactory: () => ({ start: ({ folder, mode, branch, onEvent, prompt }) => {
      assert.equal(mode, "write");
      assert.equal(git(folder, "branch", "--show-current"), branch);
      fs.writeFileSync(path.join(folder, "source.txt"), "after\n");
      if (prompt === "fail") return { pid: 123, done: Promise.resolve({ exitCode: 1, stderr: "edit failed" }) };
      const resultEvent = { kind: "result", answer: "Edited source", is_error: false };
      onEvent(resultEvent);
      return { pid: 123, done: Promise.resolve({ exitCode: 0, resultEvent }) };
    } }),
    databaseManager: {
      getPrivateSpaceId: () => 7, getFolders: () => [{ id: 9, name: "Agent jobs" }],
      saveNote: (...args) => { notes.push(args); return { success: true, note: { id: notes.length } }; },
    },
    pidFile: { write() {}, clear() {} },
  });
  t.after(() => manager.stopAll());
  const job = await manager.prepare({ project: "project", task: "edit" });
  assert.match(job.branch, /^agent\/project-/);
  await manager.approve(job.jobId);
  await until(() => manager.get(job.jobId).status === "done");
  const done = manager.get(job.jobId);
  assert.match(done.diffStat, /source.txt/);
  assert.equal(done.changedFileCount, 1);
  assert.ok(notes[0][1].includes(done.branch));
  assert.ok(notes[0][1].includes(done.diffStat));
  assert.equal(git(repo, "status", "--porcelain"), "");
  const failed = await manager.prepare({ project: "project", task: "fail" });
  await manager.approve(failed.jobId);
  await until(() => manager.get(failed.jobId).status === "failed");
  assert.equal(notes.length, 1);
  assert.equal(fs.existsSync(manager.get(failed.jobId).worktreePath), true);
  assert.equal(git(repo, "status", "--porcelain"), "");
  await manager.discard(failed.jobId);
  assert.equal(fs.existsSync(manager.get(failed.jobId).worktreePath), false);
  assert.ok(manager.get(failed.jobId).discardedAt);
});
