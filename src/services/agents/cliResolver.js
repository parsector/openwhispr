const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const { redactOutput } = require("./redactOutput");
const ENV_ALLOW = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR"];
const minimalEnv = () =>
  Object.fromEntries(
    ENV_ALLOW.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])
  );
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
function createCliResolver({ configuredPaths = {}, run = exec } = {}) {
  const cache = new Map();
  async function test(harness) {
    if (!["claude", "cursor-agent"].includes(harness)) throw new Error("Invalid harness");
    async function verify(candidate) {
      if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
      try {
        if (!fs.statSync(candidate).isFile()) return null;
        const { stdout } = await run(candidate, ["--version"], {
          timeout: 8000,
          env: minimalEnv(),
        });
        const value = { ok: true, path: candidate, version: stdout.trim(), error: null };
        cache.set(harness, value);
        return value;
      } catch {
        return null;
      }
    }
    if (configuredPaths[harness]) {
      const configured = await verify(configuredPaths[harness]);
      if (configured) return configured;
    }
    const candidates = [];
    for (const shell of ["zsh", "bash"]) {
      try {
        const { stdout } = await run(shell, ["-lc", `command -v ${harness}`], {
          timeout: 8000,
          env: minimalEnv(),
        });
        candidates.push(stdout.trim().split("\n")[0]);
      } catch {}
    }
    for (const candidate of candidates) {
      const verified = await verify(candidate);
      if (verified) return verified;
    }
    return { ok: false, path: null, version: null, error: `${harness} not found` };
  }
  async function resolve(harness) {
    return cache.get(harness) || test(harness);
  }
  async function authStatus(harness = "claude") {
    try {
      const resolved = await resolve(harness);
      if (!resolved.ok || !path.isAbsolute(resolved.path)) return unknown("not found");
      const { stdout, stderr } = await run(
        resolved.path,
        harness === "claude" ? ["auth", "status"] : ["status"],
        {
          timeout: 5000,
          env: minimalEnv(),
        }
      );
      return harness === "claude"
        ? parseAuthStatus({ exitCode: 0, stdout, stderr })
        : parseCursorStatus({ exitCode: 0, stdout, stderr });
    } catch (error) {
      if (error.killed || error.code === "ETIMEDOUT") return unknown("timeout");
      if (error.code === "ENOENT") return unknown("not found");
      if (error.code === "EACCES" || error.code === "EPERM") return unknown("not executable");
      return harness === "claude"
        ? parseAuthStatus({ exitCode: error.code, stdout: error.stdout, stderr: error.stderr })
        : parseCursorStatus({ exitCode: error.code, stdout: error.stdout, stderr: error.stderr });
    }
  }
  return { resolve, test, authStatus };
}
module.exports = { createCliResolver, minimalEnv, parseAuthStatus };
