const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");

const scriptRoot = path.resolve(__dirname, "../..");

test("extraction and feed injection preserve the version heading and markdown", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-extract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "CHANGELOG.md"),
    "## [1.12.2] - 2026-11-02\n\nIntro.\n\n- **Fixed** `notes`\n\n## [1.12.1] - 2026-11-01\n\nOlder.\n"
  );
  const notesPath = path.join(dir, "release-notes.md");
  const feedPath = path.join(dir, "latest-arm64-mac.yml");
  fs.writeFileSync(feedPath, "version: 1.12.2\npath: app.zip\n");

  const extract = spawnSync(
    process.execPath,
    [path.join(scriptRoot, "scripts/extract-release-notes.mjs"), "1.12.2", notesPath],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(extract.status, 0, extract.stderr);
  const notes = fs.readFileSync(notesPath, "utf8");
  assert.match(notes, /^## \[1\.12\.2\] - 2026-11-02\n/);
  assert.match(notes, /- \*\*Fixed\*\* `notes`/);
  assert.doesNotMatch(notes, /1\.12\.1/);

  const inject = spawnSync(
    process.execPath,
    [path.join(scriptRoot, "scripts/inject-release-notes.mjs"), feedPath, notesPath, "1.12.2"],
    { encoding: "utf8" }
  );
  assert.equal(inject.status, 0, inject.stderr);
  assert.equal(yaml.load(fs.readFileSync(feedPath, "utf8")).releaseNotes, notes);
});
