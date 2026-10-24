const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  jobMessageId,
  jobDeliveryText,
  deliverJobMessage,
} = require("../../../src/services/agents/jobDelivery.ts");

const job = {
  jobId: "123e4567-e89b-12d3-a456-426614174000",
  status: "done",
  result: "Harness answer\nexactly",
  project: { name: "openwhispr" },
  noteId: 42,
  startedAt: 1000,
  endedAt: 4500,
  branch: "agent/work",
  harness: "claude",
  origin: { conversationId: "7", messageId: "m1", toolCallId: "t1", surface: "chat" },
};

test("done delivery preserves answer, caps long text, and includes note, duration, and branch", () => {
  assert.equal(jobMessageId(job.jobId), `job-${job.jobId}`);
  assert.equal(
    jobDeliveryText(job, (key) => key),
    "Harness answer\nexactly\n\nNote: Agent job: openwhispr (id 42) · Duration: 4s · Branch: agent/work"
  );
  const long = jobDeliveryText({ ...job, result: "x".repeat(7000) }, (key) => key);
  const [answer] = long.split("\n\nNote:");
  assert.equal(answer.length, 6000);
  assert.ok(answer.endsWith("… [truncated — full result in the note]"));
});

test("failed delivery is reason and redacted lastError without note footer", () => {
  const result = jobDeliveryText(
    { ...job, status: "failed", reason: "workspace_untrusted", lastError: "Bearer <REDACTED>" },
    (key) => key
  );
  assert.match(result, /workspaceUntrusted/);
  assert.match(result, /Bearer <REDACTED>/);
  assert.doesNotMatch(result, /Note:|Branch:/);
});

test("missing conversation and cancelled job deliver nothing", async () => {
  const calls = [];
  const append = async (...args) => {
    calls.push(args);
    return null;
  };
  assert.equal(await deliverJobMessage(job, (key) => key, append), false);
  assert.equal(calls[0][0], 7);
  assert.equal(calls[0][3].messageId, `job-${job.jobId}`);
  assert.equal(
    await deliverJobMessage({ ...job, status: "cancelled" }, (key) => key, append),
    false
  );
  assert.equal(await deliverJobMessage({ ...job, origin: undefined }, (key) => key, append), false);
  assert.equal(calls.length, 1);
});
