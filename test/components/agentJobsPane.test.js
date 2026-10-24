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
  guaranteeKey,
  cursorTrustKey,
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

test("guarantee labels distinguish Claude enforcement from Cursor best effort", () => {
  assert.equal(guaranteeKey("claude"), "agentJobs.guarantee.enforced");
  assert.equal(guaranteeKey("cursor-agent"), "agentJobs.guarantee.bestEffort");
  assert.equal(guaranteeKey("claude", "write"), "agentJobs.guarantee.write");
  assert.equal(en.agentJobs.guarantee.write, "write (worktree)");
  assert.equal(en.agentJobs.guarantee.enforced, "read-only (enforced)");
  assert.equal(en.agentJobs.guarantee.bestEffort, "read-only (best effort)");
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
  assert.deepEqual(failureMessage("not_authenticated", "cursor-agent"), {
    key: "agentJobs.pane.auth.cursorNotAuthenticated",
  });
  assert.deepEqual(failureMessage("interrupted"), { key: "agentJobs.pane.failure.interrupted" });
  assert.deepEqual(failureMessage("workspace_untrusted", "cursor-agent"), {
    key: "agentJobs.pane.failure.workspaceUntrusted",
  });
  assert.match(
    failureDescription(
      "workspace_untrusted",
      "Workspace Trust Required",
      translate,
      "cursor-agent"
    ),
    /Cursor refused this workspace.*CLI message: Workspace Trust Required/s
  );
  assert.equal(cursorTrustKey(true), "agentJobs.card.workspaceTrusted");
  assert.equal(cursorTrustKey(false), "agentJobs.card.workspaceUntrusted");
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
  let debugEnabled = false;
  dom.electronAPI = {
    getDebugState: async () => ({ enabled: debugEnabled, logPath: null }),
    getNotes: async () => [],
  };
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
        {
          name: "Write project",
          folder: "/tmp/write",
          defaultHarness: "claude",
          mode: "write",
          model: "sonnet",
        },
      ],
    }),
    presetsList: async () => ({
      presets: [
        {
          id: "review",
          name: "Review PR",
          project: "Existing project",
          harness: "claude",
          mode: "read-only",
          model: "sonnet",
          prompt: "Review {{pr}}",
          description: "",
        },
        {
          id: "review-all",
          name: "Review open PRs",
          project: "Existing project",
          harness: "claude",
          mode: "read-only",
          model: "sonnet",
          prompt: "Review {{pr}}",
          description: "",
          fanOut: "open-pull-requests",
        },
      ],
    }),
    list: async () => [
      {
        jobId: "no-session",
        project: { name: "Existing project", folder: "/tmp/existing" },
        harness: "claude",
        mode: "read-only",
        model: "sonnet",
        prompt: "Review",
        status: "done",
        steps: [],
        result: "ok",
        reason: null,
        sessionId: null,
        createdAt: 1,
        startedAt: 1,
        endedAt: 2,
        stalled: false,
        position: null,
        fanOutId: "batch",
        fanOutIndex: 1,
        fanOutTotal: 5,
        fanOutPresetName: "Review open PRs",
      },
    ],
    fanOutEnumerate: async () => ({
      ok: true,
      fanOutId: "batch-new",
      total: 7,
      targets: [1, 2, 3, 4, 5].map((number) => ({ number, title: `PR ${number}` })),
    }),
    fanOutCancel: async () => ({ ok: true }),
    onUpdated: () => () => {},
    testHarness: async () => ({
      path: "/usr/bin/claude",
      version: "v1",
      error: null,
      auth: {
        state: "authenticated",
        method: "claude.ai",
        detail: null,
      },
      debug: {
        test: { argv: ["--version"], exitCode: 0, stdoutSnippet: "v1" },
        auth: {
          argv: ["auth", "status"],
          configDirectory: "/tmp/config",
          subscriptionType: "max",
          textProbe: { stdoutSnippet: "Login method: Claude Max" },
        },
      },
    }),
    listModels: async () => ({ ok: true, models: ["auto", "gpt-5"] }),
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
  assert.equal(host.querySelector('input[type="checkbox"]'), null);
  assert.equal(
    host.querySelector('[role="alert"]')?.textContent,
    "agentJobs.pane.invalidClaudeModel"
  );
  await act(() => host.querySelector("button").click());
  assert.equal(host.querySelector("details summary"), null);
  assert.equal(host.textContent.includes("agentJobs.pane.copyDetails"), false);
  assert.ok(host.textContent.includes("/usr/bin/claude · v1"));
  assert.ok(host.textContent.includes("agentJobs.pane.auth.subscription"));
  const terminalButton = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "agentJobs.pane.openTerminal"
  );
  assert.ok(terminalButton);
  assert.equal(terminalButton.disabled, true);
  assert.equal(terminalButton.title, "agentJobs.pane.noSession");
  assert.equal(host.textContent.includes("/tmp/config"), false);
  debugEnabled = true;
  await act(() => host.querySelector("button").click());
  assert.ok(host.querySelector("details summary")?.textContent.includes("agentJobs.pane.details"));
  assert.ok(host.textContent.includes("agentJobs.pane.auth.claudeMax"));
  assert.ok(host.querySelector("details pre")?.textContent.includes("Login method: Claude Max"));
  assert.ok(
    [...host.querySelectorAll("button")].some(
      (button) => button.textContent === "agentJobs.pane.copyDetails"
    )
  );
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
  const harness =
    host.querySelector('select[value="claude"]') ||
    [...host.querySelectorAll("select")].find((item) =>
      item.querySelector('option[value="cursor-agent"]')
    );
  const claudeMode = [...host.querySelectorAll("select")].find((item) =>
    item.querySelector('option[value="read-only"]')
  );
  assert.equal(claudeMode.disabled, false);
  assert.deepEqual(
    [...claudeMode.options].map((option) => option.value),
    ["read-only", "write"]
  );
  await act(() => {
    harness.value = "cursor-agent";
    harness.dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
  const mode = [...host.querySelectorAll("select")].find((item) =>
    item.querySelector('option[value="plan"]')
  );
  assert.deepEqual(
    [...mode.options].map((option) => option.value),
    ["plan", "ask"]
  );
  assert.equal(mode.disabled, false);
  assert.equal(mode.value, "plan");
  assert.ok(host.querySelector('option[value="gpt-5"]'));
  const trustToggle = host.querySelector('input[type="checkbox"]');
  assert.ok(trustToggle);
  assert.ok(host.textContent.includes("agentJobs.pane.trustWorkspaceDescription"));
  await act(() => trustToggle.click());
  assert.equal(host.querySelector('input[type="checkbox"]').checked, true);
  dom.agentJobs.testHarness = async () => ({
    ok: true,
    path: "/usr/bin/cursor-agent",
    version: "1",
    error: null,
    argv: ["--version"],
    exitCode: 0,
    stdoutSnippet: "1",
    stderrSnippet: "",
    authMethod: null,
    configDirectory: null,
    durationMs: 1,
    auth: { state: "unknown", method: null, detail: null },
  });
  dom.agentJobs.listModels = async () => ({ ok: false, reason: "workspace_untrusted" });
  await act(() =>
    [...host.querySelectorAll("button")]
      .filter((button) => button.textContent === "agentJobs.pane.testHarness")
      .at(-1)
      .click()
  );
  assert.ok(host.textContent.includes("agentJobs.pane.cursorWorkspaceUntrusted"));
  assert.equal(host.querySelector('option[value="gpt-5"]'), null);
  const reviewRow = [...host.querySelectorAll("h3")]
    .find((item) => item.textContent === "Review PR")
    ?.closest("div.flex.flex-wrap");
  assert.ok(reviewRow);
  await act(() =>
    [...reviewRow.querySelectorAll("button")]
      .find((item) => item.textContent === "agentJobs.presets.run")
      .click()
  );
  const placeholder = host.querySelector('input[aria-label="pr"]');
  assert.ok(placeholder);
  assert.equal(placeholder.closest("label").textContent, "pr");
  assert.ok(host.textContent.includes("agentJobs.presets.missingValue"));
  const runButton = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === "agentJobs.presets.run" && item.disabled
  );
  assert.ok(runButton);
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value").set.call(
      placeholder,
      "42"
    );
    placeholder.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
  assert.ok([...host.querySelectorAll("textarea")].some((item) => item.value === "Review 42"));
  assert.ok(host.textContent.includes("Review open PRs · agentJobs.presets.groupCount"));
  const fanOutRow = [...host.querySelectorAll("h3")]
    .find((item) => item.textContent === "Review open PRs")
    ?.closest("div.flex.flex-wrap");
  assert.ok(fanOutRow.textContent.includes("agentJobs.presets.openPullRequests"));
  await act(() =>
    [...fanOutRow.querySelectorAll("button")]
      .find((item) => item.textContent === "agentJobs.presets.run")
      .click()
  );
  assert.equal(host.querySelector('input[aria-label="pr"]'), null);
  await act(() =>
    [...host.querySelectorAll("button")]
      .filter((item) => item.textContent === "agentJobs.presets.run" && !item.disabled)
      .at(-1)
      .click()
  );
  assert.ok(host.textContent.includes("agentJobs.presets.showingFive"));
  assert.ok(host.textContent.includes("#1 — PR 1"));
  assert.ok(host.textContent.includes("#5 — PR 5"));
  assert.equal(host.textContent.includes("#6 —"), false);
  await act(() =>
    [...host.querySelectorAll("button")]
      .find((item) => item.textContent === "agentJobs.presets.add")
      .click()
  );
  assert.equal(
    [...host.querySelectorAll("button")].filter(
      (item) => item.textContent === "agentJobs.presets.designDoc"
    ).length,
    0
  );
  const presetProject = [...host.querySelectorAll("select")].find((item) =>
    item.querySelector('option[value="Write project"]')
  );
  await act(() => {
    presetProject.value = "Write project";
    presetProject.dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
  assert.ok(
    [...host.querySelectorAll("button")].some(
      (item) => item.textContent === "agentJobs.presets.designDoc"
    )
  );
  assert.equal(
    [...host.querySelectorAll("button")].some(
      (item) => item.textContent === "agentJobs.presets.reviewPr"
    ),
    false
  );
  dom.electronAPI.noteFilesPickFolder = async () => ({ path: "/tmp" });
  dom.agentJobs.projectsSave = async () => {
    throw new Error("Invalid model");
  };
  await act(() =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "agentJobs.pane.browse")
      .click()
  );
  const nameInput = host.querySelector('input[maxlength="80"]');
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value").set.call(
      nameInput,
      "New project"
    );
    nameInput.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
  await act(() =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "agentJobs.pane.save" && !button.disabled)
      .click()
  );
  assert.ok(
    [...host.querySelectorAll('[role="alert"]')].some((item) =>
      item.textContent.includes("Invalid model")
    )
  );
  assert.ok(host.textContent.includes("agentJobs.pane.actionError"));
  dom.agentJobs.testHarness = async () => {
    throw new Error("probe IPC failed");
  };
  await act(() =>
    [...host.querySelectorAll("button")]
      .filter((button) => button.textContent === "agentJobs.pane.testHarness")
      .at(-1)
      .click()
  );
  assert.ok(host.textContent.includes("agentJobs.pane.actionError: probe IPC failed"));
  const { LocalApprovalCard } = await vite.ssrLoadModule("/components/chat/LocalApprovalCard.tsx");
  const approval = {
    key: "approval",
    jobId: "job",
    harness: "cursor-agent",
    mode: "plan",
    summary: "Review",
    prompt: "Review",
    state: "pending",
    messageId: "message",
    toolCallId: "call",
  };
  await act(() => root.render(React.createElement(LocalApprovalCard, { entry: approval })));
  assert.ok(host.textContent.includes("agentJobs.card.workspaceUntrusted"));
  assert.equal(host.querySelector("select"), null);
  await act(() =>
    root.render(
      React.createElement(LocalApprovalCard, {
        entry: { ...approval, contextNoteId: 42, contextNoteTitle: "Meeting", contextChars: 87 },
      })
    )
  );
  assert.ok(host.textContent.includes("agentJobs.card.context"));
  assert.ok(host.textContent.includes("agentJobs.card.contextPrivacy"));
  assert.equal(host.querySelector("select"), null);
  await act(() =>
    root.render(
      React.createElement(LocalApprovalCard, {
        entry: { ...approval, trustWorkspace: true },
      })
    )
  );
  assert.ok(host.textContent.includes("agentJobs.card.workspaceTrusted"));
});
