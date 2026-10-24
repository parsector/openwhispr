const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJobManager, STALL_MS } = require("../../../src/services/agents/jobManager");
const debugLogger = require("../../../src/helpers/debugLogger");
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
    db,
    dir,
    advance: (ms) => {
      clock += ms;
      manager.checkStalls();
    },
  };
}
test("missing context drops with a specific reason and still prepares", async (t) => {
  const { manager, db } = setup(t);
  db.getNote = () => null;
  const prepared = await manager.prepare({
    project: "openwhispr",
    task: "hello",
    contextNoteId: 72,
  });
  assert.equal(prepared.contextDropped, true);
  assert.equal(prepared.contextDropReason, "note_missing");
  assert.equal(manager.get(prepared.jobId).status, "pending");
  assert.equal(manager.get(prepared.jobId).contextNoteId, undefined);
});
test("scheduled source is persisted and included in the saved note", async (t) => {
  const { manager, dir, notes } = setup(t);
  const started = await manager.startScheduled({
    id: "nightly",
    project: "openwhispr",
    harness: "claude",
    mode: "read-only",
    prompt: "Review repository",
    model: "sonnet",
  });
  assert.equal(manager.get(started.jobId).scheduledFrom, "nightly");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")).jobs[0].scheduledFrom,
    "nightly"
  );
  await until(() => manager.get(started.jobId).status === "done");
  assert.match(notes[0][1], /Scheduled from preset: nightly/);
});

test("note context persists and a successful result appends once without trimming", async (t) => {
  const { manager, db, dir, notes } = setup(t);
  const note = {
    id: 42,
    title: "Meeting",
    content: "Decisions  \n",
    enhanced_content: "",
    space_id: 7,
  };
  const updates = [];
  db.getNote = (id) => (id === 42 ? { ...note } : null);
  db.getSpace = () => ({ kind: "private" });
  db.updateNote = (_id, change) => {
    updates.push(change.content);
    note.content = change.content;
    return { success: true, note: { ...note } };
  };
  const prepared = await manager.prepare({
    project: "openwhispr",
    task: "Summarize",
    contextNoteId: 42,
  });
  assert.equal(prepared.contextNoteTitle, "Meeting");
  assert.equal(prepared.contextChars, Array.from("Decisions  \n").length);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")).jobs[0].contextNoteId,
    42
  );
  await manager.approve(prepared.jobId);
  await until(() => manager.get(prepared.jobId).status === "done");
  assert.equal(notes.length, 0);
  assert.equal(updates.length, 1);
  assert.ok(note.content.startsWith("Decisions  \n\n\n## Agent job — claude · "));
  assert.match(note.content, /## Agent job — claude · /);
  assert.equal(manager.get(prepared.jobId).noteId, 42);
});

