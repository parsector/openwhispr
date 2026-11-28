const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync, fork } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createTempDir = require("../lib/tempDir");

test(
  "native mic listener exits on stdin EOF, parent SIGKILL, and orderly SIGTERM",
  { timeout: 150_000 },
  async (t) => {
    if (process.platform !== "darwin") {
      t.skip("requires CoreAudio and the macOS Swift compiler");
      return;
    }
    const dir = createTempDir(path.join(os.tmpdir(), "mic-listener-lifecycle-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const binary = path.join(dir, "mic-listener");
    const compiled = spawnSync(
      "swiftc",
      [
        path.resolve(__dirname, "../../resources/macos-mic-listener.swift"),
        "-module-cache-path",
        path.join(dir, "modules"),
        "-framework",
        "CoreAudio",
        "-framework",
        "Foundation",
        "-o",
        binary,
      ],
      { encoding: "utf8", timeout: 120_000 }
    );
    assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);

    for (const mode of ["EOF", "SIGKILL", "SIGTERM"]) {
      await t.test(mode, { timeout: 10_000 }, async () => {
        const child =
          mode === "SIGKILL"
            ? fork(path.resolve(__dirname, "../fixtures/micListenerParent.cjs"), [binary], {
                stdio: ["pipe", "pipe", "pipe", "ipc"],
                execArgv: [],
              })
            : spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
        let helperPid;
        const pidMessage =
          mode === "SIGKILL" ? once(child, "message", { signal: AbortSignal.timeout(5000) }) : null;
        t.after(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          if (helperPid) {
            try {
              process.kill(helperPid, "SIGKILL");
            } catch {
              /* already exited */
            }
          }
        });
        const lines = createInterface({ input: child.stdout });
        t.after(() => lines.close());
        const [ready] = await once(lines, "line", { signal: AbortSignal.timeout(5000) });
        assert.match(ready, /^CAPABILITY (PID|AGGREGATE)$/);
        if (pidMessage) [{ pid: helperPid }] = await pidMessage;
        // No timeout or stdin close before readiness: the helper must remain
        // alive while the parent's pipe is open, including on an idle system.
        assert.equal(child.exitCode, null);
        const closed = once(child, "close", { signal: AbortSignal.timeout(5000) });
        if (mode === "EOF") child.stdin.end();
        else child.kill(mode);
        const [code, signal] = await closed;
        if (mode !== "SIGKILL") {
          assert.equal(code, 0);
          assert.equal(signal, null);
        }
        // In SIGKILL mode close waits for inherited helper stdout/stderr to
        // close as well. A surviving orphan makes this time out.
        assert.equal(child.stdout.readableEnded, true);
        helperPid = null;
      });
    }
  }
);
