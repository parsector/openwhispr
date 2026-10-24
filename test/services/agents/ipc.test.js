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
