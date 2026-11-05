const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  open,
  classifyEvidence,
  overlapsRecording,
} = require("../../src/helpers/voiceRecordingIdentity");
const uuid = "9aabbcc0-0000-4000-8000-000000000001";
function fixture(t) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE speaker_profiles (id INTEGER PRIMARY KEY)");
  open(db);
  const sample = {
    id: "approved",
    note_id: 1,
    note_identity: "original",
    track: "mic",
    start_sample: 100,
    end_sample: 200,
  };
  const manifest = {
    noteId: 1,
    noteIdentity: "original",
    recordingId: uuid,
    status: "complete",
    tracks: { mic: { chunks: [{ file: "real.opus" }] } },
  };
  const store = { recordingProvenance: () => manifest };
  return { db, sample, manifest, store };
}
test("readers ignore cached IDs, status, transcripts and sibling identities", (t) => {
  const { db, sample, store } = fixture(t);
  assert.deepEqual(classifyEvidence(db, { ...sample, recording_id: uuid }), {
    state: "pending_recovery",
  });
  assert.deepEqual(classifyEvidence(db, sample, { store }), { state: "pending_recovery" });
  assert.equal(db.prepare("SELECT count(*) n FROM voice_evidence_provenance").get().n, 0);
  assert.deepEqual(classifyEvidence(db, sample, { store, record: true }), {
    state: "resolved",
    recordingId: uuid,
  });
});
test("pending identity rejects tombstones, synthesized IDs and another note's manifest", (t) => {
  const { db, sample, manifest, store } = fixture(t);
  for (const change of [
    { status: "deleted", tracks: {} },
    { recordingId: "note:1" },
    { recordingId: 1 },
    { noteIdentity: "replacement" },
    { tracks: {} },
  ]) {
    const badStore = { recordingProvenance: () => ({ ...manifest, ...change }) };
    assert.equal(
      classifyEvidence(db, sample, { store: badStore, record: true }).state,
      "pending_recovery"
    );
  }
  assert.equal(classifyEvidence(db, sample, { store, record: true }).recordingId, uuid);
});
test("resolved and unrecoverable classifications are terminal across future manifests", (t) => {
  const { db, sample, store, manifest } = fixture(t);
  classifyEvidence(db, sample, { store, record: true });
  manifest.recordingId = "9aabbcc0-0000-4000-8000-000000000002";
  assert.equal(classifyEvidence(db, sample, { store, record: true }).recordingId, uuid);
  const lost = { ...sample, id: "lost" };
  classifyEvidence(db, lost, { record: true, unavailable: "legacy_audio_unavailable" });
  assert.deepEqual(classifyEvidence(db, lost, { store, record: true }), {
    state: "unrecoverable",
    reason: "legacy_audio_unavailable",
  });
});
test("overlap uses classified provenance; unresolved same-note intervals still suppress duplicates", (t) => {
  const { db, sample, store } = fixture(t);
  assert.equal(
    overlapsRecording(db, sample, { id: 1, client_note_id: "original" }, store, "mic", 120, 150),
    true
  );
  assert.equal(
    overlapsRecording(db, sample, { id: 1, client_note_id: "replacement" }, store, "mic", 120, 150),
    false
  );
  classifyEvidence(db, sample, { store, record: true });
  assert.equal(
    overlapsRecording(db, sample, { id: 1, client_note_id: "original" }, store, "mic", 200, 250),
    false
  );
});
