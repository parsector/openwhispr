const { readTranscriptDocument } = require("./transcriptDocument");

// Numeric note IDs can be reused, and a note is not proof of a distinct recording.
// Unresolved provenance is explicit and cannot establish recording diversity.
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
  return null;
}

function overlapsRecording(db, sample, note, status, track, start, end) {
  const sameNote =
    sample.note_id === note.id &&
    (!sample.note_identity || sample.note_identity === note.client_note_id);
  const sampleRecording = recordingIdentity(db, sample, sameNote ? status : null);
  const currentRecording = recordingIdentity(
    db,
    { note_id: note.id, note_identity: note.client_note_id },
    status,
    note
  );
  return (
    sample.track === track &&
    sample.start_sample < end &&
    sample.end_sample > start &&
    ((sampleRecording !== null && sampleRecording === currentRecording) ||
      (sampleRecording === null && currentRecording === null && sameNote))
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
