const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test(
  "navigation releases admission only after the old document's real capture ends",
  { timeout: 40_000, skip: process.platform !== "darwin" && "requires the macOS browser CI lane" },
  () => {
    const result = spawnSync(
      require("electron"),
      [path.join(__dirname, "fixtures/microphoneNavigation.cjs")],
      {
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
      }
    );
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    assert.match(result.stdout, /navigation teardown proved with a real MediaStreamTrack/);
  }
);
