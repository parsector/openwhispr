const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");
const en = require("../../src/locales/en/translation.json");
const {
  jobStatus,
  queuePosition,
  elapsedTime,
  stallTextKey,
  authStateKey,
  failureMessage,
  failureDescription,
  lastErrorKey,
} = require("../../src/components/integrations/agentJobsPresentation.ts");

test("job status maps to readable label keys and severity, including display-only stall", () => {
  assert.deepEqual(jobStatus("pending", false), { key: "pending", severity: "neutral" });
  assert.deepEqual(jobStatus("queued", false), { key: "queued", severity: "info" });
  assert.deepEqual(jobStatus("running", false), { key: "running", severity: "info" });
  assert.deepEqual(jobStatus("running", true), { key: "stalled", severity: "warning" });
  assert.deepEqual(jobStatus("done", false), { key: "done", severity: "success" });
  assert.deepEqual(jobStatus("failed", false), { key: "failed", severity: "danger" });
  assert.deepEqual(jobStatus("cancelled", false), { key: "cancelled", severity: "neutral" });
  assert.equal(stallTextKey, "agentJobs.pane.stallWarning");
  assert.equal(en.agentJobs.pane.stallWarning, "no output for 20 minutes");
});

test("queue position and elapsed time handle missing and completed jobs", () => {
  assert.equal(queuePosition(null), null);
  assert.equal(queuePosition(0), null);
  assert.equal(queuePosition(3), "3");
  assert.equal(elapsedTime(null, null, 10000), null);
  assert.equal(elapsedTime(1000, null, 66000), "1:05");
  assert.equal(elapsedTime(1000, 3662000, 9000000), "1:01:01");
});

test("auth and failure reasons map known states without hiding CLI errors", () => {
  assert.equal(authStateKey("authenticated"), "agentJobs.pane.auth.authenticated");
  assert.equal(authStateKey("not_authenticated"), "agentJobs.pane.auth.not_authenticated");
  assert.equal(authStateKey("unknown"), "agentJobs.pane.auth.unknown");
  assert.equal(
    authStateKey("not_authenticated", null, "cursor-agent"),
    "agentJobs.pane.auth.cursorNotAuthenticated"
  );
  assert.equal(authStateKey("authenticated", "claude.ai"), "agentJobs.pane.auth.subscription");
  assert.equal(authStateKey("authenticated", "api_key"), "agentJobs.pane.auth.apiKey");
  assert.equal(authStateKey("authenticated", "api_key_helper"), "agentJobs.pane.auth.apiKey");
  assert.equal(authStateKey("authenticated", "oauth_token"), "agentJobs.pane.auth.oauthToken");
  assert.equal(authStateKey("authenticated", "third_party"), "agentJobs.pane.auth.authenticated");
  assert.equal(authStateKey("authenticated", "new_method"), "agentJobs.pane.auth.otherMethod");
  assert.equal(en.agentJobs.pane.auth.subscription, "Signed in · Claude subscription");
  assert.equal(en.agentJobs.pane.auth.not_authenticated, "Not signed in — run `claude auth login`");
  assert.equal(en.agentJobs.pane.auth.unknown, "Couldn't read auth state");
  assert.equal(lastErrorKey, "agentJobs.pane.failure.lastError");
  assert.equal(en.agentJobs.pane.failure.lastError, "CLI message");
  const translate = (key) => key.split(".").reduce((value, part) => value[part], en);
  assert.equal(
    failureDescription("not_authenticated", "CLI says sk-<REDACTED>", translate),
    "Sign in to Claude to run this job.\nCLI message: CLI says sk-<REDACTED>"
  );
  assert.equal(failureDescription("exit_1", null, translate), "exit_1");
  assert.deepEqual(failureMessage("not_authenticated"), {
    key: "agentJobs.pane.failure.notAuthenticated",
  });
  assert.deepEqual(failureMessage("interrupted"), { key: "agentJobs.pane.failure.interrupted" });
  assert.deepEqual(failureMessage("cancelled"), { key: "agentJobs.pane.failure.cancelled" });
  assert.deepEqual(failureMessage("CLI error"), { text: "CLI error" });
});

test("model picker groups aliases and pinned names and warns on a malformed alias", async (t) => {
  const { Window } = await import("happy-dom");
  const dom = new Window();
  const originals = new Map();
  let root;
  let host;
  let React;
  for (const name of [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "Event",
    "MouseEvent",
    "HTMLInputElement",
    "IS_REACT_ACT_ENVIRONMENT",
  ]) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        name === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : name === "window"
            ? dom
            : name === "document"
              ? dom.document
              : dom[name],
    });
  }
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    host?.remove();
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  dom.agentJobs = {
    projectsList: async () => ({
      projects: [
        {
          name: "Existing project",
          folder: "/tmp/existing",
          defaultHarness: "claude",
          mode: "read-only",
          model: "opus-5-5",
        },
      ],
    }),
    list: async () => [],
    onUpdated: () => () => {},
    testHarness: async () => ({
      ok: false,
      path: null,
      version: null,
      error: "not found",
      auth: { state: "unknown", method: null, detail: null },
    }),
  };
  React = require("react");
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t);
  const { AgentsPane } = await vite.ssrLoadModule("/components/integrations/AgentsPane.tsx");
  host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host);
  const act = (fn) =>
    React.act(async () => {
      await fn();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  await act(() => root.render(React.createElement(AgentsPane, { title: "Agents" })));
  assert.equal(
    host.querySelector('[role="alert"]')?.textContent,
    "agentJobs.pane.invalidClaudeModel"
  );
  await act(() => host.querySelector("button").click());
  const groups = [...host.querySelectorAll("optgroup")];
  assert.deepEqual(
    groups.map((group) => group.label),
    ["agentJobs.pane.aliasesRecommended", "agentJobs.pane.fullNamesPinned"]
  );
  assert.ok(groups[0].querySelector('option[value="opus"]'));
  assert.ok(groups[1].querySelector('option[value="claude-opus-5-5"]'));
  const select = host.querySelector("#agent-project-model");
  await act(() => {
    select.value = "__other__";
    select.dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
  const input = host.querySelector('input[aria-label="agentJobs.pane.fullModelName"]');
  assert.ok(input);
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value").set.call(
      input,
      "opus-5-5"
    );
    input.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
  assert.equal(
    host.querySelector("#agent-model-warning")?.textContent,
    "agentJobs.pane.invalidClaudeModel"
  );
  assert.equal(
    en.agentJobs.pane.invalidClaudeModel,
    "Not a Claude model name — try `opus` or `claude-opus-5-5`"
  );
});
