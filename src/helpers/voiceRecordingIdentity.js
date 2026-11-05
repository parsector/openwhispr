// Provenance belongs to an approval, independently of notes and undo snapshots.
// Only approval and startup recovery record it. Readers never repair it from
// cached recording_id columns, status IDs, sibling samples or transcript spans.
function open(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS voice_evidence_provenance (
    sample_id TEXT PRIMARY KEY,
    profile_id INTEGER REFERENCES speaker_profiles(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('resolved', 'pending_recovery', 'unrecoverable')),
    recording_id TEXT,
    reason TEXT,
    CHECK ((state = 'resolved' AND recording_id IS NOT NULL) OR
           (state != 'resolved' AND recording_id IS NULL))
  )`);
}

function classifyEvidence(db, sample, { store = null, record = false, unavailable = null } = {}) {
  const saved =
    sample.id &&
    db
      .prepare(
        "SELECT state, recording_id, reason FROM voice_evidence_provenance WHERE sample_id = ?"
      )
      .get(sample.id);
  if (saved && saved.state !== "pending_recovery")
    return saved.state === "resolved"
      ? { state: "resolved", recordingId: saved.recording_id }
      : { state: "unrecoverable", reason: saved.reason };

  let result = { state: "pending_recovery" };
  // Candidates have no approved sample ID. Classifying one for a scan cannot
  // promote an existing approval. Approval rechecks the manifest in transaction.
  if (record || !sample.id) {
    const manifest = store?.recordingProvenance?.(sample.note_id);
    if (unavailable) result = { state: "unrecoverable", reason: unavailable };
    else if (
      manifest &&
      manifest.noteId === sample.note_id &&
      (!sample.note_identity || manifest.noteIdentity === sample.note_identity) &&
      ["complete", "incomplete"].includes(manifest.status) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        manifest.recordingId || ""
      ) &&
      Object.values(manifest.tracks || {}).some((track) => track.chunks?.length > 0)
    )
      result = { state: "resolved", recordingId: manifest.recordingId };
  }
  if (record && sample.id)
    db.prepare(
      `INSERT INTO voice_evidence_provenance (sample_id, profile_id, state, recording_id, reason)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(sample_id) DO UPDATE SET
      state = excluded.state, recording_id = excluded.recording_id, reason = excluded.reason
      WHERE voice_evidence_provenance.state = 'pending_recovery'`
    ).run(
      sample.id,
      sample.profile_id ?? null,
      result.state,
      result.recordingId || null,
      result.reason || null
    );
  return result;
}

function overlapsRecording(db, sample, note, store, track, start, end) {
  const prior = classifyEvidence(db, sample);
  const current = classifyEvidence(
    db,
    { note_id: note.id, note_identity: note.client_note_id },
    { store }
  );
  const sameNote =
    sample.note_id === note.id &&
    (!sample.note_identity || sample.note_identity === note.client_note_id);
  return (
    sample.track === track &&
    sample.start_sample < end &&
    sample.end_sample > start &&
    ((prior.state === "resolved" &&
      current.state === "resolved" &&
      prior.recordingId === current.recordingId) ||
      (prior.state !== "resolved" && sameNote))
  );
}

module.exports = { open, classifyEvidence, overlapsRecording };
