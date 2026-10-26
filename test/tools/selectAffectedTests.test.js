const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { changedFilesFromGit, selectForChanges } = require("../../scripts/select-affected-tests");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "affected-tests-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, source) => {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  };
  write("main.js", "module.exports = require('./src/chain-a');\n");
  write("preload.js", "module.exports = {};\n");
  write("src/chain-a.js", "module.exports = require('./chain-b');\n");
  write("src/chain-b.js", "module.exports = require('./chain-c');\n");
  write("src/chain-c.js", "module.exports = 1;\n");
  write("src/other.js", "module.exports = 2;\n");
  write("src/unrelated.js", "module.exports = 3;\n");
  write("test/deep.test.js", "require('../src/chain-a');\n");
  write("test/other.test.js", "require('../src/other');\n");
  write("test/unreferenced.test.js", "require('node:test');\n");
  return root;
}

test("a deep import selects its test and the unreferenced test", (t) => {
  const root = fixture(t);
  const result = selectForChanges(root, ["src/chain-c.js"]);
  assert.equal(result.full, false);
  assert.deepEqual(result.files, ["test/deep.test.js", "test/unreferenced.test.js"]);
});

test("an unrelated source change selects only the conservative test", (t) => {
  const root = fixture(t);
  const result = selectForChanges(root, ["src/unrelated.js"]);
  assert.equal(result.full, false);
  assert.deepEqual(result.files, ["test/unreferenced.test.js"]);
});

test("every always-run path selects the full suite", (t) => {
  const root = fixture(t);
  for (const file of [
    "package.json",
    "package-lock.json",
    "electron-builder.json",
    ".github/workflows/check.yml",
    "scripts/afterPack.js",
    "scripts/download-a.js",
    "scripts/build-a.js",
    "scripts/lib/shared.js",
    "src/vite.config.ts",
  ]) {
    const result = selectForChanges(root, [file]);
    assert.equal(result.full, true, file);
    assert.equal(result.count, 3, file);
    assert.match(result.reason, /always-run/, file);
  }
});

test("a suite under test/helpers selects itself without a directory-wide fallback", (t) => {
  const root = fixture(t);
  const suite = "test/helpers/routineSources.test.js";
  fs.mkdirSync(path.join(root, "test/helpers"), { recursive: true });
  fs.writeFileSync(path.join(root, suite), "require('../../src/other');\n");
  fs.writeFileSync(path.join(root, "test/importing.test.js"), "require('./helpers/routineSources.test');\n");
  const result = selectForChanges(root, [suite]);
  assert.equal(result.full, false);
  assert.deepEqual(result.files, [suite, "test/unreferenced.test.js"]);
});

test("a non-suite test helper selects its importing suite", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "test/helpers"), { recursive: true });
  fs.writeFileSync(path.join(root, "test/helpers/shared.js"), "module.exports = require('../../src/other');\n");
  fs.writeFileSync(path.join(root, "test/helpers/usesShared.test.js"), "require('./shared');\n");
  const result = selectForChanges(root, ["test/helpers/shared.js"]);
  assert.equal(result.full, false);
  assert.deepEqual(result.files, ["test/helpers/usesShared.test.js", "test/unreferenced.test.js"]);
});

test("a test fixture selects its importing suite", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "test/fixtures"), { recursive: true });
  fs.writeFileSync(path.join(root, "test/fixtures/sample.json"), '{"message":"sample"}\n');
  fs.writeFileSync(path.join(root, "test/fixtureUser.test.js"), "require('./fixtures/sample.json');\n");
  const result = selectForChanges(root, ["test/fixtures/sample.json"]);
  assert.equal(result.full, false);
  assert.deepEqual(result.files, ["test/fixtureUser.test.js", "test/unreferenced.test.js"]);
});

test("an unknown file selects the full suite", (t) => {
  const root = fixture(t);
  const result = selectForChanges(root, ["mystery/new-file.xyz"]);
  assert.equal(result.full, true);
  assert.match(result.reason, /cannot be resolved/);
});

test("a deleted test file does not crash or produce zero tests", (t) => {
  const root = fixture(t);
  const result = selectForChanges(root, ["test/deleted.test.js"]);
  assert.equal(result.full, false);
  assert.deepEqual(result.files, ["test/unreferenced.test.js"]);
});

test("uncommitted changes are included only when requested", (t) => {
  const root = fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base");
  fs.writeFileSync(path.join(root, "src/unrelated.js"), "module.exports = 4;\n");
  assert.deepEqual(changedFilesFromGit(root, { base: "HEAD", includeUncommitted: false }), []);
  assert.deepEqual(changedFilesFromGit(root, { base: "HEAD", includeUncommitted: true }), [
    "src/unrelated.js",
    "test/deep.test.js",
    "test/other.test.js",
    "test/unreferenced.test.js",
    "main.js",
    "preload.js",
    "src/chain-a.js",
    "src/chain-b.js",
    "src/chain-c.js",
    "src/other.js",
  ].sort());
});
