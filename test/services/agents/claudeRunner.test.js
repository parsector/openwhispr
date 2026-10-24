const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createClaudeRunner, ALLOWED_TOOLS, WRITE_TOOLS, DENIED_TOOLS } = require("../../../src/services/agents/claudeRunner");
function capture(input) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  let invocation;
  const runner = createClaudeRunner({ cliPath: process.execPath, spawnImpl: (file, args, options) => {
    invocation = { file, args, options };
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }});
  return runner.start(input).done.then(() => invocation);
}
test("write Claude argv uses acceptEdits with every deny and no forbidden flags", async () => {
  const { args, options } = await capture({ folder: "/tmp/worktree", prompt: "edit", mode: "write", branch: "agent/project-12345678" });
  assert.deepEqual(args.slice(0, 8), ["-p", "edit", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools"]);
  assert.equal(args[8], WRITE_TOOLS);
  assert.deepEqual(args.slice(9, 10 + DENIED_TOOLS.length), ["--disallowedTools", ...DENIED_TOOLS]);
  assert.match(args.at(-1), /Do not commit or push.*Do not run package managers or test suites/);
  assert.equal(options.cwd, "/tmp/worktree");
  assert.equal(options.detached, true);
  for (const flag of ["--dangerously-skip-permissions", "--max-budget-usd", "--max-turns"]) assert.equal(args.includes(flag), false);
});
test("read-only Claude argv remains unchanged", async () => {
  const { args } = await capture({ folder: "/tmp/repo", prompt: "read", model: "sonnet" });
  assert.deepEqual(args, ["-p", "read", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--allowedTools", ALLOWED_TOOLS, "--model", "sonnet"]);
});
