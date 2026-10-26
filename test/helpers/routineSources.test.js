const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRoutineMcpTools } = require("../../src/services/tools/mcpTools.ts");
const { routineEndpointSupportsTools } = require("../../src/utils/modelCapability.ts");
const { RoutineRunner } = require("../../src/helpers/routines/routineRunner");
const { routineCustomEndpoint } = require("../../src/helpers/routines/routineCustomEndpoint");
const { routineMcpApi } = require("../../src/helpers/routines/routineMcpApi");

function mcpApi() {
  const state = {
    servers: [
      { name: "github", enabled: true, status: "connected", allowWithoutAsking: false },
      { name: "slack", enabled: true, status: "connected", allowWithoutAsking: true },
    ],
  };
  const definitions = {
    github: [
      { name: "read", annotations: { readOnlyHint: true } },
      { name: "write", annotations: { readOnlyHint: false } },
      { name: "read__issue", annotations: { readOnlyHint: true } },
    ],
    slack: [{ name: "mentions", annotations: { readOnlyHint: false } }],
  };
  const calls = [];
  return {
    state,
    definitions,
    calls,
    list: async () => state,
    tools: async (name) => definitions[name] || [],
    call: async (name, tool) => {
      calls.push(`${name}__${tool}`);
      return { content: [{ type: "text", text: "source result" }], isError: name === "github" };
    },
    cancel: async () => {},
  };
}

test("routine MCP qualification and permission re-check never call a revoked tool", async () => {
  const api = mcpApi();
  const failed = [];
  const tools = await loadRoutineMcpTools(api, 12000, (name, reason) =>
    failed.push([name, reason])
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["github__read", "github__read__issue", "slack__mentions"]
  );
  api.definitions.github[0].annotations.readOnlyHint = false;
  const revoked = await tools[0].execute({});
  assert.equal(revoked.success, false);
  assert.deepEqual(api.calls, []);
  assert.deepEqual(failed, [["github__read", "needs approval"]]);
  assert.equal((await tools[2].execute({})).success, true);
  await tools[1].execute({});
  assert.deepEqual(api.calls, ["slack__mentions", "github__read__issue"]);
});

test("the main MCP adapter enforces permission again immediately before calling", async () => {
  let allowed = false;
  let called = 0;
  const api = routineMcpApi({
    list: () => ({
      servers: [
        { name: "server", enabled: true, status: "connected", allowWithoutAsking: allowed },
      ],
    }),
    tools: () => [{ name: "write", annotations: { readOnlyHint: false } }],
    call: async () => {
      called++;
      return { content: [] };
    },
  });
  await assert.rejects(api.call("server", "write", {}, "first"), /needs approval/);
  assert.equal(called, 0);
  allowed = true;
  await api.call("server", "write", {}, "second");
  assert.equal(called, 1);
});

test("cloud reasoning endpoint cannot attach tools even for a large model", () => {
  assert.equal(
    routineEndpointSupportsTools({
      mode: "openwhispr",
      provider: "openwhispr",
      model: "gpt-oss:120b-cloud",
    }),
    false
  );
  assert.equal(
    routineEndpointSupportsTools({ mode: "local", provider: "local", model: "gemma3:3b" }),
    false
  );
  assert.equal(
    routineEndpointSupportsTools({ mode: "providers", provider: "openai", model: "gpt-4o" }),
    true
  );
});

test("a tool-only source is recorded unavailable on the cloud reasoning endpoint", async () => {
  const routine = {
    id: "cloud",
    name: "Brief",
    prompt: "Write a brief",
    space_id: 1,
    allowed_tools: ["github__read"],
    model_override: null,
  };
  const database = fakeDatabase(routine);
  const runner = new RoutineRunner({
    database,
    infer: async ({ toolsAvailable }) => {
      assert.equal(toolsAvailable, false);
      return { text: "Calendar brief", toolsAvailable: false };
    },
  });
  const result = await runner.run({
    id: "cloud-run",
    routineId: routine.id,
    model: { mode: "openwhispr", provider: "openwhispr", model: "gpt-oss:120b-cloud" },
  });
  assert.equal(result.status, "partial");
  assert.match(
    JSON.parse(database.updates.at(-1).source_status).github__read,
    /needs a tool-capable model/
  );
});

function fakeDatabase(routine) {
  const updates = [];
  const notes = [];
  return {
    updates,
    notes,
    getRoutine: () => routine,
    updateRoutineRun: (_id, update) => updates.push(update),
    _accountScopeCondition: () => ({ sql: "1=1", params: [] }),
    db: {
      prepare: (_sql) => ({
        all: () => [],
        get: () => undefined,
        run: () => {},
      }),
    },
    getCalendarEventsInRange: () => [],
    getFolders: () => [{ id: 1, routine_id: routine.id }],
    saveNote: (title, content) => {
      const note = { id: notes.length + 1, title, content };
      notes.push(note);
      return { note };
    },
  };
}

