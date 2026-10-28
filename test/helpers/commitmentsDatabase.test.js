const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

test("commitment schema survives repeated initialization", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-commitments-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => directory, isReady: () => false } };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  const DatabaseManager = require("../../src/helpers/database.js");
  let first;
  try { first = new DatabaseManager(); }
  catch (error) {
    if (/NODE_MODULE_VERSION|Could not locate the bindings file/.test(String(error))) {
      t.skip("better-sqlite3 binding unavailable");
      return;
    }
    throw error;
  }
  const names = ["commitments", "commitment_mentions", "commitment_proposals"];
  for (const name of names) {
    assert.equal(first.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(name).n, 1);
  }
  first.db.close();
  const second = new DatabaseManager();
  t.after(() => second.db.close());
  for (const name of names) {
    assert.equal(second.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(name).n, 1);
  }
});
