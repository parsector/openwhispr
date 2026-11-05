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
      recording_id TEXT,
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
  if (
    !db
      .prepare("PRAGMA table_info(voice_exemplar_audio)")
      .all()
      .some((column) => column.name === "recording_id")
  )
    db.exec("ALTER TABLE voice_exemplar_audio ADD COLUMN recording_id TEXT");
}

function repair(db) {
  db.exec(`CREATE TRIGGER IF NOT EXISTS invalidate_deleted_exemplar_audio
    AFTER DELETE ON voice_exemplar_audio BEGIN
      UPDATE speaker_profiles SET embedding = x'', sample_count = 0,
        voice_usable = 0, voice_needs_reapproval = 1 WHERE id = OLD.profile_id;
    END;
  `);
  sweepOrphans(db);
  // c42ba9e09 made durable removals irreversible but retained before_sample and
  // older vector snapshots. Repair only removals explicitly marked as erased;
  // reversible legacy-vector removals retain their undo data.
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_global_actions'"
      )
      .get()
  )
    return;
  db.transaction(() => {
    const removals = db
      .prepare(
        `SELECT a.candidate_id, a.profile_id
      FROM voice_enrollment_actions a JOIN speaker_global_actions h ON h.id = a.id
      WHERE a.choice = 'remove' AND a.before_sample IS NOT NULL
        AND h.unavailable_reason = 'voice_data_cleared'`
      )
      .all();
    for (const row of removals)
      scrubVectorSnapshots(db, { profileIds: [row.profile_id], sampleIds: [row.candidate_id] });
  })();
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
      `SELECT id, profile_id, note_id, note_identity, recording_id, note_title, row_ids,
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
    (id, profile_id, note_id, note_identity, recording_id, note_title, row_ids, revision, track, start_sample,
     end_sample, duration_ms, byte_length, codec, sample_rate, meeting_date,
     content_hash, ciphertext, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    candidate.id,
    candidate.profileId,
    candidate.noteId,
    identity?.client_note_id || null,
    candidate.recordingId ?? null,
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

function scrubVectorSnapshots(db, scope = null) {
  const profileIds = new Set(scope?.profileIds || []);
  const sampleIds = new Set(
    scope?.sampleIds ||
      (scope
        ? list(db)
            .filter((sample) => profileIds.has(sample.profile_id))
            .map((sample) => sample.id)
        : [])
  );
  const erasedEmbedding = (row) =>
    !scope ||
    (scope.noteEmbeddings || []).some(
      (item) => item.note_id === row.note_id && item.speaker_id === row.speaker_id
    );
  const snapshotsExist = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'voice_sample_action_snapshots'"
    )
    .get();
  // A merged person's historical snapshots still carry their original owner.
  // Clip links cover individual removals; person merge links also cover legacy
  // profiles with no durable clip, including chains of merges in either UI path.
  if (scope && snapshotsExist)
    for (const row of db.prepare("SELECT snapshot FROM voice_sample_action_snapshots").all())
      for (const sample of JSON.parse(row.snapshot).audioOwnership || [])
        if (sampleIds.has(sample.id)) profileIds.add(sample.profile_id);
  if (scope && scope.sampleIds == null) {
    const merges = [];
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'person_identity_actions'"
        )
        .get()
    )
      merges.push(
        ...db
          .prepare(
            "SELECT profile_id AS source, survivor_id AS survivor FROM person_identity_actions WHERE action = 'merge'"
          )
          .all()
      );
    for (const note of db
      .prepare("SELECT speaker_action_log FROM notes WHERE speaker_action_log IS NOT NULL")
      .all()) {
      let log;
      try {
        log = require("./speakerActionLog").readSpeakerActionLog(note);
      } catch {
        continue;
      }
      for (const action of Array.isArray(log.actions) ? log.actions : [])
        if (action.kind === "person" && action.action === "merge")
          merges.push({ source: action.profileId, survivor: action.survivorId });
    }
    let changed;
    do {
      changed = false;
      for (const merge of merges)
        if (profileIds.has(merge.survivor) && !profileIds.has(merge.source)) {
          profileIds.add(merge.source);
          changed = true;
        }
    } while (changed);
  }
  function scrub(value, owner = null) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) scrub(item, owner);
      return;
    }
    owner =
      value.profile_id ??
      value.profileId ??
      ("sample_count" in value || "display_name" in value ? value.id : owner);
    const affected = !scope || profileIds.has(owner);
    for (const key of Object.keys(value)) {
      if (key === "embedding" && (affected || sampleIds.has(value.id) || erasedEmbedding(value)))
        value[key] = "";
      else if (["embeddingBefore", "noteEmbeddings"].includes(key))
        value[key] = affected ? [] : value[key].filter((row) => !erasedEmbedding(row));
      else if (key === "exemplars")
        value[key] = value[key].filter(
          (row) =>
            scope &&
            !sampleIds.has(row.id) &&
            !(scope.sampleIds == null && profileIds.has(row.profile_id))
        );
      else if (key === "sample_count" && affected) value[key] = 0;
      else if (["voice_usable", "voice_needs_reapproval"].includes(key) && affected) value[key] = 0;
      else if (key === "survivorBefore") scrub(value[key], value.mergedInto);
      else scrub(value[key], owner);
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
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      const snapshot = JSON.parse(row.snapshot);
      scrub(snapshot, row.profile_id);
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
  for (const action of db
    .prepare("SELECT id, candidate_id, profile_id, before_sample FROM voice_enrollment_actions")
    .all()) {
    if (
      scope &&
      !sampleIds.has(action.candidate_id) &&
      !(scope.sampleIds == null && profileIds.has(action.profile_id))
    )
      continue;
    db.prepare("UPDATE voice_enrollment_actions SET before_sample = NULL WHERE id = ?").run(
      action.id
    );
    db.prepare(
      "UPDATE speaker_global_actions SET unavailable_reason = 'voice_data_cleared' WHERE id = ?"
    ).run(action.id);
  }
}

module.exports = { open, repair, list, seal, save, play, sweepOrphans, scrubVectorSnapshots };
