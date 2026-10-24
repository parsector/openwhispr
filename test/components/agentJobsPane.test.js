const test = require("node:test");
const assert = require("node:assert/strict");
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
