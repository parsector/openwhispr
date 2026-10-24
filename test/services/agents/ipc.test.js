const test = require("node:test");
const assert = require("node:assert/strict");
const { registerAgentIpc } = require("../../../src/services/agents/ipc");

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
        detail: "/tmp/config",
      }),
    },
  });
  const probe = handlers.get("agent-projects-test-harness");
  assert.deepEqual(await probe(null, "claude"), {
    ok: true,
    path: "/usr/local/bin/claude",
    version: "2.1.300",
    error: null,
    auth: { state: "authenticated", method: "claude.ai", detail: "/tmp/config" },
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
      listModels: async () => ["auto", "gpt-5"],
    },
  });
  const result = await handlers.get("agent-projects-test-harness")(null, "cursor-agent");
  assert.deepEqual(result.models, ["auto", "gpt-5"]);
});

test("discard IPC delegates a validated job id", async () => {
  const handlers = new Map();
  let discarded;
  registerAgentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    projectStore: {}, resolver: {},
    manager: { discard: async (id) => { discarded = id; return { jobId: id, discardedAt: 123 }; } },
  });
  assert.deepEqual(await handlers.get("agent-job-discard")(null, "job-1"), { jobId: "job-1", discardedAt: 123 });
  assert.equal(discarded, "job-1");
  assert.throws(() => handlers.get("agent-job-discard")(null, "../bad"), /Invalid name/);
});
