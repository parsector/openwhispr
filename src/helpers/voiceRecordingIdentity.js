const { readTranscriptDocument } = require("./transcriptDocument");

// Numeric note IDs can be reused. Prefer the recording UUID, then the immutable
// client note ID for evidence predating recording UUIDs.
function recordingIdentity(db, sample, status = null, currentNote = null) {
  if (sample.recording_id) return `recording:${sample.recording_id}`;
  const note =
    currentNote ||
    db.prepare("SELECT client_note_id, transcript FROM notes WHERE id = ?").get(sample.note_id);
  const sameNote = note && (!sample.note_identity || sample.note_identity === note.client_note_id);
  if (sameNote) {
    if (status?.recordingId != null) return `recording:${status.recordingId}`;
    const sibling =
      note.client_note_id &&
      db
        .prepare(
          `SELECT recording_id FROM voice_exemplar_audio
      WHERE note_identity = ? AND recording_id IS NOT NULL LIMIT 1`
        )
        .get(note.client_note_id);
    if (sibling) return `recording:${sibling.recording_id}`;
    const ids = new Set(
      readTranscriptDocument(note.transcript)
        .rows.map((row) => row.audioSpan?.recordingId)
        .filter((id) => typeof id === "string")
    );
    if (ids.size === 1) return `recording:${[...ids][0]}`;
  }
  return `note:${sample.note_identity || (sameNote && note.client_note_id) || sample.note_id}`;
}

function overlapsRecording(db, sample, note, status, track, start, end) {
  const sameNote =
    sample.note_id === note.id &&
    (!sample.note_identity || sample.note_identity === note.client_note_id);
  return (
    sample.track === track &&
    sample.start_sample < end &&
    sample.end_sample > start &&
    recordingIdentity(db, sample, sameNote ? status : null) ===
      recordingIdentity(
        db,
        {
          note_id: note.id,
          note_identity: note.client_note_id,
        },
        status,
        note
      )
  );
}

function rememberRecording(db, note, status) {
  if (typeof status.recordingId !== "string") return;
  db.prepare(
    `UPDATE voice_exemplars SET recording_id = ?
    WHERE note_id = ? AND recording_id IS NULL`
  ).run(status.recordingId, note.id);
  db.prepare(
    `UPDATE voice_exemplar_audio SET recording_id = ?
    WHERE note_identity = ? AND recording_id IS NULL`
  ).run(status.recordingId, note.client_note_id);
}

module.exports = { recordingIdentity, overlapsRecording, rememberRecording };
