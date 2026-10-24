const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createCursorRunner } = require("../../../src/services/agents/cursorRunner");
const fakeCli = path.join(__dirname, "../../fixtures/fakeCursor.js");

test("Cursor argv uses only the fixed read-only template", async () => {
  const child = require("node:child_process").spawn(process.execPath, ["-e", ""], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let invocation;
  const runner = createCursorRunner({
    cliPath: fakeCli,
    spawnImpl: (file, args, options) => {
      invocation = { file, args, options };
      return child;
    },
  });
  await runner.start({ folder: process.cwd(), prompt: "hello", model: "auto", mode: "ask" }).done;
  assert.deepEqual(invocation.args, [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--mode",
    "ask",
    "--model",
    "auto",
    "hello",
  ]);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.shell, false);
  assert.equal(
    invocation.args.some((arg) =>
      ["--force", "--yolo", "--sandbox", "--trust", "--approve-mcps"].includes(arg)
    ),
    false
  );
  assert.throws(
    () => runner.start({ folder: process.cwd(), prompt: "x", mode: "agent" }),
    /requires --force|unavailable/
  );
  assert.throws(
    () => runner.start({ folder: process.cwd(), prompt: "x", mode: "write" }),
    /requires Claude/
  );
  assert.throws(
    () => runner.start({ folder: process.cwd(), prompt: "x", flags: ["--force"] }),
    /Extra Cursor flags/
  );
  assert.throws(
    () => runner.start({ folder: process.cwd(), prompt: "--force" }),
    /Invalid Cursor prompt/
  );
  assert.throws(
    () => runner.start({ folder: process.cwd(), prompt: "x", model: "--force" }),
    /Invalid Cursor model/
  );
});

test("Cursor cancel kills the process group and preserves failure stderr for manager redaction", async () => {
  const runner = createCursorRunner({ cliPath: fakeCli });
  const running = runner.start({ folder: process.cwd(), prompt: "hang", mode: "plan" });
  running.cancel();
  const result = await running.done;
  assert.notEqual(result.exitCode, 0);
  const failed = await runner.start({ folder: process.cwd(), prompt: "fail", mode: "ask" }).done;
  assert.match(failed.stderr, /Bearer secret/);
});

test("Cursor cancel targets the detached process group", () => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  const runner = createCursorRunner({ cliPath: fakeCli, spawnImpl: () => child });
  const launched = runner.start({ folder: process.cwd(), prompt: "wait" });
  const originalKill = process.kill;
  const calls = [];
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return true;
  };
  try {
    launched.cancel();
  } finally {
    process.kill = originalKill;
  }
  if (process.platform !== "win32") assert.deepEqual(calls[0], [-12345, "SIGTERM"]);
  child.emit("close", null, "SIGTERM");
});
