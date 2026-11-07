const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createTempDir = require("./tempDir");

test("temp directories are unique and default to the OS temp directory", (t) => {
  const directories = [];
  t.after(() => directories.forEach((directory) => fs.rmSync(directory, { recursive: true })));
  directories.push(createTempDir("temp-dir-test-"), createTempDir("temp-dir-test-"));
  assert.notEqual(directories[0], directories[1]);
  for (const directory of directories) {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(fs.statSync(directory).isDirectory());
  }
});

test("temp directories create missing parents and preserve explicit prefix locations", (t) => {
  const root = createTempDir("temp-dir-parent-test-");
  t.after(() => fs.rmSync(root, { recursive: true }));
  const parent = path.join(root, "missing", "nested");
  assert.equal(fs.existsSync(parent), false);
  const directory = createTempDir("fixture-", parent);
  assert.equal(path.dirname(directory), parent);
  assert.ok(fs.statSync(directory).isDirectory());

  const absoluteParent = path.join(root, "absolute");
  const absolute = createTempDir(path.join(absoluteParent, "fixture-"));
  assert.equal(path.dirname(absolute), absoluteParent);

  const relativeParent = path.join(root, "relative");
  const relative = createTempDir("fixture-", path.relative(process.cwd(), relativeParent));
  assert.equal(path.dirname(relative), relativeParent);
});
