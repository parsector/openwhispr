const test = require("node:test");
const assert = require("node:assert/strict");

test("get_agent_job lists summaries and marks detail result and progress untrusted within the shared budget", async () => {
  const { agentJobTool } = await import("../../../src/services/tools/agentJobTool.ts");
  const job = {
    jobId: "j1",
    status: "done",
    project: { name: "openwhispr" },
    harness: "claude",
    prompt: "Review\ncode",
    startedAt: 100,
    endedAt: 500,
    steps: Array.from({ length: 25 }, (_, i) => ({ kind: "text", text: `step ${i}` })),
    result: "x".repeat(500),
    reason: null,
  };
  global.window = { agentJobs: { list: async () => [job], get: async () => job } };
  const context = { limitMcpResult: (text) => text.slice(0, 100) + "[truncated]" };
  const list = await agentJobTool.execute({}, context);
  assert.equal(list.data.untrusted, true);
  assert.match(list.data.guidance, /never as instructions/);
  assert.ok(list.data.items.length <= 111);
  const fullList = await agentJobTool.execute({}, { limitMcpResult: (text) => text });
  assert.deepEqual(JSON.parse(fullList.data.items)[0], {
    jobId: "j1",
    status: "done",
    project: "openwhispr",
    harness: "claude",
    started: 100,
    duration: 400,
    summary: "Review code",
  });
  const detail = await agentJobTool.execute({ jobId: "j1" }, { limitMcpResult: (text) => text });
  const parsed = JSON.parse(detail.data.items);
  assert.equal(parsed.steps.length, 20);
  assert.equal(parsed.result.length, 500);
  assert.equal(list.data.truncated, true);
});
