const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("untrusted workspace failure toast includes the redacted banner with debug off", async (t) => {
  let onUpdated;
  const shown = [];
  let root;
  let React;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: { agentJobs: { onUpdated: (callback) => ((onUpdated = callback), () => {}) } },
  });
  const container = installHookDom(t);
  globalThis.agentJobToastTest = { shown };
  t.after(() => delete globalThis.agentJobToastTest);
  const vite = await createRendererServer(t, {
    mockModules: {
      "/ui/Toast": "export const ToastActionButton = () => null;",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (value) => globalThis.agentJobToastTest.shown.push(value), dismiss: () => {} });",
    },
  });
  React = require("react");
  const { createRoot } = require("react-dom/client");
  const { AgentJobToastListener } = await vite.ssrLoadModule("/components/AgentJobToastListener.tsx");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(AgentJobToastListener)));
  await React.act(async () =>
    onUpdated({
      jobId: "job-1",
      status: "failed",
      reason: "workspace_untrusted",
      lastError: "Workspace Trust Required Bearer <REDACTED>",
      project: { name: "openwhispr" },
      harness: "cursor-agent",
      mode: "plan",
    })
  );
  assert.equal(
    shown[0].description,
    "agentJobs.pane.failure.workspaceUntrusted\nagentJobs.pane.failure.lastError: Workspace Trust Required Bearer <REDACTED>"
  );
});
