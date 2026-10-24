const test = require("node:test");
const assert = require("node:assert/strict");
const { registerAgentIpc } = require("../../../src/services/agents/ipc");
const debugLogger = require("../../../src/helpers/debugLogger");

test("prepare accepts origin and logs specific validation failures with debug off", async (t) => {
  const handlers = new Map();
  const errors = [];
  const original = debugLogger.isDebugEnabled;
  debugLogger.isDebugEnabled = () => false;
  t.mock.method(debugLogger, "error", (...args) => errors.push(args));
  t.after(() => {
    debugLogger.isDebugEnabled = original;
  });
  let prepared;
  registerAgentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    projectStore: {},
    presetStore: {},
    resolver: {},
    manager: {
      prepare: async (input) => {
        prepared = input;
        const error = new Error("invalid_model (model)");
        error.field = "model";
        throw error;
      },
    },
  });
  await assert.rejects(
    handlers.get("agent-job-prepare")(null, {
      project: "p",
      task: "t",
      model: "bad-model",
      origin: { conversationId: 7 },
    }),
    (error) => error.message === "invalid_model (model)" && error.field === "model"
  );
  assert.deepEqual(prepared.origin, { conversationId: 7 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].field, "model");
  assert.equal(errors[0][1].value, "bad-model");
});

test("harness IPC gates CLI evidence and drops account metadata", async (t) => {
  const original = debugLogger.isDebugEnabled;
  t.after(() => {
    debugLogger.isDebugEnabled = original;
  });
  const handlers = new Map();
  registerAgentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    projectStore: {},
    presetStore: {},
    manager: {},
    resolver: {
      test: async () => ({
        path: "/usr/bin/claude",
        version: "2",
        error: null,
        argv: ["--version"],
        exitCode: 0,
        stdoutSnippet: "version",
        stderrSnippet: "",
        durationMs: 1,
        email: "owner@example.com",
        orgId: "secret",
        orgName: "secret",
        projectsDirectory: "/private/projects",
      }),
      authStatus: async () => ({
        state: "authenticated",
        method: "claude.ai",
        detail: null,
        argv: ["auth", "status"],
        exitCode: 0,
        stdoutSnippet: "auth",
        stderrSnippet: "",
        configDirectory: "/private/.claude",
        subscriptionType: "max",
        textProbe: { argv: ["auth", "status", "--text"], stdoutSnippet: "max" },
        email: "owner@example.com",
        orgId: "secret",
        orgName: "secret",
        projectsDirectory: "/private/projects",
      }),
    },
  });
  const probe = handlers.get("agent-projects-test-harness");
  debugLogger.isDebugEnabled = () => false;
  const normal = await probe(null, "claude");
  assert.deepEqual(Object.keys(normal).sort(), ["auth", "error", "path", "version"]);
  assert.deepEqual(normal.auth, { state: "authenticated", method: "claude.ai", detail: null });
  assert.doesNotMatch(
    JSON.stringify(normal),
    /argv|stdoutSnippet|stderrSnippet|configDirectory|textProbe|owner@example.com|orgId|orgName|projectsDirectory/
  );
  debugLogger.isDebugEnabled = () => true;
  const verbose = await probe(null, "claude");
  assert.deepEqual(verbose.debug.test.argv, ["--version"]);
  assert.equal(verbose.debug.auth.configDirectory, "/private/.claude");
  assert.equal(verbose.debug.auth.textProbe.stdoutSnippet, "max");
  assert.doesNotMatch(JSON.stringify(verbose), /owner@example.com|orgId|orgName|projectsDirectory/);
});

test("test harness IPC returns auth and accepts only a harness id", async () => {
  const handlers = new Map();
  registerAgentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    projectStore: {},
    manager: {},
    resolver: {
      test: async () => ({
        ok: true,
        path: "/usr/local/bin/claude",
        version: "2.1.300",
        error: null,
      }),
      authStatus: async () => ({
        state: "authenticated",
        method: "claude.ai",
        detail: null,
      }),
    },
  });
  const probe = handlers.get("agent-projects-test-harness");
  assert.deepEqual(await probe(null, "claude"), {
    path: "/usr/local/bin/claude",
    version: "2.1.300",
    error: null,
    auth: { state: "authenticated", method: "claude.ai", detail: null },
  });
  await assert.rejects(probe(null, { harness: "claude", folder: "/tmp" }), /Invalid harness/);
});

