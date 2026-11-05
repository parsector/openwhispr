const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  recordingIdentity,
  overlapsRecording,
  rememberRecording,
} = require("../../src/helpers/voiceRecordingIdentity");

test("legacy and durable evidence resolve the real recording UUID without trusting reused note IDs", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE notes (id INTEGER, client_note_id TEXT, transcript TEXT);
    CREATE TABLE voice_exemplar_audio (note_identity TEXT, recording_id TEXT);`);
  const document = JSON.stringify({
    version: 2,
    rows: [{ id: "row", audioSpan: { recordingId: "recording-uuid" } }],
  });
  db.prepare("INSERT INTO notes VALUES (1, 'original-note', ?)").run(document);
  const legacy = { note_id: 1, track: "mic", start_sample: 100, end_sample: 200 };
  const durable = { ...legacy, note_identity: "original-note", recording_id: "recording-uuid" };
  assert.equal(recordingIdentity(db, legacy), recordingIdentity(db, durable));
  assert.equal(recordingIdentity(db, legacy), "recording:recording-uuid");
  db.prepare("UPDATE notes SET client_note_id = 'replacement-note', transcript = ?").run(
    JSON.stringify({ version: 2, rows: [] })
  );
  const replacement = { id: 1, client_note_id: "replacement-note" };
  assert.equal(
    overlapsRecording(
      db,
      durable,
      replacement,
      { recordingId: "replacement-recording" },
      "mic",
      120,
      150
    ),
    false
  );
  assert.equal(
    overlapsRecording(db, durable, replacement, { recordingId: "recording-uuid" }, "mic", 120, 150),
    true
  );
  assert.equal(
    overlapsRecording(db, durable, replacement, { recordingId: "recording-uuid" }, "mic", 200, 250),
    false
  );
});

test("missing recording provenance is explicitly unresolved, even across immutable note identities", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE notes (id INTEGER, client_note_id TEXT, transcript TEXT);
    CREATE TABLE voice_exemplar_audio (note_identity TEXT, recording_id TEXT);
    INSERT INTO notes VALUES (1, 'note-uuid', NULL);`);
  assert.equal(recordingIdentity(db, { note_id: 1 }), null);
  assert.equal(recordingIdentity(db, { note_id: 1, note_identity: "note-uuid" }), null);
  assert.equal(recordingIdentity(db, { note_id: 2, note_identity: "other-note" }), null);
  const span = { note_id: 1, track: "mic", start_sample: 10, end_sample: 20 };
  assert.equal(
    overlapsRecording(db, span, { id: 2, client_note_id: "other-note" }, {}, "mic", 12, 18),
    false
  );
  assert.equal(
    overlapsRecording(db, span, { id: 1, client_note_id: "note-uuid" }, {}, "mic", 12, 18),
    true
  );
});

test("audio-store UUID resolution upgrades legacy provenance without attaching an old note's exemplars", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE notes (id INTEGER, client_note_id TEXT, transcript TEXT);
    CREATE TABLE voice_exemplars (note_id INTEGER, recording_id TEXT);
    CREATE TABLE voice_exemplar_audio (note_id INTEGER, note_identity TEXT, recording_id TEXT);
    INSERT INTO notes VALUES (1, 'current-note', NULL);
    INSERT INTO voice_exemplars VALUES (1, NULL);
    INSERT INTO voice_exemplar_audio VALUES (1, 'current-note', NULL), (1, 'deleted-note', NULL);`);
  const note = { id: 1, client_note_id: "current-note", transcript: null };
  const sample = { note_id: 1, track: "mic", start_sample: 10, end_sample: 20 };
  const status = { recordingId: "audio-store-uuid" };
  assert.equal(overlapsRecording(db, sample, note, status, "mic", 12, 18), true);
  rememberRecording(db, note, status);
  assert.equal(
    db.prepare("SELECT recording_id FROM voice_exemplars").get().recording_id,
    status.recordingId
  );
  assert.equal(
    db
      .prepare("SELECT recording_id FROM voice_exemplar_audio WHERE note_identity = 'current-note'")
      .get().recording_id,
    status.recordingId
  );
  assert.equal(
    db
      .prepare("SELECT recording_id FROM voice_exemplar_audio WHERE note_identity = 'deleted-note'")
      .get().recording_id,
    null
  );
});
