const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const ENV_ALLOW = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR"];
const minimalEnv = () =>
  Object.fromEntries(
    ENV_ALLOW.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])
  );
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
  async function authStatus() {
    const resolved = await resolve("claude");
    if (!resolved.ok) return "unknown";
    try {
      await run(resolved.path, ["auth", "status", "--json"], { timeout: 8000, env: minimalEnv() });
      return "authenticated";
    } catch (error) {
      return error.code === 1 ? "not_authenticated" : "unknown";
    }
  }
  return { resolve, test, authStatus };
}
module.exports = { createCliResolver, minimalEnv };
