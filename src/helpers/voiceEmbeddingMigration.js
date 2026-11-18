const { createHash } = require("node:crypto");
const { EMBEDDING_DIM, EMBEDDING_VERSION } = require("../constants/speakerDetection.json");

// Append attempts rather than overwriting consent, provenance or action history.
// No PCM or identity inferred from display names is ever stored here.
function open(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS voice_embedding_migrations (
    id INTEGER PRIMARY KEY,
    sample_id TEXT NOT NULL REFERENCES voice_exemplar_audio(id) ON DELETE CASCADE,
    profile_id INTEGER NOT NULL REFERENCES speaker_profiles(id) ON DELETE CASCADE,
    target_version INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    old_vector_hash TEXT NOT NULL,
    new_vector_hash TEXT,
    state TEXT NOT NULL,
    reason TEXT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  )`);
}
const hash = (bytes) =>
  createHash("sha256")
    .update(bytes || Buffer.alloc(0))
    .digest("hex");

async function migrate(database, store, { extractor, cancelled = () => false } = {}) {
  const db = database.db;
  const enrollment = require("./voiceEnrollment");
  const audio = require("./voiceExemplarAudio");
  const { pcmIdentity, classifyEvidence } = require("./voiceRecordingIdentity");
  const { durationMatches } = require("./voiceAudioIntegrity");
  const people = new Set();
  // IDs only: decrypt one independent exemplar at a time. A restart retries an
  // interrupted/failed attempt from the retained ciphertext, never a partial vector.
  const ids = db
    .prepare(
      `SELECT a.id FROM voice_exemplar_audio a WHERE length(a.embedding)!=?
    OR EXISTS (SELECT 1 FROM voice_embedding_migrations m WHERE m.sample_id=a.id
      AND m.target_version=? AND m.state!='migrated'
      AND m.id=(SELECT MAX(id) FROM voice_embedding_migrations WHERE sample_id=a.id))
    ORDER BY a.id`
    )
    .all(EMBEDDING_DIM * 4, EMBEDDING_VERSION);
  for (const { id } of ids) {
    if (cancelled()) break;
    const sample = db
      .prepare("SELECT *, 1 AS durable_audio FROM voice_exemplar_audio WHERE id=?")
      .get(id);
    if (!sample) continue;
    people.add(sample.profile_id);
    const attempt = db.transaction(() => {
      const attemptId = db
        .prepare(
          `INSERT INTO voice_embedding_migrations
        (sample_id, profile_id, target_version, content_hash, approved_at, old_vector_hash, state)
        VALUES (?, ?, ?, ?, ?, ?, 'started')`
        )
        .run(
          id,
          sample.profile_id,
          EMBEDDING_VERSION,
          sample.content_hash,
          sample.approved_at,
          hash(sample.embedding)
        ).lastInsertRowid;
      // Derived caches are disposable; no half-migrated profile can be used.
      db.prepare(
        "UPDATE speaker_profiles SET embedding=x'', embedding_version=NULL, sample_count=0, voice_usable=0 WHERE id=?"
      ).run(sample.profile_id);
      return attemptId;
    })();
    let reason = null;
    let embedding;
    try {
      const played = audio.play(db, store, id);
      if (played?.state !== "available") throw new Error(played?.error || "clip_unavailable");
      if (sample.valid === 0) throw new Error("evidence_invalidated");
      if (sample.sample_rate !== 24000 || sample.codec !== "audio/wav; codecs=pcm_s16le")
        throw new Error("unsupported_audio_format");
      pcmIdentity(played.wav);
      if (
        !durationMatches((played.wav.length - 44) / 48, sample.end_sample - sample.start_sample) ||
        !durationMatches(sample.duration_ms, sample.end_sample - sample.start_sample)
      )
        throw new Error("source_integrity_failed");
      if (classifyEvidence(db, sample).state !== "resolved")
        throw new Error("unresolved_provenance");
      embedding = await enrollment.embed(played.wav, extractor || require("./speakerEmbeddings"));
      if (!embedding) throw new Error("unusable_embedding");
    } catch (error) {
      reason = error.code || error.message;
    }
    if (cancelled()) break;
    db.transaction(() => {
      // Consent, ownership, source or approval can change during extraction.
      const current = db.prepare("SELECT * FROM voice_exemplar_audio WHERE id=?").get(id);
      if (
        !current ||
        [
          "profile_id",
          "approved_at",
          "content_hash",
          "valid",
          "note_identity",
          "recording_id",
          "track",
          "start_sample",
          "end_sample",
        ].some((key) => current[key] !== sample[key]) ||
        !current.ciphertext.equals(sample.ciphertext) ||
        !current.embedding.equals(sample.embedding)
      ) {
        db.prepare(
          "UPDATE voice_embedding_migrations SET state='cancelled', reason='evidence_changed', completed_at=CURRENT_TIMESTAMP WHERE id=?"
        ).run(attempt);
        return;
      }
      if (!reason) {
        const bytes = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        db.prepare("UPDATE voice_exemplar_audio SET embedding=? WHERE id=?").run(bytes, id);
        db.prepare(
          "UPDATE voice_exemplars SET embedding=? WHERE id=? AND profile_id=? AND approved_at=?"
        ).run(bytes, id, sample.profile_id, sample.approved_at);
        db.prepare(
          "UPDATE voice_embedding_migrations SET state='migrated', new_vector_hash=?, completed_at=CURRENT_TIMESTAMP WHERE id=?"
        ).run(hash(bytes), attempt);
      } else {
        db.prepare(
          "UPDATE voice_embedding_migrations SET state='not_enrolled', reason=?, completed_at=CURRENT_TIMESTAMP WHERE id=?"
        ).run(reason, attempt);
      }
      // Do not create a sticky reapproval flag from migration failure; a future
      // retry may succeed. Existing human review flags retain their precedence.
      const { result, embedding: profile } = enrollment.resolveProfile(db, sample.profile_id);
      db.prepare(
        "UPDATE speaker_profiles SET embedding=?, embedding_version=?, sample_count=?, voice_usable=? WHERE id=?"
      ).run(
        profile,
        profile.length ? EMBEDDING_VERSION : null,
        result.cleanSpans,
        Number(result.usable),
        sample.profile_id
      );
    })();
    store.onChanged?.({ noteId: sample.note_id, voiceMigration: true });
    await new Promise((resolve) => setImmediate(resolve));
  }
  return [...people].map((profileId) => ({
    profileId,
    ...enrollment.progress(database, profileId),
  }));
}

module.exports = { open, migrate };
