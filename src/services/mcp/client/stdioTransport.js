const { spawn } = require("node:child_process");
const ENV_ALLOW = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR"];
function createStdioTransport(config, onSpawn = () => {}) {
  const env = Object.fromEntries(
    ENV_ALLOW.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])
  );
  Object.assign(env, config.env || {});
  const child = spawn(config.command, config.args || [], {
    cwd: config.cwd || undefined,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  onSpawn({
    command: config.command,
    args: config.args || [],
    cwd: config.cwd || null,
    pid: child.pid || null,
  });
  let buffer = "";
  let listener = () => {};
  let failure = () => {};
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) return failure(new Error("MCP response too large"));
    let line;
    while ((line = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, line).trim();
      buffer = buffer.slice(line + 1);
      if (raw) {
        try {
          listener(JSON.parse(raw));
        } catch (error) {
          failure(error);
        }
      }
    }
  });
  child.on("error", failure);
  child.on("exit", (code) => failure(new Error(`MCP server exited (${code})`)));
  return {
    onMessage(fn) {
      listener = fn;
    },
    onError(fn) {
      failure = fn;
    },
    send(message) {
      if (!child.stdin.writable) throw new Error("MCP server stopped");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    stop() {
      if (!child.killed) child.kill("SIGKILL");
    },
    get pid() {
      return child.pid;
    },
  };
}
module.exports = { createStdioTransport };
