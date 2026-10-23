const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  capResult,
  mcpCacheKey,
  loadMcpTools,
  TOOL_NAME,
} = require("../../../../src/services/tools/mcpTools.ts");
const {
  mcpResultBudgetChars,
  resolveMcpResultBudget,
} = require("../../../../src/services/tools/mcpResultBudget.ts");

test("model context maps to bounded result characters", () => {
  assert.deepEqual(
    [4_000, 16_000, 128_000, 1_000_000].map(mcpResultBudgetChars),
    [8_000, 8_000, 25_600, 200_000]
  );
  assert.equal(mcpResultBudgetChars(1_000), 8_000);
  assert.equal(mcpResultBudgetChars(2_000_000), 256_000);
});

test("cloud defaults do not request local context", async () => {
  const noLocalLookup = async () => {
    throw Error("unexpected local lookup");
  };
  assert.equal(await resolveMcpResultBudget("gemini", "cloud", false, noLocalLookup), 200_000);
  assert.equal(await resolveMcpResultBudget("unknown", "cloud", false, noLocalLookup), 8_000);
});

test("failed local lookup falls back and warns once", async () => {
  const warnings = [];
  const log = (message) => warnings.push(message);
  assert.equal(
    await resolveMcpResultBudget("llama", "missing", true, async () => ({ success: false }), log),
    8_000
  );
  assert.equal(
    await resolveMcpResultBudget(
      "llama",
      "missing",
      true,
      async () => {
        throw Error("offline");
      },
      log
    ),
    8_000
  );
  assert.equal(warnings.length, 1);
  assert.equal(
    await resolveMcpResultBudget(
      "llama",
      "present",
      true,
      async () => ({ success: true, maxContextTokens: 128_000 }),
      log
    ),
    25_600
  );
  assert.equal(warnings.length, 1);
});

test("JSON text keeps whole items and reports counts", () => {
  const items = Array.from({ length: 20 }, (_, id) => ({ id, value: "x".repeat(500) }));
  const result = JSON.parse(capResult([{ type: "text", text: JSON.stringify(items) }], 2_000));
  const trimmed = JSON.parse(result[0].text);
  const marker = trimmed.at(-1);
  assert.deepEqual(marker, { truncated: true, returned: trimmed.length - 1, total: 20 });
  assert.ok(marker.returned > 0 && marker.returned < 20);
  assert.deepEqual(trimmed.slice(0, -1), items.slice(0, marker.returned));
  assert.ok(JSON.stringify(result).length <= 2_000);
  const object = JSON.parse(
    capResult(JSON.stringify(Object.fromEntries(items.map((item) => [item.id, item]))), 2_000)
  );
  assert.equal(object.truncated, true);
  assert.equal(object.total, 20);
  assert.equal(object.returned, Object.keys(object).length - 3);
  const nested = JSON.parse(capResult(JSON.stringify({ jobs: items, page: 1 }), 2_000));
  assert.deepEqual(nested.jobs.slice(0, -1), items.slice(0, nested.jobs.at(-1).returned));
  assert.equal(nested.jobs.at(-1).total, 20);
  assert.equal(nested.truncated, true);
});

test("non-JSON text marks omissions and shares budget across parts", () => {
  const result = JSON.parse(
    capResult(
      [
        { type: "text", text: "first" },
        { type: "text", text: "a".repeat(9_000) },
      ],
      8_000
    )
  );
  assert.equal(result[0].text, "first");
  assert.match(result[1].text, /\[truncated: \d+ of 9000 characters\]/);
  assert.ok(JSON.stringify(result).length <= 8_000);
  const omitted = JSON.parse(
    capResult(
      [
        { type: "text", text: "a".repeat(9_000) },
        { type: "text", text: "later" },
      ],
      8_000
    )
  );
  assert.match(omitted[1].text, /1 content parts omitted/);
  assert.ok(JSON.stringify(omitted).length <= 8_000);
});

test("override is respected and clamped by model budget; cache tracks budget", async () => {
  const a = { name: "a", enabled: true, status: "connected", maxResultChars: 8_000 };
  assert.notEqual(mcpCacheKey([a], 1, 8_000), mcpCacheKey([a], 1, 32_000));
  assert.notEqual(mcpCacheKey([a], 1, 8_000), mcpCacheKey([{ ...a, enabled: false }], 1, 8_000));
  const api = {
    list: async () => ({ revision: 1, servers: [a] }),
    tools: async () => [{ name: "echo", inputSchema: { type: "object" } }],
    call: async () => ({ content: [{ type: "text", text: "a".repeat(40_000) }] }),
    cancel: async () => {},
  };
  const small = await loadMcpTools(api, 32_000);
  assert.equal(small.tools[0].name, "a__echo");
  assert.ok((await small.tools[0].execute({})).displayText.length <= 8_000);
  a.maxResultChars = 256_000;
  const clamped = await loadMcpTools(api, 32_000);
  assert.ok((await clamped.tools[0].execute({})).displayText.length <= 32_000);
  assert.equal(TOOL_NAME.test("server__tool"), true);
  assert.equal(TOOL_NAME.test("server.tool"), false);
});
