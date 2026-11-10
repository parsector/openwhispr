const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db");
const { readTranscriptDocument } = require("../../src/helpers/transcriptDocument");
const { readScope, decision } = require("../../src/helpers/noteSpeakerScope");

for (const participants of [
  null,
  "[]",
  "[ ]",
  "   ",
  "{broken",
  "null",
  "{}",
  '[{"email":"a@example.com"}]',
]) {
  test(`run8: raw bulk import validates historical attribution under parsed roster (${JSON.stringify(participants)})`, (t) => {
    const db = createDb(t);
    if (!db) return;
    const nextId = db.db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM notes").get().id;
    const scope = readScope(db, nextId, [], { id: nextId, participants });
    const veto = decision(scope, { path: "test", rejectionReason: "no_match" });
    const rows = [
      { id: "r", text: "Hello", speakerName: "Alice", uncertainty: { reason: "close_match" } },
      { id: "overlap", text: "Hello", speakerName: "Alice", overlap: true },
      { id: "human", text: "Hello", speakerName: "Chosen", speakerLockSource: "user" },
      { id: "recorded", text: "Hello", speakerIsPlaceholder: true, speakerDecision: veto },
      {
        id: "machine",
        text: "Hello",
        speakerName: "Machine",
        uncertainty: { reason: "close_match" },
        speakerAssignment: { origin: "machine", accepted: true, email: "missing@example.com" },
      },
    ];
    const result = db.importNotes([
      {
        clientNoteId: "run8-import",
        title: "Import",
        content: "",
        participants,
        transcript: JSON.stringify(rows),
      },
    ]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.imported, 1);
    assert.equal(result.noteIds[0], nextId);
    // Read storage directly so a later read projection cannot hide an import defect.
    const actual = readTranscriptDocument(
      db.db.prepare("SELECT transcript FROM notes WHERE id = ?").get(nextId).transcript
    ).rows;
    const unrestricted = participants == null || ["[]", "[ ]"].includes(participants);
    for (const row of actual.slice(0, 2)) {
      assert.equal(row.speakerName, unrestricted ? "Alice" : undefined);
      if (!unrestricted) {
        assert.equal(row.speakerReviewRequired, true);
        assert.equal(row.speakerDecision.rejectionReason, "legacy_not_evaluated");
      }
    }
    assert.deepEqual(actual[0].uncertainty, rows[0].uncertainty);
    assert.equal(actual[1].overlap, true);
    assert.equal(actual[2].speakerName, "Chosen");
    assert.equal(actual[2].speakerLockSource, "user");
    assert.deepEqual(actual[3].speakerDecision, veto);
    assert.equal(actual[4].speakerName, undefined, "machine assignments still validate");
    assert.ok(actual[4].speakerDecision.rejectionReason);
  });
}
