const { spawn } = require("node:child_process");
const { createStreamParser } = require("./streamJson");
const { minimalEnv } = require("./cliResolver");
const { redactOutput } = require("./redactOutput");

const ALLOWED_TOOLS =
  "Read,Grep,Glob,WebFetch,WebSearch,Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr list:*),Bash(gh pr checks:*)";
function createClaudeRunner({ cliPath, spawnImpl = spawn } = {}) {
  function start({ folder, prompt, model, onEvent = () => {} }) {
    if (typeof cliPath !== "string" || !require("node:path").isAbsolute(cliPath))
      throw new Error("Claude CLI not resolved");
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      ALLOWED_TOOLS,
    ];
    if (model) args.push("--model", model);
    const child = spawnImpl(cliPath, args, {
      cwd: folder,
      env: minimalEnv(),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resultEvent = null;
    const forward = (event) => {
      if (event.kind === "result") resultEvent = event;
      onEvent(event);
    };
    const stdout = createStreamParser("claude", forward);
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.feed(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    let escalation;
    const signal = (sig) => {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else process.kill(-child.pid, sig);
      } catch {}
    };
    const cancel = () => {
      signal("SIGTERM");
      escalation = setTimeout(() => signal("SIGKILL"), 5000);
      escalation.unref?.();
    };
    const kill = () => signal("SIGKILL");
    const done = new Promise((resolve) => {
      child.once("error", (error) => {
        stdout.end();
        clearTimeout(escalation);
        resolve({
          exitCode: null,
          signal: null,
          resultEvent,
          error: redactOutput(error.message),
          stderr,
        });
      });
      child.once("close", (exitCode, exitSignal) => {
        stdout.end();
        clearTimeout(escalation);
        resolve({ exitCode, signal: exitSignal, resultEvent, stderr });
      });
    });
    return { pid: child.pid, cancel, kill, done };
  }
  return { start };
}
module.exports = { ALLOWED_TOOLS, createClaudeRunner };