test("one failing MCP source makes only that source unavailable and the run partial", async () => {
  const api = mcpApi();
  const routine = {
    id: "r1",
    name: "Brief",
    prompt: "Write a brief",
    space_id: 1,
    allowed_tools: ["github__read", "slack__mentions"],
    model_override: null,
  };
  const database = fakeDatabase(routine);
  const runner = new RoutineRunner({
    database,
    mcpApi: api,
    infer: async ({ registry, context }) => {
      assert.deepEqual(
        registry
          .list()
          .map((tool) => tool.name)
          .sort(),
        ["finish_run", "github__read", "slack__mentions"]
      );
      await registry.get("github__read").execute({}, context);
      await registry.get("slack__mentions").execute({}, context);
      await registry.get("finish_run").execute({ empty: false, headline: "Ready" }, context);
      return { text: "Useful brief", toolsAvailable: true };
    },
  });
  const result = await runner.run({
    id: "run1",
    routineId: routine.id,
    model: { mode: "providers", provider: "openai", model: "gpt-4o" },
  });
  assert.equal(result.status, "partial");
  const status = JSON.parse(database.updates.at(-1).source_status);
  assert.match(status.github__read, /^unavailable:/);
  assert.equal(status.slack__mentions, undefined);
});

test("unusable override falls back and records the chosen model", async () => {
  const routine = {
    id: "r2",
    name: "Brief",
    prompt: "Write a brief",
    space_id: 1,
    allowed_tools: [],
    model_override: { mode: "providers", provider: "openai", model: "missing", remoteUrl: "" },
  };
  const database = fakeDatabase(routine);
  const fallback = { mode: "local", provider: "local", model: "test-4b" };
  const runner = new RoutineRunner({
    database,
    modelUsable: async () => false,
    infer: async ({ model, registry, context }) => {
      assert.deepEqual(model, fallback);
      await registry.get("finish_run").execute({ empty: false, headline: "Ready" }, context);
      return { text: "Useful brief", toolsAvailable: true };
    },
  });
  const result = await runner.run({ id: "run2", routineId: routine.id, model: fallback });
  assert.equal(result.status, "done");
  assert.match(database.notes[0].content, /model override unavailable, used test-4b/);
});

test("custom endpoint routine runs use the synced model and record a usable pinned override", async () => {
  for (const base of [
    {
      mode: "self-hosted",
      provider: "custom",
      model: "chat-model",
      remoteUrl: "https://models.example/v1",
    },
    {
      mode: "providers",
      provider: "custom",
      model: "chat-model",
      remoteUrl: "",
      cloudBaseUrl: "https://models.example/v1",
    },
  ]) {
    assert.deepEqual(routineCustomEndpoint(base), {
      baseUrl: "https://models.example/v1",
      completionsUrl: "https://models.example/v1/chat/completions",
    });
    const pinned = { ...base, model: "pinned-model" };
    for (const modelOverride of [null, pinned]) {
      const routine = {
        id: "custom-routine",
        name: "Brief",
        prompt: "Write a brief",
        space_id: 1,
        allowed_tools: [],
        model_override: modelOverride,
      };
      const database = fakeDatabase(routine);
      const runner = new RoutineRunner({
        database,
        modelUsable: async () => true,
        infer: async ({ model, registry, context }) => {
          assert.equal(model.model, modelOverride ? "pinned-model" : "chat-model");
          assert.equal(model.cloudBaseUrl || model.remoteUrl, "https://models.example/v1");
          await registry.get("finish_run").execute({ empty: false, headline: "Ready" }, context);
          return { text: "Useful brief", toolsAvailable: true };
        },
      });
      const result = await runner.run({ id: "custom-run", routineId: routine.id, model: base });
      assert.equal(result.status, "done");
      const status = JSON.parse(database.updates.at(-1).source_status);
      assert.deepEqual(
        status.model_override,
        modelOverride ? { mode: base.mode, provider: "custom", model: "pinned-model" } : undefined
      );
    }
  }
  assert.deepEqual(
    routineCustomEndpoint({
      mode: "providers",
      provider: "custom",
      cloudBaseUrl: "https://models.example/api/v1?compat=chat",
    }),
    {
      baseUrl: "https://models.example/api/v1?compat=chat",
      completionsUrl: "https://models.example/api/v1/chat/completions?compat=chat",
    }
  );
});
