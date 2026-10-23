const { test } = require("node:test");
const assert = require("node:assert/strict");
const { registerMcpIpc } = require("../../../../src/services/mcp/client/ipc");

test("main owns first-call approval and allow-without-asking confirmation", async () => {
  const handlers = new Map();
  const prompts = [];
  let calls = 0;
  let allowed = false;
  const manager = {
    config: () => ({ mcpServers: { demo: { type: "http", url: "http://localhost" } } }),
    isEnabled: () => true,
    tools: () => [{ name: "echo" }],
    settings: () => ({ allowWithoutAsking: allowed }),
    call: async () => {
      calls++;
      return { content: [] };
    },
    setAllow: (_name, value) => {
      allowed = value;
      return {};
    },
    list: () => ({}),
  };
  registerMcpIpc(manager, {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {
      showMessageBox: async (options) => {
        prompts.push(options.title);
        return { response: 1 };
      },
    },
  });
  const event = { sender: { id: 1 } };
  await handlers.get("mcp-client-call")(event, "demo", "echo", {}, "one");
  await handlers.get("mcp-client-call")(event, "demo", "echo", {}, "two");
  assert.equal(calls, 2);
  assert.deepEqual(prompts, ["Approve MCP tool"]);
  await handlers.get("mcp-client-allow")(event, "demo", true);
  assert.equal(allowed, true);
  assert.deepEqual(prompts, ["Approve MCP tool", "Allow MCP tools without asking"]);
});
test("stdio command confirmation shows exact spawn details in main", async () => {
  const handlers = new Map();
  let shown;
  let confirmed = false;
  const server = { command: "node", args: ["server.js"], cwd: "/tmp/work" };
  registerMcpIpc(
    {
      config: () => ({ mcpServers: { local: server } }),
      confirm: async (_name, details) => {
        confirmed = true;
        assert.deepEqual(details, { command: "node", args: ["server.js"], cwd: "/tmp/work" });
        return {};
      },
    },
    {
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      dialog: {
        showMessageBox: async (options) => {
          shown = options.detail;
          return { response: 1 };
        },
      },
    }
  );
  await handlers.get("mcp-client-confirm")({}, "local", {
    command: "node",
    args: ["server.js"],
    cwd: "/tmp/work",
  });
  assert.equal(confirmed, true);
  assert.match(shown, /server.js/);
  assert.match(shown, /\/tmp\/work/);
});

test("write tool approvals follow normalized arguments; read tools remain sticky", async () => {
  const handlers = new Map();
  const prompts = [];
  let readOnly = false;
  let allowed = false;
  registerMcpIpc(
    {
      config: () => ({ mcpServers: { demo: { type: "http", url: "http://localhost" } } }),
      isEnabled: () => true,
      tools: () => [{ name: "echo", annotations: { readOnlyHint: readOnly } }],
      settings: () => ({ allowWithoutAsking: allowed }),
      call: async () => ({ content: [] }),
    },
    {
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      dialog: {
        showMessageBox: async (options) => {
          prompts.push(options.title);
          return { response: 1 };
        },
      },
    }
  );
  const call = (args, id) =>
    handlers.get("mcp-client-call")({ sender: { id: 1 } }, "demo", "echo", args, id);
  await call({ a: 1, b: 2 }, "one");
  await call({ b: 2, a: 1 }, "two");
  await call({ a: 2, b: 2 }, "three");
  assert.equal(prompts.length, 2);
  readOnly = true;
  await call({ a: 3 }, "four");
  await call({ a: 4 }, "five");
  assert.equal(prompts.length, 3);
  allowed = true;
  await call({ a: 5 }, "six");
  assert.equal(prompts.length, 3);
});