test("unwritable team note falls back to a private result note", async (t) => {
  const { manager, db, notes } = setup(t);
  db.getNote = () => ({ id: 42, title: "Team", content: "Text", space_id: 8 });
  db.getSpace = () => ({ kind: "team", cloud_space_id: "space", my_role: null });
  db.updateNote = () => assert.fail("must not write to unwritable note");
  const prepared = await manager.prepare({
    project: "openwhispr",
    task: "Summarize",
    contextNoteId: 42,
  });
  await manager.approve(prepared.jobId);
  await until(() => manager.get(prepared.jobId).status === "done");
  assert.equal(notes.length, 1);
  assert.equal(manager.get(prepared.jobId).contextAppendFallback, true);
});
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out");
}
test("approval proceeds with advisory auth warning", async (t) => {
  const { manager, notes } = setup(t);
  const prepared = await manager.prepare({ project: "openwhispr", task: "hello" });
  assert.equal(manager.get(prepared.jobId).status, "pending");
  assert.equal(notes.length, 0);
  for (const state of ["not_authenticated", "unknown"]) {
    const { manager: warned } = setup(t, {
      resolver: {
        authStatus: async () => ({ state }),
        resolve: async () => ({ ok: true, path: fakeCli }),
      },
    });
    const job = await warned.prepare({ project: "openwhispr", task: "hello" });
    assert.equal(job.authWarning, true);
    assert.equal(warned.get(job.jobId).authWarning, true);
    await warned.approve(job.jobId);
    await until(() => warned.get(job.jobId).status === "done");
  }
});
test("prepare validates and persists a bounded origin", async (t) => {
  const { manager, dir } = setup(t);
  const origin = {
    conversationId: 7,
    messageId: "123e4567-e89b-12d3-a456-426614174000",
    toolCallId: "call-1",
    surface: "assistant",
    extra: "never-persist-this",
  };
  const { jobId } = await manager.prepare({ project: "openwhispr", task: "hello", origin });
  const normalized = {
    conversationId: "7",
    messageId: origin.messageId,
    toolCallId: "call-1",
    surface: "assistant",
  };
  assert.deepEqual(manager.get(jobId).origin, normalized);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")).jobs[0].origin,
    normalized
  );
  for (const value of ["8", 8]) {
    const prepared = await manager.prepare({
      project: "openwhispr",
      task: "hello",
      origin: { conversationId: value },
    });
    assert.deepEqual(manager.get(prepared.jobId).origin, { conversationId: "8", surface: "chat" });
  }
  const padded = await manager.prepare({
    project: "openwhispr",
    task: "hello",
    origin: { conversationId: "0008" },
  });
  assert.equal(manager.get(padded.jobId).origin.conversationId, "8");
  const partial = await manager.prepare({
    project: "openwhispr",
    task: "hello",
    origin: {
      conversationId: "9",
      messageId: "bad id",
      toolCallId: "x".repeat(129),
      surface: "other",
      surprise: "never-persist-this",
    },
  });
  assert.deepEqual(manager.get(partial.jobId).origin, { conversationId: "9", surface: "chat" });
  for (const invalid of [0, -1, "1".repeat(21), "../jobs.json", null]) {
    const prepared = await manager.prepare({
      project: "openwhispr",
      task: "hello",
      origin: { conversationId: invalid },
    });
    assert.equal(manager.get(prepared.jobId).origin, undefined);
    assert.equal(manager.get(prepared.jobId).originDropped, true);
  }
  const unusable = await manager.prepare({ project: "openwhispr", task: "hello", origin: "bad" });
  assert.equal(manager.get(unusable.jobId).originDropped, true);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"), /never-persist-this/);
});
test("prepare reports a field and logs failure when debug is off", async (t) => {
  const { manager } = setup(t);
  const errors = [];
  const original = debugLogger.isDebugEnabled;
  debugLogger.isDebugEnabled = () => false;
  t.mock.method(debugLogger, "error", (...args) => errors.push(args));
  t.after(() => {
    debugLogger.isDebugEnabled = original;
  });
  await assert.rejects(
    manager.prepare({ project: "openwhispr", task: "hello", model: "bad;model" }),
    (error) => error.message === "invalid_model (model)" && error.field === "model"
  );
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0][1], {
    field: "model",
    value: "bad;model",
    reason: "invalid_model (model)",
  });
});
test("numeric origin delivers completed job to its conversation", async (t) => {
  const {
    deliverJobMessage,
    jobMessageId,
  } = require("../../../src/services/agents/jobDelivery.ts");
  const { manager } = setup(t);
  const prepared = await manager.prepare({
    project: "openwhispr",
    task: "hello",
    origin: { conversationId: 7 },
  });
  await manager.approve(prepared.jobId);
  await until(() => manager.get(prepared.jobId).status === "done");
  const calls = [];
  assert.equal(
    await deliverJobMessage(
      manager.get(prepared.jobId),
      (key) => key,
      async (...args) => {
        calls.push(args);
        return { success: true };
      }
    ),
    true
  );
  assert.equal(calls[0][0], 7);
  assert.equal(calls[0][3].messageId, jobMessageId(prepared.jobId));
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
test("fan-out enumerates before approval, persists five jobs, and shares the FIFO queue", async (t) => {
  const targets = [8, 3, 12, 5, 9].map((number) => ({
    number,
    title: `PR ${number}`,
    headRefName: `b${number}`,
  }));
  const { manager, dir } = setup(t, {
    enumerateOpenPullRequests: async () => ({
      ok: true,
      targets: targets.sort((a, b) => a.number - b.number),
      total: 6,
    }),
  });
  const preset = {
    name: "Review PRs",
    project: "openwhispr",
    harness: "claude",
    mode: "read-only",
    model: "sonnet",
    prompt: "slow {{pr}}",
    fanOut: "open-pull-requests",
  };
  const preview = await manager.enumerateFanOut(preset);
  assert.equal(preview.total, 6);
  assert.deepEqual(
    preview.targets.map((item) => item.number),
    [3, 5, 8, 9, 12]
  );
  assert.equal(manager.list().length, 0);
  manager.cancelFanOut(preview.fanOutId);
  assert.equal(manager.list().length, 0);
  await assert.rejects(manager.approveFanOut(preview.fanOutId), /expired/);
  const approved = await manager.enumerateFanOut(preset);
  const jobs = await manager.approveFanOut(approved.fanOutId);
  assert.equal(jobs.length, 5);
  assert.deepEqual(
    jobs.map((job) => job.prompt),
    ["slow 3", "slow 5", "slow 8", "slow 9", "slow 12"]
  );
  assert.deepEqual(
    jobs.map((job) => job.fanOutIndex),
    [1, 2, 3, 4, 5]
  );
  assert.ok(jobs.every((job) => job.fanOutId === approved.fanOutId && job.fanOutTotal === 5));
  assert.deepEqual(
    jobs.map((job) => job.status),
    ["running", "running", "queued", "queued", "queued"]
  );
  assert.deepEqual(
    jobs.slice(2).map((job) => job.position),
    [1, 2, 3]
  );
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")).jobs;
  assert.equal(persisted.filter((job) => job.fanOutId === approved.fanOutId).length, 5);
  manager.cancel(jobs[2].jobId);
  assert.equal(manager.get(jobs[2].jobId).status, "cancelled");
  assert.equal(manager.get(jobs[3].jobId).status, "queued");
  assert.equal(manager.get(jobs[3].jobId).position, 1);
});

test("failed fan-out enumeration prepares no jobs", async (t) => {
  for (const reason of ["gh_missing", "parse_failed"]) {
    const { manager } = setup(t, {
      enumerateOpenPullRequests: async () => ({ ok: false, reason }),
    });
    const result = await manager.enumerateFanOut({
      name: "PRs",
      project: "openwhispr",
      prompt: "Review {{pr}}",
      fanOut: "open-pull-requests",
    });
    assert.deepEqual(result, { ok: false, reason });
    assert.deepEqual(manager.list(), []);
  }
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
  assert.equal(events.at(-1).job.lastError, "Bearer <REDACTED> <REDACTED> <REDACTED>");
  assert.equal(events.at(-1).job.debug, undefined);
  assert.doesNotMatch(
    JSON.stringify(events.at(-1).job),
    /argv|stdoutSnippet|stderrSnippet|configDirectory|textProbe|email/
  );
  const original = debugLogger.isDebugEnabled;
  debugLogger.isDebugEnabled = () => true;
  try {
    manager.checkStalls();
    const { jobPayload } = require("../../../src/services/agents/debugPayload");
    assert.equal(jobPayload(manager.get(jobId)).lastError, manager.get(jobId).lastError);
  } finally {
    debugLogger.isDebugEnabled = original;
  }
});

test("untrusted Cursor refusal fails without a note and keeps the redacted banner line", async (t) => {
  const { manager, notes, dir } = setup(t, {
    projectStore: {
      read: () => ({
        projects: [
          {
            name: "openwhispr",
            folder: dirPlaceholder(),
            defaultHarness: "cursor-agent",
            mode: "plan",
            model: null,
            trustWorkspace: false,
          },
        ],
      }),
    },
    runnerFactories: {
      "cursor-agent": () => ({
        start: (input) => {
          assert.equal(input.trustWorkspace, false);
          return {
            pid: 123,
            done: Promise.resolve({
              exitCode: 0,
              stderr: "",
              reason: "workspace_untrusted",
              trustRefusalLine: "Workspace Trust Required Bearer secret",
            }),
          };
        },
      }),
    },
  });
  function dirPlaceholder() {
    return dir;
  }
  const prepared = await manager.prepare({ project: "openwhispr", task: "hello" });
  assert.equal(prepared.project.trustWorkspace, false);
  await manager.approve(prepared.jobId);
  await until(() => manager.get(prepared.jobId).status === "failed");
  assert.equal(manager.get(prepared.jobId).reason, "workspace_untrusted");
  assert.equal(manager.get(prepared.jobId).lastError, "Workspace Trust Required Bearer <REDACTED>");
  assert.equal(notes.length, 0);
});
test("running on disk becomes failed/interrupted", (t) => {
  const { manager, dir } = setup(t);
  manager.stopAll();
  const file = path.join(dir, "jobs.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      jobs: [
        {
          jobId: "old",
          status: "running",
          origin: { conversationId: 7, privatePath: "never-persist-this" },
        },
      ],
    })
  );
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
  assert.deepEqual(loaded.get("old").origin, { conversationId: "7", surface: "chat" });
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /never-persist-this/);
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
    projectStore: {
      read: () => ({
        projects: [
          { name: "project", folder: repo, defaultHarness: "claude", mode: "write", model: null },
        ],
      }),
    },
    resolver: {
      authStatus: async () => ({ state: "authenticated" }),
      resolve: async () => ({ ok: true, path: process.execPath }),
    },
    runnerFactory: () => ({
      start: ({ folder, mode, branch, onEvent, prompt }) => {
        assert.equal(mode, "write");
        assert.equal(git(folder, "branch", "--show-current"), branch);
        fs.writeFileSync(path.join(folder, "source.txt"), "after\n");
        if (prompt === "fail")
          return { pid: 123, done: Promise.resolve({ exitCode: 1, stderr: "edit failed" }) };
        const resultEvent = { kind: "result", answer: "Edited source", is_error: false };
        onEvent(resultEvent);
        return { pid: 123, done: Promise.resolve({ exitCode: 0, resultEvent }) };
      },
    }),
    databaseManager: {
      getPrivateSpaceId: () => 7,
      getFolders: () => [{ id: 9, name: "Agent jobs" }],
      saveNote: (...args) => {
        notes.push(args);
        return { success: true, note: { id: notes.length } };
      },
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
