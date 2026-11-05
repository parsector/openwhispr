const { createHash } = require("node:crypto");
const { durationMatches, integrityError } = require("./voiceAudioIntegrity");

// Provenance belongs to an approval, independently of notes and undo snapshots.
// Only approval and startup recovery record it. Readers never repair it from
// cached recording_id columns, status IDs, sibling samples or transcript spans.
function open(db) {
  const prior = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'voice_evidence_provenance'")
    .get();
  if (prior && !prior.sql.includes("recovery_failed"))
    db.transaction(() => {
      db.exec("ALTER TABLE voice_evidence_provenance RENAME TO voice_evidence_provenance_old");
      open(db);
      db.exec(`INSERT INTO voice_evidence_provenance (sample_id, profile_id, state, recording_id, reason)
      SELECT sample_id, profile_id, state, recording_id, reason FROM voice_evidence_provenance_old;
      DROP TABLE voice_evidence_provenance_old`);
    })();
  db.exec(`CREATE TABLE IF NOT EXISTS voice_evidence_provenance (
    sample_id TEXT PRIMARY KEY,
    profile_id INTEGER REFERENCES speaker_profiles(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('resolved', 'pending_recovery', 'unrecoverable', 'recovery_failed')),
    recording_id TEXT,
    reason TEXT,
    recovery_attempts INTEGER NOT NULL DEFAULT 0,
    recovery_next_at INTEGER NOT NULL DEFAULT 0,
    recovery_recording_id TEXT,
    recovery_content_hash TEXT,
    recovery_state TEXT,
    recovery_reason TEXT,
    CHECK ((state = 'resolved' AND recording_id IS NOT NULL) OR
           (state != 'resolved' AND recording_id IS NULL))
  )`);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(voice_evidence_provenance)")
      .all()
      .map((c) => c.name)
  );
  for (const name of ["recovery_content_hash", "recovery_state", "recovery_reason"])
    if (!columns.has(name))
      db.exec(`ALTER TABLE voice_evidence_provenance ADD COLUMN ${name} TEXT`);
  db.transaction(() => {
    for (const [name, type] of Object.entries({
      recovery_pcm_hash: "TEXT",
      recovery_track: "TEXT",
      recovery_start_sample: "INTEGER",
      recovery_end_sample: "INTEGER",
      recovery_note_identity: "TEXT",
      recovery_codec: "TEXT",
      recovery_sample_rate: "INTEGER",
      recovery_duration_ms: "INTEGER",
      recovery_expires_at: "INTEGER",
      recovery_pcm_trust: "TEXT",
      recovery_untrusted_pcm_hash: "TEXT",
      recovery_untrusted_duration_ms: "INTEGER",
      recovery_pcm_corrected_at: "INTEGER",
    }))
      if (!columns.has(name))
        db.exec(`ALTER TABLE voice_evidence_provenance ADD COLUMN ${name} ${type}`);
    // A disk-byte mismatch was never evidence of different audio. Retry these
    // historical refusals once under PCM verification; do not reset other budgets.
    if (!columns.has("recovery_pcm_hash"))
      db.exec(`UPDATE voice_evidence_provenance SET
      state=CASE WHEN state='resolved' THEN state ELSE 'pending_recovery' END,
      reason=CASE WHEN state='resolved' THEN reason ELSE NULL END,
      recovery_state='pending_recovery', recovery_reason=NULL,
      recovery_attempts=0, recovery_next_at=0
      WHERE reason='recording_content_mismatch' OR recovery_reason='recording_content_mismatch'`);
  })();
}

// The store emits canonical mono s16le/24 kHz WAVs. Hash only their PCM data,
// never the container header, source codec, chunk boundaries or encryption.
function pcmIdentity(bytes) {
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 16) !== "WAVEfmt " ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== 24000 ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString("ascii", 36, 40) !== "data" ||
    bytes.readUInt32LE(40) !== bytes.length - 44 ||
    (bytes.length - 44) % 2
  )
    throw new Error("Expected canonical enrollment PCM WAV");
  return createHash("sha256").update(bytes.subarray(44)).digest("hex");
}

function pinAudio(db, sample, source, bytes, hash) {
  // Guard every caller, including fresh approvals, before computing a digest.
  if (!durationMatches((bytes.length - 44) / 48, sample.end_sample - sample.start_sample))
    throw integrityError();
  hash ??= pcmIdentity(bytes);
  db.prepare(
    `UPDATE voice_evidence_provenance SET
    recovery_pcm_hash=COALESCE(recovery_pcm_hash, ?),
    recovery_recording_id=COALESCE(recovery_recording_id, ?),
    recovery_track=COALESCE(recovery_track, ?),
    recovery_start_sample=COALESCE(recovery_start_sample, ?),
    recovery_end_sample=COALESCE(recovery_end_sample, ?),
    recovery_note_identity=COALESCE(recovery_note_identity, ?),
    recovery_codec=COALESCE(recovery_codec, ?),
    recovery_sample_rate=COALESCE(recovery_sample_rate, 24000),
    recovery_duration_ms=COALESCE(recovery_duration_ms, ?),
    recovery_pcm_corrected_at=CASE WHEN recovery_pcm_trust='untrusted' THEN ? ELSE recovery_pcm_corrected_at END,
    recovery_pcm_trust=CASE WHEN recovery_pcm_trust='untrusted' THEN 'corrected' ELSE recovery_pcm_trust END
    WHERE sample_id=?`
  ).run(
    hash,
    source.recordingId,
    sample.track,
    sample.start_sample,
    sample.end_sample,
    source.noteIdentity || null,
    source.tracks?.[sample.track]?.codec || "audio/ogg; codecs=opus",
    (bytes.length - 44) / 48,
    Date.now(),
    sample.id
  );
}

function validSource(manifest, sample) {
  return Boolean(
    manifest &&
    manifest.noteId === sample.note_id &&
    (!sample.note_identity || manifest.noteIdentity === sample.note_identity) &&
    ["complete", "incomplete"].includes(manifest.status) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      manifest.recordingId || ""
    ) &&
    (manifest.hasSourceAudio === true ||
      Object.values(manifest.tracks || {}).some((track) => track.chunks?.length > 0))
  );
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
      : { state: saved.state, reason: saved.reason };

  let result = { state: "pending_recovery" };
  // Candidates have no approved sample ID. Classifying one for a scan cannot
  // promote an existing approval. Approval rechecks the manifest in transaction.
  if (record || !sample.id) {
    const manifest = store?.recordingProvenance?.(sample.note_id);
    if (unavailable) result = { state: "unrecoverable", reason: unavailable };
    else if (validSource(manifest, sample))
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

module.exports = { open, classifyEvidence, overlapsRecording, validSource, pcmIdentity, pinAudio };
