const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createJobManager } = require("../../../src/services/agents/jobManager");
const { createClaudeRunner } = require("../../../src/services/agents/claudeRunner");
const { createCursorRunner } = require("../../../src/services/agents/cursorRunner");

function spawnCapture(calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 123;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
  };
}

test("both runners pass a validated resume ID as argv", () => {
  for (const [harness, factory, mode] of [
    ["claude", createClaudeRunner, "read-only"],
    ["cursor-agent", createCursorRunner, "plan"],
  ]) {
    const calls = [];
    const runner = factory({ cliPath: "/usr/bin/" + harness, spawnImpl: spawnCapture(calls) });
    runner.start({ folder: "/tmp", prompt: "continue", mode, resumeSessionId: "chat:abc-1" });
    assert.deepEqual(
      calls[0].args.slice(calls[0].args.indexOf("--resume"), calls[0].args.indexOf("--resume") + 2),
      ["--resume", "chat:abc-1"]
    );
    assert.equal(calls[0].args.includes("--continue"), false);
    for (const invalid of ["a b", "$(whoami)", "a".repeat(129)])
      assert.throws(
        () => runner.start({ folder: "/tmp", prompt: "continue", mode, resumeSessionId: invalid }),
        /no_session/
      );
    assert.equal(calls.length, 1);
  }
});

test("prepare validates parent and persists resumedFrom; write resume reuses its worktree", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "agents", "jobs.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const worktree = path.join(dir, "worktree");
  fs.mkdirSync(worktree);
  const parent = {
    jobId: "parent",
    status: "done",
    project: { name: "repo", folder: dir },
    harness: "claude",
    mode: "write",
    model: null,
    sessionId: "session:1",
    worktreePath: worktree,
    branch: "agent/repo-parent",
  };
  fs.writeFileSync(file, JSON.stringify({ jobs: [parent] }));
  let allowed = true;
  const projects = () =>
    allowed
      ? [{ name: "repo", folder: dir, defaultHarness: "claude", mode: "write", model: null }]
      : [];
  const starts = [];
  const manager = createJobManager({
    file,
    projectStore: { read: () => ({ projects: projects() }) },
    resolver: {
      authStatus: async () => ({ state: "authenticated" }),
      resolve: async () => ({ ok: true, path: "/usr/bin/claude" }),
    },
    runnerFactory: () => ({
      start: (input) => {
        starts.push(input);
        return { pid: 123, cancel() {}, done: new Promise(() => {}) };
      },
    }),
    databaseManager: {},
    pidFile: { write() {}, clear() {} },
    worktreeService: {
      sweep: async () => {},
      create: async () => {
        throw new Error("must not create");
      },
    },
  });
  t.after(() => manager.stopAll());
  await assert.rejects(manager.prepare({ resumeJobId: "missing", task: "next" }), /unknown_job/);
  const next = await manager.prepare({ resumeJobId: "parent", task: "next" });
  assert.equal(manager.get(next.jobId).resumedFrom, "parent");
  assert.equal(manager.get(next.jobId).worktreePath, worktree);
  assert.equal(JSON.parse(fs.readFileSync(file)).jobs.at(-1).resumedFrom, "parent");
  await manager.approve(next.jobId);
  assert.equal(starts[0].folder, worktree);
  assert.equal(starts[0].resumeSessionId, "session:1");
  await assert.rejects(manager.discard("parent"), /Worktree is used by another job/);
  allowed = false;
  await assert.rejects(manager.prepare({ resumeJobId: "parent", task: "next" }), /project_missing/);
  allowed = true;
  fs.rmSync(worktree, { recursive: true });
  await assert.rejects(
    manager.prepare({ resumeJobId: "parent", task: "next" }),
    /worktree_missing/
  );
});

test("missing and malformed saved sessions cannot be resumed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resume-invalid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const sessionId of [null, "bad id", "x".repeat(129)]) {
    const file = path.join(dir, `jobs-${String(sessionId).length}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        jobs: [
          {
            jobId: "parent",
            status: "failed",
            project: { name: "repo", folder: dir },
            harness: "claude",
            mode: "read-only",
            sessionId,
          },
        ],
      })
    );
    const manager = createJobManager({
      file,
      projectStore: {
        read: () => ({
          projects: [{ name: "repo", folder: dir, defaultHarness: "claude", mode: "read-only" }],
        }),
      },
      resolver: {},
      databaseManager: {},
      pidFile: {},
      worktreeService: { sweep: async () => {} },
    });
    t.after(() => manager.stopAll());
    await assert.rejects(
      manager.prepare({ resumeJobId: "parent", task: "continue" }),
      /no_session/
    );
  }
});

test("failed read-only jobs with a session can resume without a project input", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resume-read-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "jobs.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      jobs: [
        {
          jobId: "parent",
          status: "failed",
          project: { name: "repo", folder: dir },
          harness: "cursor-agent",
          mode: "plan",
          model: "auto",
          sessionId: "chat:1",
        },
      ],
    })
  );
  const manager = createJobManager({
    file,
    projectStore: {
      read: () => ({
        projects: [
          {
            name: "repo",
            folder: dir,
            defaultHarness: "cursor-agent",
            mode: "plan",
            model: "auto",
          },
        ],
      }),
    },
    resolver: {
      authStatus: async () => ({ state: "authenticated" }),
      resolve: async () => ({ ok: true, path: "/usr/bin/cursor-agent" }),
    },
    databaseManager: {},
    pidFile: {},
    worktreeService: { sweep: async () => {} },
  });
  t.after(() => manager.stopAll());
  const prepared = await manager.prepare({ resumeJobId: "parent", task: "continue" });
  const child = manager.get(prepared.jobId);
  assert.equal(child.resumedFrom, "parent");
  assert.equal(child.resumeSessionId, "chat:1");
  assert.equal(child.project.folder, dir);
  assert.equal(child.worktreePath, undefined);
});
