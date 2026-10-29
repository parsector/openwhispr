const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { CommitmentStore } = require("../../src/helpers/commitments/store");
const { deleteCommitment } = require("../../src/helpers/commitments/delete");

test("commitments delete IPC refuses outside debug and removes related rows in debug", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-todos-delete-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => dir, isReady: () => false } };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  const db = new (require("../../src/helpers/database"))();
  t.after(() => db.db.close());
  const store = new CommitmentStore(db);
  const target = store.create({ text: "Delete me", source_note_id: 42 });
  const other = store.create({ text: "Keep me", source_note_id: 43 });
  store.propose(target.id, { note_id: 42, segment_index: 0, quote: "Done", strength: "explicit" });
  store.propose(other.id, { note_id: 43, segment_index: 0, quote: "Done", strength: "explicit" });
  const count = (table, id) => db.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE commitment_id=?`).get(id).count;
  const warnings = [];
  const events = [];
  let enabled = false;
  const deps = { store, debugLogger: { isDebugEnabled: () => enabled, warn: (...args) => warnings.push(args) },
    broadcast: (event) => events.push(event) };
  assert.deepEqual(deleteCommitment(deps, target.id), { success: false, error: "debug_only" });
  assert.ok(store.get(target.id));
  assert.equal(count("commitment_mentions", target.id) > 0, true);
  assert.equal(count("commitment_proposals", target.id), 1);
  assert.equal(warnings.length, 1);
  assert.deepEqual(events, []);
  enabled = true;
  assert.deepEqual(deleteCommitment(deps, target.id), { success: true });
  assert.equal(store.get(target.id), null);
  assert.equal(count("commitment_mentions", target.id), 0);
  assert.equal(count("commitment_proposals", target.id), 0);
  assert.ok(store.get(other.id));
  assert.equal(count("commitment_mentions", other.id) > 0, true);
  assert.equal(count("commitment_proposals", other.id), 1);
  assert.deepEqual(events, ["commitments-updated"]);
});

test("main IPC wires debug flag and delete to the guarded helper", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
  assert.match(source, /ipcMain\.handle\("is-debug-enabled", \(\) => debugLogger\.isDebugEnabled\(\)\)/);
  assert.match(source, /ipcMain\.handle\("commitments-delete"[\s\S]*?deleteCommitment\(/);
  assert.match(preload, /isDebugEnabled:.*"is-debug-enabled"/);
  assert.match(preload, /commitmentsDelete:.*"commitments-delete"/);
});
