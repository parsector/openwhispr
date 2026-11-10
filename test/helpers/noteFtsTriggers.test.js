const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");

function assertIndex(db, noteId, present, absent = []) {
  // rank=1 also compares the external notes content with the FTS index.
  db.db.exec("INSERT INTO notes_fts(notes_fts, rank) VALUES ('integrity-check', 1)");
  for (const term of present) {
    assert.deepEqual(
      db.searchNotes(term).map((note) => note.id),
      [noteId],
      term
    );
  }
  for (const term of absent) assert.deepEqual(db.searchNotes(term), [], term);
}

function exerciseRosterAndTextChanges(db) {
  const note = db.saveNote("oldtitle", "oldcontent", "meeting").note;
  db.updateNote(note.id, { enhanced_content: "oldsummary" });
  assertIndex(db, note.id, ["oldtitle", "oldcontent", "oldsummary"]);

  db.updateNote(note.id, {
    title: "localtitle localextra",
    content: "localcontent",
    enhanced_content: "localsummary",
    participants: JSON.stringify([{ email: "local@example.com" }]),
  });
  assert.equal(db.getNote(note.id).speaker_roster_revision, 1);
  assertIndex(
    db,
    note.id,
    ["localtitle", "localextra", "localcontent", "localsummary"],
    ["oldtitle", "oldcontent", "oldsummary"]
  );

  db.markNoteSynced(note.id, "cloud-fts");
  const local = db.getNote(note.id);
  const cloud = {
    id: "cloud-fts",
    client_note_id: local.client_note_id,
    title: "cloudtitle cloudextra cloudmore",
    content: "cloudcontent",
    enhanced_content: "cloudsummary",
    participants: JSON.stringify([{ email: "cloud@example.com" }]),
    created_at: local.created_at,
    updated_at: "2026-11-10T12:00:00.000Z",
  };
  db.upsertNoteFromCloud(cloud, null);
  assert.equal(db.getNote(note.id).speaker_roster_revision, 2);
  assertIndex(
    db,
    note.id,
    ["cloudtitle", "cloudcontent", "cloudsummary"],
    ["localtitle", "localextra", "localcontent", "localsummary"]
  );

  db.upsertNoteFromCloud(cloud, null);
  assert.equal(db.getNote(note.id).speaker_roster_revision, 2, "a replay keeps the revision");
  assertIndex(db, note.id, ["cloudtitle", "cloudcontent", "cloudsummary"]);

  db.updateNote(note.id, {
    title: "clearedtitle",
    content: "",
    enhanced_content: null,
    participants: "[]",
  });
  assert.equal(db.getNote(note.id).speaker_roster_revision, 3);
  assertIndex(db, note.id, ["clearedtitle"], ["cloudtitle", "cloudcontent", "cloudsummary"]);

  db.db.prepare("DELETE FROM notes WHERE id = ?").run(note.id);
  assertIndex(db, note.id, [], ["clearedtitle"]);
}

test("FTS stays consistent when local saves and cloud upserts change the roster and indexed text", (t) => {
  const db = createDb(t);
  if (db) exerciseRosterAndTextChanges(db);
});

test("opening an existing database replaces the broad FTS update trigger", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { sql } = db.db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'notes_fts_update'")
    .get();
  db.db.exec("DROP TRIGGER notes_fts_update");
  db.db.exec(sql.replace(/AFTER UPDATE OF[^]*? ON notes/, "AFTER UPDATE ON notes"));
  const existing = db.saveNote("existingtitle", "existingcontent", "meeting").note;
  // Older opens inserted these rows again instead of rebuilding the index.
  db.db.exec(`INSERT INTO notes_fts(rowid, title, content, enhanced_content)
    SELECT id, title, content, enhanced_content FROM notes`);
  assert.throws(
    () => db.db.exec("INSERT INTO notes_fts(notes_fts, rank) VALUES ('integrity-check', 1)"),
    { code: "SQLITE_CORRUPT_VTAB" }
  );
  db.db.pragma("user_version = 5");
  db.db.close();
  db.initDatabase();
  assertIndex(db, existing.id, ["existingtitle", "existingcontent"]);
  db.updateNote(existing.id, { title: "migratedtitle", participants: "[]" });
  assert.equal(db.getNote(existing.id).speaker_roster_revision, 1);
  assertIndex(db, existing.id, ["migratedtitle", "existingcontent"], ["existingtitle"]);
  db.db.close();
  db.initDatabase();
  assertIndex(db, existing.id, ["migratedtitle", "existingcontent"], ["existingtitle"]);
  exerciseRosterAndTextChanges(db);
});
