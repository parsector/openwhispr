const test = require("node:test");
const assert = require("node:assert/strict");

const preset = {
  id: "p1",
  name: "Review PR",
  project: "repo",
  harness: "claude",
  model: "sonnet",
  mode: "read-only",
  prompt: "Review {{pr}}",
  description: "",
};
function context() {
  let count = 0;
  const events = [];
  return {
    messageId: "preset-message",
    toolCallId: "call",
    signal: new AbortController().signal,
    onApprovalRequested: () => events.push("approval"),
    onHoldDelivery: () => events.push("hold"),
    claimTurnSlot: (key, limit) => {
      assert.equal(key, "agent_job");
      return ++count <= limit;
    },
    releaseTurnSlot: () => count--,
    events,
  };
}

test("run_preset rejects unknown names, expands values, and creates a local approval card", async () => {
  const { createRunPresetTool } = await import("../../../src/services/tools/runPresetTool.ts");
  const { useLocalApprovalStore } = await import("../../../src/stores/localApprovalStore.ts");
  let input;
  global.window = {
    agentJobs: {
      prepare: async (value) => {
        input = value;
        return {
          jobId: "job-1",
          project: { name: "repo" },
          harness: "claude",
          model: "sonnet",
          mode: "read-only",
          prompt: value.task,
        };
      },
    },
  };
  const tool = createRunPresetTool([preset]);
  const ctx = context();
  assert.equal((await tool.execute({ preset: "unknown" }, ctx)).success, false);
  assert.equal((await tool.execute({ preset: preset.name, values: {} }, ctx)).success, false);
  const result = await tool.execute({ preset: preset.name, values: { pr: "42" } }, ctx);
  assert.deepEqual(input, {
    project: "repo",
    task: "Review 42",
    harness: "claude",
    mode: "read-only",
    model: "sonnet",
  });
  assert.deepEqual(result.data.status, "awaiting_approval");
  assert.equal(result.data.jobId, "job-1");
  assert.equal(
    useLocalApprovalStore.getState().entries["preset-message::call"].prompt,
    "Review 42"
  );
  assert.deepEqual(ctx.events, ["approval", "hold"]);
});

test("run_preset shares the two-slot cap and obeys policy registration", async () => {
  const { createRunPresetTool } = await import("../../../src/services/tools/runPresetTool.ts");
  const { createDelegateTaskTool } =
    await import("../../../src/services/tools/delegateTaskTool.ts");
  const { createToolRegistry } = await import("../../../src/services/tools/index.ts");
  let prepared = 0;
  global.window = {
    agentJobs: {
      prepare: async (value) => ({
        jobId: String(++prepared),
        project: { name: "repo" },
        harness: "claude",
        model: null,
        mode: "read-only",
        prompt: value.task,
      }),
    },
  };
  const ctx = context();
  const tool = createRunPresetTool([preset]);
  await tool.execute({ preset: preset.name, values: { pr: "1" } }, ctx);
  await tool.execute({ preset: preset.name, values: { pr: "2" } }, { ...ctx, toolCallId: "call2" });
  assert.equal(
    (await tool.execute({ preset: preset.name, values: { pr: "3" } }, ctx)).success,
    false
  );
  assert.equal(prepared, 2);
  const mixed = context();
  const delegate = createDelegateTaskTool([
    { name: "repo", defaultHarness: "claude", model: "sonnet" },
  ]);
  await delegate.execute(
    { project: "repo", task: "Inspect" },
    { ...mixed, toolCallId: "delegate" }
  );
  await tool.execute(
    { preset: preset.name, values: { pr: "4" } },
    { ...mixed, toolCallId: "preset" }
  );
  assert.equal(
    (await delegate.execute({ project: "repo", task: "Inspect again" }, mixed)).success,
    false
  );
  assert.equal(prepared, 4);
  const settings = {
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
    agentProjects: [{ name: "repo", defaultHarness: "claude", model: "sonnet" }],
    agentPresets: [preset],
  };
  assert.equal(
    createToolRegistry({ ...settings, agentAllowed: false }).get("run_preset"),
    undefined
  );
  assert.equal(
    createToolRegistry({ ...settings, agentAllowed: true, agentPresets: [] }).get("run_preset"),
    undefined
  );
  assert.ok(createToolRegistry({ ...settings, agentAllowed: true }).get("run_preset"));
});
