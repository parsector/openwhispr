const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("delivery listener reconciles a finished job after mounting", async (t) => {
  let root;
  let React;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const saved = [];
  const job = {
    jobId: "123e4567-e89b-12d3-a456-426614174000",
    status: "done",
    result: "Answer",
    project: { name: "openwhispr" },
    noteId: 42,
    startedAt: 1000,
    endedAt: 2000,
    harness: "claude",
    origin: { conversationId: "7", messageId: "m1", toolCallId: "t1", surface: "assistant" },
  };
  installBrowserGlobals(t, {
    window: {
      agentJobs: { onUpdated: () => () => {}, list: async () => [job] },
      electronAPI: {
        addAgentMessage: async (...args) => {
          saved.push(args);
          return { id: 1 };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t);
  React = require("react");
  const { createRoot } = require("react-dom/client");
  const { AgentJobDeliveryListener } = await vite.ssrLoadModule(
    "/components/AgentJobDeliveryListener.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(AgentJobDeliveryListener)));
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0], 7);
  assert.equal(saved[0][3].messageId, `job-${job.jobId}`);
});
