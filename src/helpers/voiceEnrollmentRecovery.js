const exemplarAudio = require("./voiceExemplarAudio");
const { classifyEvidence, validSource } = require("./voiceRecordingIdentity");
const debugLogger = require("./debugLogger");

// A small page of IDs, never a library of WAVs or ciphertext. Backoff and
// attempts survive process exit; the queue and AbortController are disposable.
const sources = `SELECT e.id, e.note_id, e.profile_id, 0 AS durable_audio FROM voice_exemplars e
  WHERE e.approved_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM voice_exemplar_audio a WHERE a.id = e.id)
  UNION ALL SELECT a.id, a.note_id, a.profile_id, 1 AS durable_audio FROM voice_exemplar_audio a`;
const pending = `(p.state IS NULL OR p.state = 'pending_recovery' OR
  (p.state = 'resolved' AND s.durable_audio = 0 AND
    COALESCE(p.recovery_state, 'pending_recovery') = 'pending_recovery'))`;

function start(
  database,
  store,
  { passLimit = 25, yieldMs = 10, maxAttempts = 3, retryBaseMs = 1000 } = {}
) {
  // Clamp injected settings as well as defaults: no unbounded pass or retry loop.
  passLimit = Math.max(1, Math.min(100, Math.floor(passLimit) || 25));
  maxAttempts = Math.max(1, Math.min(10, Math.floor(maxAttempts) || 3));
  yieldMs = Math.max(1, Math.min(1000, yieldMs || 10));
  retryBaseMs = Math.max(1, Math.min(60000, retryBaseMs || 1000));
  const db = database.db;
  const abort = new AbortController();
  const released = new Set();
  let cancelled = false;
  let finished = false;
  let timer;
  let finish;
  let cursor = "";
  let initial = true;
  let page = [];
  // Retry deadlines use wall time, independently of recording retention's clock.
  const now = Date.now;
  const report = {
    recovered: 0,
    unrecoverable: 0,
    recoveryFailed: 0,
    resolved: 0,
    attempted: 0,
    passes: 0,
    maxPassItems: 0,
    failures: [],
  };
  const activeSources = () =>
    db
      .prepare(
        `SELECT s.*, p.state FROM (${sources}) s
    LEFT JOIN voice_evidence_provenance p ON p.sample_id = s.id WHERE ${pending}`
      )
      .all();
  Object.defineProperties(report, {
    pendingRecovery: {
      enumerable: true,
      get: () => (cancelled ? 0 : activeSources().filter((s) => s.state !== "resolved").length),
    },
    deferredNotes: {
      enumerable: true,
      get: () =>
        cancelled || finished
          ? []
          : [
              ...new Set(
                activeSources()
                  .filter((s) => !released.has(s.id))
                  .map((s) => s.note_id)
              ),
            ],
    },
    protects: {
      value: (noteId) => {
        if (cancelled || finished) return false;
        for (const sample of db
          .prepare(
            `SELECT s.id
      FROM (${sources}) s LEFT JOIN voice_evidence_provenance p ON p.sample_id = s.id
      WHERE s.note_id = ? AND ${pending}`
          )
          .iterate(noteId)) {
          if (!released.has(sample.id)) return true;
        }
        return false;
      },
    },
    done: {
      value: new Promise((resolve) => {
        finish = resolve;
      }),
    },
    cancel: {
      value: () => {
        if (finished || cancelled) return;
        cancelled = true;
        clearTimeout(timer);
        abort.abort();
        finish(report);
      },
    },
  });
  function schedule(delay = yieldMs) {
    timer = setTimeout(step, delay);
  }
  function complete() {
    finished = true;
    try {
      store.enforce();
      debugLogger.info("Legacy voice recovery", report, "voice-enrollment");
    } finally {
      finish(report);
    }
  }
  function retry(sample, reason) {
    const saved = db
      .prepare("SELECT recovery_attempts FROM voice_evidence_provenance WHERE sample_id = ?")
      .get(sample.id);
    const attempts = (saved?.recovery_attempts || 0) + 1;
    const state = attempts >= maxAttempts ? "recovery_failed" : "pending_recovery";
    const next = now() + Math.min(60000, retryBaseMs * 2 ** (attempts - 1));
    // Keep the pinned identity separately while conversion is pending, so
    // replacement recordings cannot supply bytes on a later retry.
    db.prepare(
      `INSERT INTO voice_evidence_provenance
      (sample_id, profile_id, state, recording_id, reason, recovery_attempts, recovery_next_at, recovery_state, recovery_reason)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?) ON CONFLICT(sample_id) DO UPDATE SET
      state=CASE WHEN voice_evidence_provenance.state = 'resolved' THEN 'resolved' ELSE excluded.state END,
      reason=CASE WHEN voice_evidence_provenance.state = 'resolved' THEN voice_evidence_provenance.reason ELSE excluded.reason END,
      recovery_state=excluded.recovery_state, recovery_reason=excluded.recovery_reason,
      recovery_attempts=excluded.recovery_attempts, recovery_next_at=excluded.recovery_next_at`
    ).run(sample.id, sample.profile_id, state, reason, attempts, next, state, reason);
    // Keep diagnostic memory bounded even on a broken library.
    if (report.failures.length < 100)
      report.failures.push({ sampleId: sample.id, reason, attempts, state });
    if (state === "recovery_failed") {
      report.recoveryFailed++;
    }
  }
  function terminal(sample, reason, failed = false) {
    // Classification is a provenance fact. Losing the conversion source must
    // never erase an already-resolved identity.
    classifyEvidence(db, sample, { record: true, unavailable: reason });
    const state = failed ? "recovery_failed" : "unrecoverable";
    db.prepare(
      `UPDATE voice_evidence_provenance SET
      state=CASE WHEN state = 'resolved' THEN state ELSE ? END,
      recovery_state=?, recovery_reason=? WHERE sample_id=?`
    ).run(state, state, reason, sample.id);
    if (failed) report.recoveryFailed++;
    else report.unrecoverable++;
  }
  async function recover(item) {
    // A queued ID can change ownership while earlier items are decoded.
    const sample =
      db
        .prepare(
          `SELECT id, profile_id, note_id, note_identity, 1 AS durable_audio
      FROM voice_exemplar_audio WHERE id = ?`
        )
        .get(item.id) ||
      db
        .prepare("SELECT * FROM voice_exemplars WHERE id = ? AND approved_at IS NOT NULL")
        .get(item.id);
    if (!sample?.id) {
      return;
    }
    const evidence = classifyEvidence(db, sample);
    if (evidence.state === "unrecoverable" || evidence.state === "recovery_failed") {
      return;
    }
    if (sample.durable_audio) {
      const current = classifyEvidence(db, sample, { store, record: true });
      if (current.state === "resolved") report.resolved++;
      // Only unresolved durable identities need an in-memory release marker.
      // Resolved/terminal records disappear from the protection query directly.
      if (current.state === "pending_recovery") released.add(sample.id);
      return;
    }
    report.attempted++;
    const provenance = db
      .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id = ?")
      .get(sample.id);
    const recordedId = provenance?.recording_id || provenance?.recovery_recording_id;
    if (
      provenance?.recovery_attempts > 0 &&
      ["audio_key_unavailable", "exemplar_key_unavailable", "key_unavailable"].includes(
        provenance.recovery_reason || provenance.reason
      )
    )
      store.encryption.refreshAudioKey?.();
    const source = store.recordingProvenance(sample.note_id, sample);
    if (!source || sample.embedding?.length !== 2048) {
      terminal(sample, "legacy_audio_unavailable");
      return;
    }
    if (!validSource(source, sample) || (recordedId && source.recordingId !== recordedId)) {
      terminal(sample, "recording_identity_mismatch", true);
      return;
    }
    if (
      provenance?.recovery_content_hash &&
      source.contentHash !== provenance.recovery_content_hash
    ) {
      terminal(sample, "recording_content_mismatch", true);
      return;
    }
    // Persist before decoding even when no classification existed on entry.
    // First attempts and retries are bound to the same authenticated bytes.
    db.prepare(
      `INSERT INTO voice_evidence_provenance
      (sample_id, profile_id, state, recovery_recording_id, recovery_content_hash, recovery_state)
      VALUES (?, ?, 'pending_recovery', ?, ?, 'pending_recovery')
      ON CONFLICT(sample_id) DO UPDATE SET
      recovery_recording_id=COALESCE(voice_evidence_provenance.recovery_recording_id, excluded.recovery_recording_id),
      recovery_content_hash=COALESCE(voice_evidence_provenance.recovery_content_hash, excluded.recovery_content_hash),
      recovery_state='pending_recovery'`
    ).run(sample.id, sample.profile_id, source.recordingId, source.contentHash);
    const audio = await store.spanAsync(
      sample.note_id,
      sample.track,
      sample.start_sample / 24000,
      sample.end_sample / 24000,
      { signal: abort.signal }
    );
    if (cancelled) return;
    // Owner deletion/removal while a decoder was running revokes this work.
    const current = db
      .prepare("SELECT * FROM voice_exemplars WHERE id = ? AND approved_at IS NOT NULL")
      .get(sample.id);
    if (
      !current ||
      db.prepare("SELECT 1 FROM voice_exemplar_audio WHERE id = ?").get(sample.id) ||
      [
        "profile_id",
        "note_id",
        "approved_at",
        "track",
        "start_sample",
        "end_sample",
        "row_ids",
      ].some((key) => current[key] !== sample[key]) ||
      !current.embedding?.equals(sample.embedding)
    )
      return;
    const liveSource = store.recordingProvenance(sample.note_id, sample);
    if (
      !liveSource ||
      liveSource.recordingId !== source.recordingId ||
      liveSource.noteIdentity !== source.noteIdentity
    ) {
      terminal(sample, "recording_identity_mismatch", true);
      return;
    }
    if (liveSource.contentHash !== source.contentHash) {
      terminal(sample, "recording_content_mismatch", true);
      return;
    }
    if (["key_unavailable", "temporary_failure", "not_flushed"].includes(audio.state)) {
      retry(sample, audio.reason || audio.state);
      return;
    }
    if (audio.state !== "available" || audio.partial) {
      terminal(sample, audio.reason || "legacy_audio_unavailable");
      return;
    }
    let ciphertext;
    try {
      ciphertext = exemplarAudio.seal(store, audio.wav);
    } catch (error) {
      retry(sample, error.code || "exemplar_key_unavailable");
      return;
    }
    db.transaction(() => {
      const note = db.prepare("SELECT title FROM notes WHERE id = ?").get(sample.note_id);
      exemplarAudio.save(
        db,
        {
          id: sample.id,
          profileId: sample.profile_id,
          noteId: sample.note_id,
          noteTitle: note?.title || "",
          rowIds: JSON.parse(sample.row_ids),
          revision: "legacy-approval",
          track: sample.track,
          startSample: sample.start_sample,
          endSample: sample.end_sample,
          durationSeconds: (sample.end_sample - sample.start_sample) / 24000,
          meetingDate: sample.meeting_date,
        },
        audio.wav,
        ciphertext,
        sample.embedding
      );
      db.prepare(
        "UPDATE voice_exemplar_audio SET approved_at = ?, created_at = ? WHERE id = ?"
      ).run(sample.approved_at, sample.created_at, sample.id);
      const current = classifyEvidence(db, sample, { store, record: true });
      db.prepare(
        "UPDATE voice_evidence_provenance SET recovery_state='recovered', recovery_reason=NULL WHERE sample_id=?"
      ).run(sample.id);
      if (current.state === "resolved") report.resolved++;
      else released.add(sample.id); // Clip bytes no longer depend on the source.
    })();
    report.recovered++;
  }
  async function step() {
    if (cancelled) return;
    try {
      if (!page.length) {
        page = db
          .prepare(
            `SELECT s.*, COALESCE(p.recovery_next_at, 0) AS due FROM (${sources}) s
          LEFT JOIN voice_evidence_provenance p ON p.sample_id = s.id
          WHERE ${pending} AND s.id > ? AND COALESCE(p.recovery_next_at, 0) <= ?
          ${initial ? "" : "AND s.durable_audio = 0"} ORDER BY s.id LIMIT ?`
          )
          .all(cursor, now(), passLimit);
        if (!page.length) {
          initial = false;
          cursor = "";
          const next = db
            .prepare(
              `SELECT MIN(COALESCE(p.recovery_next_at, 0)) AS due FROM (${sources}) s
            LEFT JOIN voice_evidence_provenance p ON p.sample_id = s.id
            WHERE s.durable_audio = 0 AND ${pending}`
            )
            .get();
          if (next.due == null) {
            complete();
            return;
          }
          schedule(Math.max(yieldMs, Math.min(60000, next.due - now())));
          return;
        }
        report.passes++;
        report.maxPassItems = Math.max(report.maxPassItems, page.length);
      }
      const item = page.shift();
      cursor = item.id;
      try {
        await recover(item);
      } catch (error) {
        if (!cancelled) {
          if (error.code === "ENOENT") terminal(item, "audio_missing");
          else retry(item, error.code || "recovery_io_error");
        }
      }
      if (cancelled) return;
      require("./voiceEnrollment").rebuild(db, item.profile_id);
      // Protection now reflects classification immediately. The next ordinary
      // sweep can reclaim the source; avoid rescanning the library per sample.
      store.onChanged?.({ noteId: item.note_id, recovery: true });
      schedule();
    } catch (error) {
      // Operational queue failure is visible, never an unhandled rejection.
      debugLogger.error(
        "Legacy voice recovery queue stopped",
        { reason: error.code || error.message },
        "voice-enrollment"
      );
      report.cancel();
    }
  }
  schedule();
  return report;
}

module.exports = { start };
