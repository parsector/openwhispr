const { spawn } = require("node:child_process");
const { createStreamParser } = require("./streamJson");
const { minimalEnv } = require("./cliResolver");
const { redactOutput } = require("./redactOutput");

function createCursorRunner({ cliPath, spawnImpl = spawn } = {}) {
  function start(input) {
    const { folder, prompt, model, mode = "plan", onEvent = () => {} } = input;
    if (
      Object.keys(input).some(
        (key) => !["folder", "prompt", "model", "mode", "onEvent"].includes(key)
      )
    )
      throw new Error("Extra Cursor flags are not allowed");
    if (mode === "write") throw new Error("Write mode requires Claude; Cursor supports plan or ask only");
    if (!["plan", "ask"].includes(mode))
      throw new Error("Cursor agent mode is unavailable: use plan or ask");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.trimStart().startsWith("-"))
      throw new Error("Invalid Cursor prompt");
    if (model && (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model)))
      throw new Error("Invalid Cursor model");
    if (typeof cliPath !== "string" || !require("node:path").isAbsolute(cliPath))
      throw new Error("Cursor CLI not resolved");
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--mode",
      mode,
    ];
    if (model) args.push("--model", model);
    args.push(prompt);
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
    const stdout = createStreamParser("cursor-agent", forward);
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
module.exports = { createCursorRunner };