test("Cursor harness probe includes available models", async () => {
  const handlers = new Map();
  registerAgentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    projectStore: {},
    manager: {},
    resolver: {
      test: async () => ({
        ok: true,
        path: "/usr/local/bin/cursor-agent",
        version: "1",
        error: null,
      }),
      authStatus: async () => ({ state: "authenticated", method: null, detail: null }),
      listModels: async () => ({ ok: true, models: ["auto", "gpt-5"] }),
    },
  });
  const result = await handlers.get("agent-projects-test-harness")(null, "cursor-agent");
  assert.deepEqual(Object.keys(result).sort(), ["auth", "error", "path", "version"]);
  assert.deepEqual(await handlers.get("agent-projects-list-models")(), {
    ok: true,
    models: ["auto", "gpt-5"],
  });
});

test("discard IPC delegates a validated job id", async () => {
  const handlers = new Map();
  let discarded;
  registerAgentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    projectStore: {},
    resolver: {},
    manager: {
      discard: async (id) => {
        discarded = id;
        return { jobId: id, discardedAt: 123 };
      },
    },
  });
  assert.deepEqual(await handlers.get("agent-job-discard")(null, "job-1"), {
    jobId: "job-1",
    discardedAt: 123,
  });
  assert.equal(discarded, "job-1");
  await assert.rejects(handlers.get("agent-job-discard")(null, "../bad"), /Invalid name/);
});

test("job IPC keeps the redacted CLI message while gating raw reason", (t) => {
  const original = debugLogger.isDebugEnabled;
  t.after(() => {
    debugLogger.isDebugEnabled = original;
  });
  const handlers = new Map();
  registerAgentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    projectStore: {},
    presetStore: {},
    resolver: {},
    manager: {
      get: () => ({
        jobId: "job-1",
        reason: "spawn /private/cli failed",
        lastError: "CLI rejected request",
      }),
      list: () => [
        { jobId: "job-1", reason: "spawn /private/cli failed", lastError: "CLI rejected request" },
      ],
    },
  });
  debugLogger.isDebugEnabled = () => false;
  assert.deepEqual(handlers.get("agent-job-get")(null, "job-1"), {
    jobId: "job-1",
    reason: "command_failed",
    lastError: "CLI rejected request",
  });
  assert.deepEqual(handlers.get("agent-job-list")(), [
    { jobId: "job-1", reason: "command_failed", lastError: "CLI rejected request" },
  ]);
  debugLogger.isDebugEnabled = () => true;
  assert.deepEqual(handlers.get("agent-job-get")(null, "job-1"), {
    jobId: "job-1",
    reason: "command_failed",
    lastError: "CLI rejected request",
    debug: { reason: "spawn /private/cli failed" },
  });
});

test("preset IPC lists, saves, and removes through the validated store", () => {
  const handlers = new Map();
  const calls = [];
  registerAgentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    projectStore: {},
    resolver: {},
    manager: {},
    presetStore: {
      read: () => ({ presets: [] }),
      save: (preset) => {
        calls.push(["save", preset]);
        return { presets: [preset] };
      },
      remove: (id) => {
        calls.push(["remove", id]);
        return { presets: [] };
      },
    },
  });
  const preset = { id: "preset-1" };
  assert.deepEqual(handlers.get("agent-presets-list")(), { presets: [] });
  assert.deepEqual(handlers.get("agent-presets-save")(null, preset), { presets: [preset] });
  assert.deepEqual(handlers.get("agent-presets-remove")(null, "preset-1"), { presets: [] });
  assert.deepEqual(calls, [
    ["save", preset],
    ["remove", "preset-1"],
  ]);
  assert.throws(() => handlers.get("agent-presets-remove")(null, "../bad"), /Invalid name/);
});
