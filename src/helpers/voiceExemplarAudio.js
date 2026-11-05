const { createHash } = require("node:crypto");
const crypto = require("./secretCrypto");

// This store belongs to a person, never a note or a recording. Ciphertext lives
// in the same SQLite transaction as consent; there are no external blob files.
function open(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_exemplar_audio (
      id TEXT PRIMARY KEY,
      profile_id INTEGER NOT NULL REFERENCES speaker_profiles(id) ON DELETE CASCADE,
      note_id INTEGER NOT NULL,
      note_identity TEXT,
      note_title TEXT NOT NULL,
      row_ids TEXT NOT NULL,
      revision TEXT NOT NULL,
      track TEXT NOT NULL,
      start_sample INTEGER NOT NULL,
      end_sample INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      codec TEXT NOT NULL,
      sample_rate INTEGER NOT NULL,
      meeting_date TEXT,
      approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      content_hash TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      embedding BLOB NOT NULL,
      valid INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_voice_exemplar_audio_person_row
      ON voice_exemplar_audio(profile_id, note_id, row_ids, revision);
  `);
}

function repair(db) {
  db.exec(`CREATE TRIGGER IF NOT EXISTS invalidate_deleted_exemplar_audio
    AFTER DELETE ON voice_exemplar_audio BEGIN
      UPDATE speaker_profiles SET embedding = x'', sample_count = 0,
        voice_usable = 0, voice_needs_reapproval = 1 WHERE id = OLD.profile_id;
    END;
  `);
  sweepOrphans(db);
}

function sweepOrphans(db) {
  // Also repairs imports made with foreign_keys disabled. Deleting the row
  // deletes its encrypted blob atomically, including after an interrupted erase.
  return db
    .prepare(
      `DELETE FROM voice_exemplar_audio
    WHERE NOT EXISTS (SELECT 1 FROM speaker_profiles WHERE id = profile_id)`
    )
    .run().changes;
}

function list(db, profileId = null) {
  return db
    .prepare(
      `SELECT id, profile_id, note_id, note_identity, note_title, row_ids,
    revision, track, start_sample, end_sample, duration_ms, byte_length, codec, sample_rate,
    meeting_date, approved_at, created_at, content_hash, embedding, valid, 1 AS durable_audio
    FROM voice_exemplar_audio${profileId == null ? "" : " WHERE profile_id = ?"}
    ORDER BY approved_at, id`
    )
    .all(...(profileId == null ? [] : [profileId]));
}

function seal(store, bytes) {
  try {
    return (store.encryption || crypto).encryptBytes(bytes);
  } catch {
    const error = new Error("Exemplar encryption key unavailable");
    error.code = "exemplar_key_unavailable";
    throw error;
  }
}

function save(db, candidate, bytes, ciphertext, embedding) {
  const identity = db
    .prepare("SELECT client_note_id FROM notes WHERE id = ?")
    .get(candidate.noteId);
  db.prepare(
    `INSERT INTO voice_exemplar_audio
    (id, profile_id, note_id, note_identity, note_title, row_ids, revision, track, start_sample,
     end_sample, duration_ms, byte_length, codec, sample_rate, meeting_date,
     content_hash, ciphertext, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    candidate.id,
    candidate.profileId,
    candidate.noteId,
    identity?.client_note_id || null,
    candidate.noteTitle || "",
    JSON.stringify(candidate.rowIds),
    candidate.revision,
    candidate.track,
    candidate.startSample,
    candidate.endSample,
    Math.round(candidate.durationSeconds * 1000),
    bytes.length,
    "audio/wav; codecs=pcm_s16le",
    24000,
    candidate.meetingDate,
    createHash("sha256").update(bytes).digest("hex"),
    ciphertext,
    embedding
  );
}

function play(db, store, id) {
  const sample = db.prepare("SELECT * FROM voice_exemplar_audio WHERE id = ?").get(id);
  if (!sample) return null;
  try {
    const wav = (store.encryption || crypto).decryptBytes(sample.ciphertext);
    if (
      wav.length !== sample.byte_length ||
      createHash("sha256").update(wav).digest("hex") !== sample.content_hash
    )
      return { state: "unavailable", error: "exemplar_integrity_failed" };
    return {
      state: "available",
      wav,
      durationSeconds: sample.duration_ms / 1000,
      source: "exemplar",
    };
  } catch {
    return { state: "key_unavailable", error: "exemplar_key_unavailable" };
  }
}

function scrubVectorSnapshots(db) {
  function scrub(value) {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (key === "embedding") value[key] = "";
      else if (["embeddingBefore", "noteEmbeddings", "exemplars"].includes(key)) value[key] = [];
      else if (key === "sample_count") value[key] = 0;
      else scrub(value[key]);
    }
  }
  for (const table of [
    "voice_sample_action_snapshots",
    "speaker_voice_clear_actions",
    "speaker_person_voice_actions",
    "person_identity_actions",
  ]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
      continue;
    for (const row of db.prepare(`SELECT id, snapshot FROM ${table}`).all()) {
      const snapshot = JSON.parse(row.snapshot);
      scrub(snapshot);
      db.prepare(`UPDATE ${table} SET snapshot = ? WHERE id = ?`).run(
        JSON.stringify(snapshot),
        row.id
      );
    }
  }
  for (const note of db
    .prepare("SELECT id, speaker_action_log FROM notes WHERE speaker_action_log IS NOT NULL")
    .all()) {
    let log;
    try {
      log = JSON.parse(note.speaker_action_log);
    } catch {
      continue;
    }
    scrub(log);
    db.prepare("UPDATE notes SET speaker_action_log = ? WHERE id = ?").run(
      JSON.stringify(log),
      note.id
    );
  }
  db.prepare("UPDATE voice_enrollment_actions SET before_sample = NULL").run();
  db.prepare(
    `UPDATE speaker_global_actions SET unavailable_reason = 'voice_data_cleared'
    WHERE kind = 'enrollment'`
  ).run();
}

module.exports = { open, repair, list, seal, save, play, sweepOrphans, scrubVectorSnapshots };
