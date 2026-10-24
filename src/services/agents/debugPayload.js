const debugLogger = require("../../helpers/debugLogger");

// Raw CLI output, argv, exit codes and paths outside the project may only reach the renderer behind debug mode.
const evidenceKeys = [
  "path",
  "argv",
  "exitCode",
  "stdoutSnippet",
  "stderrSnippet",
  "textProbe",
  "authMethod",
  "configDirectory",
  "durationMs",
  "subscriptionType",
];

function evidence(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const key of evidenceKeys) {
    if (Object.hasOwn(value, key)) {
      result[key] = key === "textProbe" ? evidence(value[key]) : value[key];
    }
  }
  return result;
}

function harnessPayload(result, auth) {
  const payload = {
    path: result.path ?? null,
    version: result.version ?? null,
    auth: {
      state: auth.state,
      method: auth.method ?? null,
      detail: auth.detail ?? null,
    },
    error: result.error ?? null,
  };
  if (debugLogger.isDebugEnabled())
    payload.debug = { test: evidence(result), auth: evidence(auth) };
  return payload;
}

function jobPayload(job) {
  if (!job) return job;
  const { lastError } = job;
  const safe = { ...job };
  delete safe.lastError;
  delete safe.debug;
  const humanReasons = new Set([
    "agent_disallowed",
    "worktree_failed",
    "workspace_untrusted",
    "result_error",
    "interrupted",
    "expired",
    "cancelled",
    "not_authenticated",
    "command_failed",
    "claude not found",
    "cursor-agent not found",
    "claude --version failed",
    "cursor-agent --version failed",
  ]);
  if (typeof safe.reason === "string" && !humanReasons.has(safe.reason)) {
    safe.reason = "command_failed";
    if (debugLogger.isDebugEnabled()) safe.debug = { reason: job.reason };
  }
  if (debugLogger.isDebugEnabled() && lastError) {
    safe.debug = { ...safe.debug, lastError };
  }
  return safe;
}

module.exports = { harnessPayload, jobPayload };
