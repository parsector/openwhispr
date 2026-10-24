const test = require("node:test");
const assert = require("node:assert/strict");

const project = { name: "openwhispr", defaultHarness: "claude", model: "sonnet" };
function context() {
  let slots = 0;
  const events = [];
  return {
    messageId: "m1",
    toolCallId: "t1",
    signal: new AbortController().signal,
    onApprovalRequested: () => events.push("approval"),
    onHoldDelivery: () => events.push("hold"),
    claimTurnSlot: (_key, limit) => ++slots <= limit,
    releaseTurnSlot: () => slots--,
    events,
  };
}
test("delegate_task rejects unknown project, prepares a card immediately, and caps the turn", async () => {
  const { createDelegateTaskTool } =
    await import("../../../src/services/tools/delegateTaskTool.ts");
  const { useLocalApprovalStore } = await import("../../../src/stores/localApprovalStore.ts");
  const tool = createDelegateTaskTool([project]);
  const ctx = context();
  ctx.origin = { conversationId: "7", messageId: "m1", toolCallId: "t1", surface: "chat" };
  let prepared = 0;
  let preparedInput;
  global.window = {
    agentJobs: {
      prepare: async (input) => {
        preparedInput = input;
        prepared++;
        return {
          jobId: String(prepared),
          project: { name: project.name },
          harness: "claude",
          model: "sonnet",
          prompt: "Review code",
        };
      },
    },
  };
  assert.equal(
    (await tool.execute({ project: "unknown", task: "Review code" }, ctx)).success,
    false
  );
  assert.equal(prepared, 0);
  const first = await tool.execute({ project: project.name, task: "Review code" }, ctx);
  assert.deepEqual(first.data.status, "awaiting_approval");
  assert.equal(first.data.jobId, "1");
  assert.deepEqual(preparedInput.origin, ctx.origin);
  assert.deepEqual(ctx.events, ["approval", "hold"]);
  await tool.execute({ project: project.name, task: "Review code", noteId: 42 }, { ...ctx, toolCallId: "t2" });
  assert.equal(preparedInput.contextNoteId, 42);
  assert.ok(useLocalApprovalStore.getState().entries["m1::t1"]);
  const third = await tool.execute(
    { project: project.name, task: "Review code" },
    { ...ctx, toolCallId: "t3" }
  );
  assert.equal(third.success, false);
  assert.match(third.displayText, /two/i);
  assert.equal(prepared, 2);
});
test("not_authenticated reaches the model and tools obey project and policy gates", async () => {
  const { createDelegateTaskTool } =
    await import("../../../src/services/tools/delegateTaskTool.ts");
  const { createToolRegistry } = await import("../../../src/services/tools/index.ts");
  global.window = {
    agentJobs: {
      prepare: async () => {
        throw new Error("not_authenticated");
      },
    },
  };
  const failed = await createDelegateTaskTool([project]).execute(
    { project: project.name, task: "Review" },
    context()
  );
  assert.match(failed.displayText, /not_authenticated/);
  const settings = {
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
  };
  assert.equal(
    createToolRegistry({ ...settings, agentAllowed: true, agentProjects: [] }).get("delegate_task"),
    undefined
  );
  assert.equal(
    createToolRegistry({ ...settings, agentAllowed: false, agentProjects: [project] }).get(
      "delegate_task"
    ),
    undefined
  );
  assert.ok(
    createToolRegistry({ ...settings, agentAllowed: true, agentProjects: [project] }).get(
      "delegate_task"
    )
  );
});

test("local approval sends edited prompt and clears the pending entry", async () => {
  const { addLocalApproval, approveLocal, useLocalApprovalStore } =
    await import("../../../src/stores/localApprovalStore.ts");
  const ctx = { ...context(), messageId: "approval", toolCallId: "call" };
  let sent;
  global.window = {
    agentJobs: {
      approve: async (_id, input) => {
        sent = input.prompt;
        return { status: "running", reason: null };
      },
    },
  };
  addLocalApproval(ctx, { jobId: "job", prompt: "Edited task" }, "summary");
  await approveLocal("approval::call");
  assert.equal(sent, "Edited task");
  assert.equal(useLocalApprovalStore.getState().entries["approval::call"], undefined);
  assert.equal(useLocalApprovalStore.getState().receipts["approval::call"].state, "started");
});

test("resume_agent_job rejects unknown jobs, creates an approval, and shares delegate cap", async () => {
  const { createToolRegistry } = await import("../../../src/services/tools/index.ts");
  const { useLocalApprovalStore } = await import("../../../src/stores/localApprovalStore.ts");
  const registry = createToolRegistry({
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
    agentAllowed: true,
    agentProjects: [project],
  });
  const resume = registry.get("resume_agent_job");
  const delegate = registry.get("delegate_task");
  const ctx = context();
  let prepared = 0;
  global.window = {
    agentJobs: {
      get: async (id) => (id === "parent" ? { jobId: "parent" } : null),
      prepare: async () => ({
        jobId: String(++prepared),
        project: { name: project.name },
        harness: "claude",
        model: "sonnet",
        prompt: "Continue",
      }),
    },
  };
  assert.equal((await resume.execute({ jobId: "missing", task: "Continue" }, ctx)).success, false);
  const first = await resume.execute({ jobId: "parent", task: "Continue" }, ctx);
  assert.equal(first.data.jobId, "1");
  assert.ok(useLocalApprovalStore.getState().entries["m1::t1"]);
  assert.deepEqual(ctx.events, ["approval", "hold"]);
  await delegate.execute({ project: project.name, task: "Review" }, { ...ctx, toolCallId: "t2" });
  const third = await resume.execute(
    { jobId: "parent", task: "Continue" },
    { ...ctx, toolCallId: "t3" }
  );
  assert.equal(third.success, false);
  assert.match(third.displayText, /two/i);
  assert.equal(prepared, 2);
});
