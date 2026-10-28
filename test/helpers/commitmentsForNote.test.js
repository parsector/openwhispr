const test = require("node:test");
const assert = require("node:assert/strict");
const { CommitmentStore } = require("../../src/helpers/commitments/store.js");

test("forNote scopes the query to the account and requested source note", () => {
  let sql, args;
  const db = { prepare(query) { sql = query; return { all(...values) { args = values; return [{ id: "x" }]; } }; } };
  const store = new CommitmentStore({ db, activeAccountId: "account-1" });
  assert.deepEqual(store.forNote(42), [{ id: "x" }]);
  assert.deepEqual(args, ["account-1", "42"]);
  assert.match(sql, /source_note_id=\?/);
  assert.match(sql, /archived_at IS NULL/);
  assert.match(sql, /quote_segment_index IS NOT NULL/);
});
