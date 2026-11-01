const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "../..");
const fixture = (name) => fs.readFileSync(path.join(root, "test/fixtures", name), "utf8");
const script = path.join(root, "scripts/inject-release-notes.mjs");

test("injects exact notes into a real-shaped feed without changing other keys, twice", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const feedPath = path.join(dir, "latest-arm64-mac.yml");
  const notesPath = path.join(dir, "release-notes.md");
  const feed = fixture("release-feed.yml");
  const notes = fixture("release-notes.md");
  fs.writeFileSync(feedPath, feed);
  fs.writeFileSync(notesPath, notes);

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync(process.execPath, [script, feedPath, notesPath, "1.11.0"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = fs.readFileSync(feedPath, "utf8");
    const parsed = yaml.load(output);
    assert.equal(parsed.releaseNotes, notes);
    assert.deepEqual(
      Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "releaseNotes")),
      yaml.load(feed)
    );
    assert.ok(output.startsWith(feed));
    if (attempt === 0) t.diagnostic("first injection parsed; releaseNotes round-tripped exactly");
  }
  const verify = spawnSync(process.execPath, [script, "--verify", feedPath, notesPath, "1.11.0"], {
    encoding: "utf8",
  });
  assert.equal(verify.status, 0, verify.stderr);
});
