const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { CommitmentStore, isOverdue } = require("../../src/helpers/commitments/store");

test("store handles edits, archive, history and proposals on a temp DB", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-todos-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => dir, isReady: () => false } };
    return original.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = original; });
  let db;
  try { db = new (require("../../src/helpers/database"))(); }
  catch (error) {
    if (/NODE_MODULE_VERSION|Could not locate the bindings file/.test(String(error))) {
      t.skip("better-sqlite3 binding unavailable"); return;
    }
    throw error;
  }
  t.after(() => db.db.close());
  const store = new CommitmentStore(db);
  const todo = store.create({ text: "Send the deck to Alex", person: "Alex", due_date: "2026-10-28" });
  assert.equal(store.list().length, 1);
  store.setDue(todo.id, "2026-10-30");
  assert.equal(store.mentions(todo.id)[0].kind, "date_moved");
  assert.equal(store.update(todo.id, { due_date: "2026-11-01" }).due_date, "2026-10-30");
  assert.equal(store.update(todo.id, { person: "Sam" }, { user: true }).person, "Sam");
  assert.equal(store.update(todo.id, { person: "Pat" }).person, "Sam");
  store.restate(todo.id, { note_id: "2", segment_index: 0, quote: "I will send it" });
  assert.equal(store.get(todo.id).mention_count, 2);
  const proposal = store.propose(todo.id, { note_id: "3", segment_index: 0, quote: "I sent it", strength: "explicit" });
  assert.equal(store.get(todo.id).status, "proposed");
  assert.equal(store.proposals().length, 1);
  store.resolveProposal(proposal.id, false);
  assert.equal(store.get(todo.id).status, "open");
  assert.equal(store.propose(todo.id, { note_id: "3", segment_index: 0,
    quote: "I sent it", strength: "explicit" }), null);
  const another = store.propose(todo.id, { note_id: "4", segment_index: 0, quote: "I sent it", strength: "explicit" });
  store.resolveProposal(another.id, true);
  assert.equal(store.get(todo.id).status, "completed");
  assert.equal(store.list().length, 0);
  const pending = store.create({ text: "Pending beside archive" });
  assert.deepEqual(store.list().map((item) => item.id), [pending.id]);
  assert.deepEqual(store.list(true).map((item) => item.id), [pending.id, todo.id]);
  assert.equal(store.update(todo.id, { status: "open" }).status, "completed");
});

test("overdue starts at 00:01 the next local day and excludes waiting", () => {
  const row = { status: "open", direction: "owe", due_date: "2026-10-28" };
  assert.equal(Boolean(isOverdue(row, new Date(2026, 9, 29, 0, 0))), false);
  assert.equal(Boolean(isOverdue(row, new Date(2026, 9, 29, 0, 1))), true);
  assert.equal(Boolean(isOverdue({ ...row, direction: "waiting" }, new Date(2026, 9, 29, 1))), false);
});

test("expiry reopens proposed todo and source removal scrubs evidence", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-todos-sweep-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => dir, isReady: () => false } };
    return original.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = original; });
  delete require.cache[require.resolve("../../src/helpers/database")];
  const db = new (require("../../src/helpers/database"))();
  t.after(() => db.db.close());
  const store = new CommitmentStore(db);
  const row = store.create({ text: "Send the report to Alex", quote: "I'll send the report",
    quote_segment_index: 0, source_note_id: 42 });
  const proposal = store.propose(row.id, { note_id: 42, segment_index: 1,
    quote: "I sent the report", strength: "explicit" });
  db.db.prepare("UPDATE commitment_proposals SET expires_at=? WHERE id=?")
    .run("2026-10-01T00:00:00Z", proposal.id);
  assert.equal(store.sweepExpired(new Date("2026-10-28T12:00:00Z")), 1);
  assert.equal(store.get(row.id).status, "open");
  assert.equal(store.proposals().length, 0);
  assert.equal(store.sourceRemoved(42), 1);
  assert.equal(store.get(row.id).quote, null);
  assert.equal(store.get(row.id).source_removed, 1);
  assert.equal(store.mentions(row.id)[0].quote, null);
  assert.equal(db.db.prepare("SELECT quote FROM commitment_proposals WHERE id=?").get(proposal.id).quote, null);
});
