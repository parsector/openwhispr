const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  capResult,
  mcpCacheKey,
  loadMcpTools,
  TOOL_NAME,
} = require("../../../../src/services/tools/mcpTools.ts");
test("result cap has visible marker and names are bounded", () => {
  assert.match(capResult("a".repeat(8001)), /\[truncated:/);
  assert.equal(capResult("a".repeat(8001)).length, 8000);
  assert.equal(TOOL_NAME.test("server__tool"), true);
  assert.equal(TOOL_NAME.test("server.tool"), false);
});
test("registry cache key changes with server set and adapter calls IPC", async () => {
  const a = { name: "a", enabled: true, status: "connected" };
  assert.notEqual(mcpCacheKey([a], 1), mcpCacheKey([{ ...a, enabled: false }], 1));
  assert.notEqual(mcpCacheKey([a], 1), mcpCacheKey([{ ...a, name: "b" }], 1));
  const api = {
    list: async () => ({ revision: 1, servers: [a] }),
    tools: async () => [{ name: "echo", inputSchema: { type: "object" } }],
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    cancel: async () => {},
  };
  const result = await loadMcpTools(api);
  assert.equal(result.tools[0].name, "a__echo");
  assert.match((await result.tools[0].execute({})).displayText, /ok/);
});
