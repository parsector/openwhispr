const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { terminalCommands, openTerminal } = require("../../../src/services/agents/openTerminal");

test("terminal plans use fixed argv and a safely quoted folder", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agent's folder "));
  try {
    for (const harness of ["claude", "cursor-agent"]) {
      const job = { harness, mode: "read-only", sessionId: "session:1", project: { folder } };
      const mac = terminalCommands(job, "darwin")[0];
      assert.equal(mac.file, "/usr/bin/osascript");
      assert.match(mac.args[1], /quoted form of \(item 1 of argv\)/);
      assert.equal(mac.args[2], folder);
      assert.equal(mac.args[3], "session:1");
      assert.equal(mac.args[1].includes(folder), false);
      const linux = terminalCommands(job, "linux");
      assert.deepEqual(
        linux.map((item) => item.file),
        ["x-terminal-emulator", "gnome-terminal", "konsole"]
      );
      for (const plan of linux)
        assert.deepEqual(plan.args.slice(-3), [harness, "--resume", "session:1"]);
      const windows = terminalCommands(job, "win32");
      assert.deepEqual(
        windows.map((item) => item.file),
        ["wt", "cmd"]
      );
      assert.deepEqual(windows[1].args.slice(-3), [harness, "--resume", "session:1"]);
      assert.equal(windows[1].args.includes(folder), false);
      assert.equal(windows[1].cwd, folder);
    }
  } finally {
    fs.rmSync(folder, { recursive: true });
  }
});

test("all invalid terminal jobs spawn nothing", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agent-terminal-"));
  let spawned = 0;
  const spawnImpl = () => {
    spawned++;
    return new EventEmitter();
  };
  const base = {
    harness: "claude",
    mode: "read-only",
    sessionId: "session:1",
    project: { folder },
  };
  try {
    for (const [job, reason] of [
      [{ ...base, sessionId: null }, "no_session"],
      [{ ...base, sessionId: "bad id" }, "no_session"],
      [{ ...base, harness: "other" }, "unsupported_harness"],
      [{ ...base, project: { folder: "/not-a-real-folder" } }, "folder_missing"],
      [{ ...base, mode: "write", worktreePath: "/not-a-real-worktree" }, "folder_missing"],
    ])
      await assert.rejects(openTerminal(job, { spawnImpl }), new RegExp(reason));
    assert.equal(spawned, 0);
  } finally {
    fs.rmSync(folder, { recursive: true });
  }
});
