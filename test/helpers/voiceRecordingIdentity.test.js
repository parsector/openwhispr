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

test("upgrading the provenance check preserves classifications and accepts recovery_failed", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE speaker_profiles (id INTEGER PRIMARY KEY);
    CREATE TABLE voice_evidence_provenance (
      sample_id TEXT PRIMARY KEY, profile_id INTEGER REFERENCES speaker_profiles(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('resolved', 'pending_recovery', 'unrecoverable')),
      recording_id TEXT, reason TEXT);
    INSERT INTO voice_evidence_provenance VALUES ('old', NULL, 'resolved', 'genuine', NULL)`);
  open(db);
  open(db);
  assert.deepEqual(classifyEvidence(db, { id: "old" }), {
    state: "resolved",
    recordingId: "genuine",
  });
  db.prepare(
    `INSERT INTO voice_evidence_provenance (sample_id, state, reason, recovery_attempts)
    VALUES ('failed', 'recovery_failed', 'decoder_timeout', 3)`
  ).run();
  assert.deepEqual(classifyEvidence(db, { id: "failed" }, { record: true }), {
    state: "recovery_failed",
    reason: "decoder_timeout",
  });
});

test("fifth run: migration preserves fourth-run identity pins and retry budgets", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE speaker_profiles (id INTEGER PRIMARY KEY);
    CREATE TABLE voice_evidence_provenance (
      sample_id TEXT PRIMARY KEY, profile_id INTEGER,
      state TEXT CHECK (state IN ('resolved', 'pending_recovery', 'unrecoverable', 'recovery_failed')),
      recording_id TEXT, reason TEXT, recovery_attempts INTEGER DEFAULT 0,
      recovery_next_at INTEGER DEFAULT 0, recovery_recording_id TEXT);
    INSERT INTO voice_evidence_provenance VALUES ('pending', NULL, 'pending_recovery', NULL, 'audio_key_unavailable', 2, 123456, 'pinned');
    INSERT INTO voice_evidence_provenance VALUES ('resolved', NULL, 'resolved', 'genuine', NULL, 0, 0, NULL)`);
  const before = db.prepare("SELECT * FROM voice_evidence_provenance ORDER BY sample_id").all();
  open(db);
  open(db);
  const after = db.prepare("SELECT * FROM voice_evidence_provenance ORDER BY sample_id").all();
  for (let i = 0; i < before.length; i++) {
    for (const [name, value] of Object.entries(after[i]))
      assert.equal(value, Object.hasOwn(before[i], name) ? before[i][name] : null, name);
  }
});

test("sixth run: migration reopens disk-hash refusals once and preserves PCM pins and expiry", (t) => {
  const { db } = fixture(t);
  for (const column of [
    "recovery_pcm_hash",
    "recovery_track",
    "recovery_start_sample",
    "recovery_end_sample",
    "recovery_note_identity",
    "recovery_codec",
    "recovery_sample_rate",
    "recovery_duration_ms",
    "recovery_expires_at",
  ])
    db.exec(`ALTER TABLE voice_evidence_provenance DROP COLUMN ${column}`);
  db.prepare(
    `INSERT INTO voice_evidence_provenance
    (sample_id, state, reason, recovery_state, recovery_reason, recovery_recording_id, recovery_content_hash, recovery_attempts)
    VALUES ('old-refusal', 'recovery_failed', 'recording_content_mismatch', 'recovery_failed',
      'recording_content_mismatch', ?, 'diagnostic-only', 3)`
  ).run(uuid);
  open(db);
  const reopened = db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id='old-refusal'")
    .get();
  assert.equal(reopened.state, "pending_recovery");
  assert.equal(reopened.recovery_attempts, 0);
  assert.equal(reopened.recovery_recording_id, uuid);
  assert.equal(reopened.recovery_content_hash, "diagnostic-only");
  db.prepare(
    `UPDATE voice_evidence_provenance SET recovery_pcm_hash='approved-pcm',
    recovery_expires_at=12345, recovery_attempts=1 WHERE sample_id='old-refusal'`
  ).run();
  const pinned = db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id='old-refusal'")
    .get();
  open(db);
  assert.deepEqual(
    db.prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id='old-refusal'").get(),
    pinned
  );
});
