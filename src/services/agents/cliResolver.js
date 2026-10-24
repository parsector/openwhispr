const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const { redactOutput } = require("./redactOutput");
const { minimalEnv } = require("./minimalEnv");
const unknown = (detail) => ({ state: "unknown", method: null, detail });
function parseAuthStatus({ exitCode, stdout = "" }) {
  if (exitCode === "ETIMEDOUT" || exitCode === "TIMEOUT") return unknown("timeout");
  if (exitCode === "ENOENT") return unknown("not found");
  if (exitCode === "EACCES" || exitCode === "EPERM") return unknown("not executable");
  if (exitCode !== 0 && exitCode !== 1)
    return unknown(redactOutput(`exit ${exitCode ?? "unknown"}`).slice(0, 500));
  let value;
  if (String(stdout).trim()) {
    try {
      value = JSON.parse(stdout);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return unknown("unparseable output");
    } catch {
      return unknown("unparseable output");
    }
  } else if (exitCode === 0) return unknown("empty output");
  const method = typeof value?.authMethod === "string" ? redactOutput(value.authMethod) : null;
  if (exitCode === 1) return { state: "not_authenticated", method, detail: null };
  const detail =
    typeof value.configDirectory === "string" && value.configDirectory.trim()
      ? redactOutput(value.configDirectory).slice(0, 500)
      : redactOutput(stdout).trim().slice(0, 500);
  return { state: "authenticated", method, detail: detail || null };
}
function parseCursorStatus({ exitCode, stdout = "", stderr = "" }) {
  const output = redactOutput(`${stdout}\n${stderr}`).trim();
  if (
    exitCode === 0 &&
    /login successful|authenticated|logged in/i.test(output) &&
    !/not authenticated|not logged in|unauthenticated/i.test(output)
  )
    return { state: "authenticated", method: null, detail: null };
  if (
    (exitCode === 0 || exitCode === 1) &&
    /not authenticated|not logged in|unauthenticated/i.test(output)
  )
    return { state: "not_authenticated", method: null, detail: null };
  return unknown(
    exitCode === 0
      ? "unrecognized output"
      : redactOutput(`exit ${exitCode ?? "unknown"}`).slice(0, 500)
  );
}
const snippet = (value, limit) => {
  const bytes = Buffer.from(redactOutput(value || ""));
  let output = bytes.subarray(0, limit).toString("utf8");
  while (Buffer.byteLength(output) > limit) output = output.slice(0, -1);
  return output;
};
const detailFields = (pathValue, argv, result, durationMs) => ({
  path: pathValue,
  argv,
  exitCode: result.exitCode,
  stdoutSnippet: snippet(result.stdout, 2048),
  stderrSnippet: snippet(result.stderr, 500),
  authMethod: null,
  configDirectory: null,
  durationMs,
});
function modelIds(output) {
  let values;
  try {
    const parsed = JSON.parse(output);
    values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.models)
        ? parsed.models
        : parsed?.id || parsed?.name
          ? [parsed]
          : [];
  } catch {
    values = output.split(/\r?\n/);
  }
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map((value) => {
          if (typeof value !== "string") value = value?.id ?? value?.name;
          if (typeof value !== "string") return null;
          const id = redactOutput(value)
            .trim()
            .replace(/^(?:[-*]\s+|•\s*)/, "")
            .trim();
          if (/^(?:loading\.{0,3}|no|none|sign|error)$/i.test(id)) return null;
          return /^[a-z0-9][a-z0-9._:/-]*$/i.test(id) ? id : null;
        })
        .filter(Boolean)
    ),
  ];
}
function createCliResolver({ configuredPaths = {}, run = exec } = {}) {
  const cache = new Map();
  const modelsCache = new Map();
  async function probe(binary, argv, timeout) {
    const start = Date.now();
    try {
      const result = await run(binary, argv, { timeout, env: minimalEnv() });
      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.exitCode ?? 0,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        stdout: error.stdout || "",
        stderr: error.stderr || "",
        exitCode:
          error.killed || error.code === "ETIMEDOUT" || error.code === "TIMEOUT"
            ? "ETIMEDOUT"
            : error.code || "unknown",
        durationMs: Date.now() - start,
      };
    }
  }
  async function listModels(harness) {
    if (!["claude", "cursor-agent"].includes(harness)) throw new Error("Invalid harness");
    if (harness === "claude") return { ok: true, models: [] };
    if (modelsCache.has(harness)) return modelsCache.get(harness);
    const resolved = await resolve(harness);
    if (!resolved.ok) return { ok: false, reason: resolved.error };
    const result = await probe(resolved.path, ["--list-models"], 8000);
    if (result.exitCode !== 0)
      return {
        ok: false,
        reason: result.exitCode === "ETIMEDOUT" ? "timeout" : `exit ${result.exitCode}`,
      };
    const models = modelIds(result.stdout);
    if (!models.length) return { ok: false, reason: "no models found" };
    const value = { ok: true, models };
    modelsCache.set(harness, value);
    return value;
  }
  async function test(harness) {
    if (!["claude", "cursor-agent"].includes(harness)) throw new Error("Invalid harness");
    let lastAttempt = null;
    async function verify(candidate) {
      if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
      try {
        if (!fs.statSync(candidate).isFile()) return null;
      } catch {
        return null;
      }
      const result = await probe(candidate, ["--version"], 8000);
      lastAttempt = {
        ok: false,
        ...detailFields(candidate, ["--version"], result, result.durationMs),
        version: null,
        error: `${harness} --version failed`,
      };
      if (result.exitCode !== 0) return null;
      const value = {
        ok: true,
        ...detailFields(candidate, ["--version"], result, result.durationMs),
        version: snippet(result.stdout.trim(), 500),
        error: null,
      };
      cache.set(harness, value);
      return value;
    }
    if (configuredPaths[harness]) {
      const configured = await verify(configuredPaths[harness]);
      if (configured) return configured;
    }
    const candidates = [];
    for (const shell of ["zsh", "bash"]) {
      const result = await probe(shell, ["-lc", `command -v ${harness}`], 8000);
      if (result.exitCode === 0) candidates.push(result.stdout.trim().split("\n")[0]);
    }
    for (const candidate of candidates) {
      const verified = await verify(candidate);
      if (verified) return verified;
    }
    return (
      lastAttempt || {
        ok: false,
        ...detailFields(null, ["--version"], { exitCode: "ENOENT", stdout: "", stderr: "" }, 0),
        version: null,
        error: `${harness} not found`,
      }
    );
  }
  async function resolve(harness) {
    return cache.get(harness) || test(harness);
  }
  async function authStatus(harness = "claude") {
    if (!["claude", "cursor-agent"].includes(harness)) throw new Error("Invalid harness");
    const resolved = await resolve(harness);
    if (!resolved.ok || !path.isAbsolute(resolved.path))
      return {
        ...unknown("not found"),
        ...detailFields(
          resolved.path || null,
          harness === "claude" ? ["auth", "status"] : ["status"],
          { exitCode: "ENOENT" },
          0
        ),
      };
    const argv = harness === "claude" ? ["auth", "status"] : ["status"];
    const result = await probe(resolved.path, argv, 5000);
    const state = harness === "claude" ? parseAuthStatus(result) : parseCursorStatus(result);
    let configDirectory = null;
    if (harness === "claude") {
      try {
        const data = JSON.parse(result.stdout);
        if (typeof data?.configDirectory === "string")
          configDirectory = snippet(data.configDirectory, 500);
      } catch {}
    }
    const details = {
      ...state,
      ...detailFields(resolved.path, argv, result, result.durationMs),
      authMethod: state.method,
      configDirectory,
    };
    if (harness === "claude") {
      const textResult = await probe(resolved.path, ["auth", "status", "--text"], 5000);
      details.textProbe = detailFields(
        resolved.path,
        ["auth", "status", "--text"],
        textResult,
        textResult.durationMs
      );
    }
    return details;
  }
  return { resolve, test, authStatus, listModels };
}
module.exports = { createCliResolver, minimalEnv, parseAuthStatus, modelIds };
