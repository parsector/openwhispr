// Voice evidence is local and opt-in. Only this module promotes approved audio
// to a usable profile; naming a row never calls it.
const { randomUUID, createHash } = require("node:crypto");
const { readTranscriptDocument } = require("./transcriptDocument");
const { readSpeakerActionLog } = require("./speakerActionLog");
const history = require("./speakerGlobalHistory");
const debugLogger = require("./debugLogger");
const { resolveMeetingAudioSpan } = require("./meetingAudioSpan.mjs");
const enrollmentTiming = require("./voiceEnrollmentTiming");
const exemplarAudio = require("./voiceExemplarAudio");

const RATE = 24000;
const MODEL_RATE = 16000;
const MIN_SPANS = 3;
const MIN_MEETINGS = 2;
const MAX_SAMPLES = 20;
const ENROLLMENT_RULES_VERSION = 1;
// These are uncalibrated guards, not thresholds measured on owner-labelled audio.
const calibration = Object.freeze({
  ownSimilarity: { value: 0.65, status: "uncalibrated" },
  minRms: { value: 0.01, status: "uncalibrated" },
  clippingFraction: { value: 0.01, status: "uncalibrated" },
  echoCorrelation: { value: 0.88, status: "uncalibrated" },
});
const MIN_OWN_SIMILARITY = calibration.ownSimilarity.value;
const played = new Map();
const offersByDatabase = new WeakMap();
function offers(database) {
  if (!offersByDatabase.has(database)) offersByDatabase.set(database, new Map());
  return offersByDatabase.get(database);
}
function offerFingerprint(note, status) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        note.id,
        note.transcript,
        note.speaker_action_log,
        note.speaker_label_undo,
        status,
      ])
    )
    .digest("hex");
}
function factFingerprint(note, status, rulesVersion) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        rulesVersion,
        note.id,
        note.transcript,
        note.speaker_action_log,
        note.speaker_label_undo,
        status,
      ])
    )
    .digest("hex");
}
function rememberOffer(database, candidate, fingerprint) {
  offers(database).set(candidate.id, {
    candidate,
    fingerprint,
  });
}
function stopObserving(session) {
  if (session?.sender && session.audioListener) {
    session.sender.off("audio-state-changed", session.audioListener);
    session.audioListener = null;
  }
}
function forgetPlayback(id) {
  const session = played.get(id);
  stopObserving(session);
  clearTimeout(session?.expiryTimer);
  played.delete(id);
}

const vector = (bytes) => new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
const packed = (values) => Buffer.from(values.buffer, values.byteOffset, values.byteLength);
function unit(values) {
  const norm = Math.hypot(...values);
  return norm ? Float32Array.from(values, (value) => value / norm) : null;
}
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
function rowsFor(db, noteId) {
  const note = db.prepare("SELECT transcript FROM notes WHERE id = ?").get(noteId);
  return note ? readTranscriptDocument(note.transcript).rows : [];
}
function changedRows(note) {
  const ids = new Set();
  for (const action of readSpeakerActionLog(note).actions) {
    if (
      !["correction", "split", "reconsideration"].includes(action.kind) ||
      action.event?.initialAttribution
    )
      continue;
    for (const id of action.event?.affectedRowIds || action.event?.rowIds || []) ids.add(id);
  }
  return ids;
}
function attributed(db, noteId, row, profileId) {
  // A user's explicit label takes precedence over older cluster mappings.
  if (row.speakerLockSource === "user") return row.suggestedProfileId === profileId;
  if (row.suggestedProfileId === profileId) return true;
  if (
    row.diarizationRunId &&
    db
      .prepare(
        `SELECT 1 FROM speaker_run_mappings
    WHERE note_id = ? AND run_id = ? AND cluster_id = ? AND profile_id = ?`
      )
      .get(noteId, row.diarizationRunId, row.speaker, profileId)
  )
    return true;
  return !!db
    .prepare(
      `SELECT 1 FROM speaker_mappings
    WHERE note_id = ? AND speaker_id = ? AND profile_id = ?`
    )
    .get(noteId, row.speaker, profileId);
}
function clean(db, sample) {
  if (sample.durable_audio) return sample.valid !== 0;
  const rows = rowsFor(db, sample.note_id);
  const ids = JSON.parse(sample.row_ids || "[]");
  return (
    ids.length > 0 &&
    ids.every((id) => {
      const row = rows.find((item) => item.id === id);
      return row && !row.deleted && attributed(db, sample.note_id, row, sample.profile_id);
    })
  );
}
function samples(db, profileId) {
  const durable = exemplarAudio.list(db, profileId);
  return [
    ...durable,
    ...db
      .prepare(
        "SELECT * FROM voice_exemplars WHERE profile_id = ? AND approved_at IS NOT NULL ORDER BY approved_at, id"
      )
      .all(profileId)
      .filter((sample) => !durable.some((item) => item.id === sample.id)),
  ];
}
function state(db, profileId) {
  const all = samples(db, profileId);
  const good = all.filter((sample) => sample.embedding?.length === 2048 && clean(db, sample));
  const vectors = good.map((sample) => unit(vector(sample.embedding)));
  const conflict = vectors.some(
    (left, i) =>
      !left ||
      vectors.some((right, j) => j > i && (!right || cosine(left, right) < MIN_OWN_SIMILARITY))
  );
  const meetings = new Set(good.map((sample) => sample.note_identity || sample.note_id)).size;
  // Graduation requires three approved, internally consistent spans from two
  // recordings. A later correction to any contributing row removes its sample.
  const requiresReview = !!db
    .prepare("SELECT voice_needs_reapproval FROM speaker_profiles WHERE id = ?")
    .get(profileId)?.voice_needs_reapproval;
  const usable =
    good.length >= MIN_SPANS &&
    meetings >= MIN_MEETINGS &&
    !conflict &&
    good.length === all.length &&
    !requiresReview;
  return {
    cleanSpans: good.length,
    meetings,
    approvedSpans: all.length,
    conflict,
    usable,
    requiresReview,
    vectors: conflict ? [] : vectors,
    good,
  };
}
function progress(database, profileId) {
  const { cleanSpans, meetings, approvedSpans, conflict, usable } = state(database.db, profileId);
  return {
    cleanSpans,
    meetings,
    approvedSpans,
    conflict,
    usable,
    requiredSpans: MIN_SPANS,
    requiredMeetings: MIN_MEETINGS,
  };
}
function listSamples(database, profileId) {
  const db = database.db;
  const all = samples(db, profileId);
  const vectors = all.map((sample) =>
    sample.embedding?.length === 2048 ? unit(vector(sample.embedding)) : null
  );
  const averages = vectors.map((value, i) =>
    value && vectors.length > 1
      ? vectors.reduce((sum, other, j) => sum + (i !== j && other ? cosine(value, other) : 0), 0) /
        (vectors.length - 1)
      : 1
  );
  const worst = Math.min(...averages.filter((value) => value != null));
  const conflict = state(db, profileId).conflict;
  return all.map((sample, i) => ({
    id: sample.id,
    profileId,
    noteId: sample.note_id,
    noteTitle:
      sample.note_title ??
      (db.prepare("SELECT title FROM notes WHERE id = ?").get(sample.note_id)?.title || ""),
    rowIds: JSON.parse(sample.row_ids || "[]"),
    meetingDate: sample.meeting_date,
    createdAt: sample.created_at,
    permanent: !!sample.durable_audio,
    durationSeconds: (sample.end_sample - sample.start_sample) / RATE,
    odd: !clean(db, sample) || (conflict && (vectors.length <= 2 || averages[i] === worst)),
  }));
}
function resolveProfile(db, profileId) {
  const result = state(db, profileId);
  let embedding = Buffer.alloc(0);
  if (result.vectors.length && result.good.length === result.approvedSpans) {
    // One vote per meeting, then equal weight for each meeting. Duration has
    // no weight; an eight second span cannot drown out a short one.
    const grouped = new Map();
    result.good.forEach((sample, i) => {
      const meeting = sample.note_identity || sample.note_id;
      if (!grouped.has(meeting)) grouped.set(meeting, []);
      grouped.get(meeting).push(result.vectors[i]);
    });
    const meetingVectors = [...grouped.values()].map((items) =>
      unit(
        Float32Array.from(
          { length: 512 },
          (_, i) => items.reduce((sum, item) => sum + item[i], 0) / items.length
        )
      )
    );
    const centroid = unit(
      Float32Array.from(
        { length: 512 },
        (_, i) => meetingVectors.reduce((sum, item) => sum + item[i], 0) / meetingVectors.length
      )
    );
    if (centroid) embedding = packed(centroid);
  }
  return { result, embedding };
}
function rebuild(db, profileId) {
  const { result, embedding } = resolveProfile(db, profileId);
  db.prepare(
    "UPDATE speaker_profiles SET embedding = ?, sample_count = ?, voice_usable = ?, voice_needs_reapproval = ? WHERE id = ?"
  ).run(
    embedding,
    result.cleanSpans,
    Number(result.usable),
    Number(result.requiresReview || result.conflict || result.good.length !== result.approvedSpans),
    profileId
  );
  return result;
}
function candidateId(profileId, noteId, rowId, span, noteIdentity = null) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        profileId,
        noteId,
        noteIdentity,
        rowId,
        span.trackId,
        span.startSample,
        span.endSample,
      ])
    )
    .digest("hex");
}
function captureDate(note, status, startSample) {
  return Number.isFinite(status.startedAt)
    ? new Date(status.startedAt + (startSample / RATE) * 1000).toISOString()
    : note.created_at;
}
function createEligibilityContext(database, store) {
  const db = database.db;
  const resolveSpan = store.resolveMeetingAudioSpan || resolveMeetingAudioSpan;
  const statuses = new Map();
  const changedByNote = new Map();
  const resolvedByNote = new Map();
  const approvedByProfile = new Map();
  const echoBySpan = new Map();
  const availabilityBySpan = new Map();
  const resolve = (note, rows, row, status) => {
    let spans = resolvedByNote.get(note.id);
    if (!spans) {
      spans = new Map();
      resolvedByNote.set(note.id, spans);
    }
    if (!spans.has(row.id)) {
      const own = resolveSpan(
        row,
        rows,
        status.recordingId ?? note.id,
        status.startedAt,
        status.tracks
      );
      // Split transcript rows can share one recorded span. Resolve against its
      // last row so the next-row boundary does not cut the shared audio short.
      const matching =
        row.audioSpan &&
        rows.filter(
          (item) =>
            !item.deleted &&
            item.audioSpan &&
            item.source === row.source &&
            item.audioSpan.recordingId === row.audioSpan.recordingId &&
            item.audioSpan.trackId === row.audioSpan.trackId &&
            item.audioSpan.startSample === row.audioSpan.startSample &&
            item.audioSpan.endSample === row.audioSpan.endSample
        );
      const anchor =
        matching?.length > 1 && (!own.reason || own.reason === "gap") ? matching.at(-1) : row;
      spans.set(
        row.id,
        anchor === row
          ? own
          : resolveSpan(
              anchor,
              rows,
              status.recordingId ?? note.id,
              status.startedAt,
              status.tracks
            )
      );
    }
    return spans.get(row.id);
  };
  function check(note, rows, row, profileId, hypothetical = false, factsOnly = false) {
    if (row.deleted) return { reason: "uncertain" };
    if (!factsOnly && profileId != null) {
      if (!approvedByProfile.has(profileId))
        approvedByProfile.set(profileId, samples(db, profileId).length);
      if (approvedByProfile.get(profileId) >= MAX_SAMPLES) return { reason: "limit" };
    }
    if (!changedByNote.has(note.id)) changedByNote.set(note.id, changedRows(note));
    const changed = changedByNote.get(note.id);
    if (!hypothetical && changed.has(row.id) && row.speakerLockSource !== "user")
      return { reason: "uncertain" };
    if (row.overlap || (!hypothetical && row.uncertainty?.reason === "overlapping_speech"))
      return { reason: "overlap" };
    if (
      !hypothetical &&
      (row.uncertainty || ["provisional", "suggested"].includes(row.speakerStatus))
    )
      return { reason: "uncertain" };
    if (!statuses.has(note.id)) statuses.set(note.id, store.status(note.id));
    const status = statuses.get(note.id);
    if (!["complete", "incomplete"].includes(status.state) || status.bytes === 0)
      return { reason: "audio" };
    const resolved = resolve(note, rows, row, status);
    if (resolved.reason)
      return {
        reason: ["gap", "outside_recorded_range"].includes(resolved.reason)
          ? "audio"
          : "resolution",
      };
    const overlap = rows.some((other) => {
      if (other === row || other.deleted || other.speaker === row.speaker) return false;
      const otherSpan = resolve(note, rows, other, status);
      return (
        !otherSpan.reason &&
        otherSpan.track === resolved.track &&
        otherSpan.from < resolved.to &&
        otherSpan.to > resolved.from
      );
    });
    if (overlap) return { reason: "overlap" };
    const startSample = Math.round((Math.max(resolved.from, resolved.start) + 0.25) * RATE);
    const endSample = Math.round((Math.min(resolved.to, resolved.end) - 0.25) * RATE);
    const duration = (endSample - startSample) / RATE;
    if (duration < 3) return { reason: "short" };
    if (duration > 8) return { reason: "long" };
    const availableKey = `${note.id}:${resolved.track}:${startSample}:${endSample}`;
    if (!availabilityBySpan.has(availableKey))
      availabilityBySpan.set(
        availableKey,
        store.spanAvailable
          ? store.spanAvailable(note.id, resolved.track, startSample, endSample)
          : (() => {
              const audio = store.span(
                note.id,
                resolved.track,
                startSample / RATE,
                endSample / RATE
              );
              return audio.state === "available" && !audio.partial;
            })()
      );
    const available = availabilityBySpan.get(availableKey);
    if (!available) return { reason: "audio" };
    const otherTrack = resolved.track === "mic" ? "system" : "mic";
    if (status.tracks?.[otherTrack]?.chunks?.length) {
      const key = `${note.id}:${resolved.track}:${startSample}:${endSample}`;
      if (!echoBySpan.has(key))
        echoBySpan.set(
          key,
          isEchoSpan(store, note.id, resolved.track, startSample, endSample, status)
        );
      if (echoBySpan.get(key)) return { reason: "overlap" };
    }
    const spanKey = [profileId, note.id, resolved.track, startSample, endSample];
    if (!factsOnly && profileId != null) {
      const overlapsApproved = db
        .prepare(
          `SELECT 1 FROM voice_exemplars WHERE profile_id = ? AND note_id = ? AND track = ?
          AND start_sample < ? AND end_sample > ?`
        )
        .get(profileId, note.id, resolved.track, endSample, startSample);
      if (
        overlapsApproved ||
        db
          .prepare(
            `SELECT 1 FROM voice_enrollment_candidates WHERE profile_id = ? AND note_id = ?
          AND track = ? AND start_sample = ? AND end_sample = ?`
          )
          .get(...spanKey)
      )
        return { reason: "reviewed" };
    }
    if (hypothetical) return { candidate: null, track: resolved.track, startSample, endSample };
    const candidate = {
      id: candidateId(
        profileId,
        note.id,
        row.id,
        {
          trackId: resolved.track,
          startSample,
          endSample,
        },
        note.client_note_id
      ),
      profileId,
      noteId: note.id,
      noteTitle: note.title,
      meetingDate: captureDate(note, status, startSample),
      rowIds: [row.id],
      track: resolved.track,
      startSample,
      endSample,
      durationSeconds: duration,
      revision: createHash("sha256")
        .update(
          JSON.stringify([
            row.text,
            row.speaker,
            row.speakerName,
            row.speakerLockSource,
            row.speakerStatus,
            row.suggestedProfileId,
            row.correctionRevision,
            changed.has(row.id),
            resolved,
          ])
        )
        .digest("hex"),
      everCorrected: changed.has(row.id) || !!Number(row.correctionRevision),
    };
    return { candidate };
  }
  return { check };
}
function noteFacts(database, store, note, rows, eligibility, rulesVersion, profileId, status) {
  const db = database.db;
  const fingerprint = factFingerprint(note, status, rulesVersion);
  const cached = db
    .prepare(
      `SELECT fingerprint, facts_json FROM voice_enrollment_fact_cache
    WHERE note_id = ?`
    )
    .get(note.id);
  const facts = new Map(cached?.fingerprint === fingerprint ? JSON.parse(cached.facts_json) : []);
  let changed = cached?.fingerprint !== fingerprint;
  for (const row of rows) {
    if (row.deleted || !attributed(db, note.id, row, profileId) || facts.has(row.id)) continue;
    const result = eligibility.check(note, rows, row, null, false, true);
    if (result.reason) facts.set(row.id, { reason: result.reason });
    else {
      const { track, startSample, endSample, durationSeconds, revision, everCorrected } =
        result.candidate;
      facts.set(row.id, {
        track,
        startSample,
        endSample,
        durationSeconds,
        revision,
        everCorrected,
      });
    }
    changed = true;
  }
  if (changed)
    db.prepare(
      `INSERT INTO voice_enrollment_fact_cache (note_id, fingerprint, facts_json)
      VALUES (?, ?, ?) ON CONFLICT(note_id) DO UPDATE SET fingerprint = excluded.fingerprint,
      facts_json = excluded.facts_json, computed_at = CURRENT_TIMESTAMP`
    ).run(note.id, fingerprint, JSON.stringify([...facts]));
  return facts;
}
function candidateReportImpl(database, store, profileId, rulesVersion = ENROLLMENT_RULES_VERSION) {
  const db = database.db;
  const reasons = {
    short: 0,
    long: 0,
    audio: 0,
    overlap: 0,
    uncertain: 0,
    reviewed: 0,
    limit: 0,
    resolution: 0,
  };
  if (!db.prepare("SELECT 1 FROM speaker_profiles WHERE id = ?").get(profileId))
    return { candidates: [], reasons };
  const approvedSamples = samples(db, profileId);
  const approved = approvedSamples.length;
  if (approved >= MAX_SAMPLES) {
    reasons.limit = approved;
    return { candidates: [], reasons };
  }
  const offered = [];
  const eligibility = createEligibilityContext(database, store);
  for (const note of db
    .prepare(
      "SELECT id, client_note_id, title, created_at, transcript, speaker_action_log, speaker_label_undo FROM notes WHERE note_type = 'meeting' AND deleted_at IS NULL"
    )
    .all()) {
    const rows = readTranscriptDocument(note.transcript).rows;
    const status = store.status(note.id);
    const fingerprint = offerFingerprint(note, status);
    const facts = noteFacts(
      database,
      store,
      note,
      rows,
      eligibility,
      rulesVersion,
      profileId,
      status
    );
    for (const row of rows) {
      if (row.deleted || !attributed(db, note.id, row, profileId)) continue;
      if (
        approvedSamples.some(
          (sample) =>
            sample.durable_audio &&
            sample.note_id === note.id &&
            sample.note_identity === note.client_note_id &&
            JSON.parse(sample.row_ids).includes(row.id)
        )
      ) {
        reasons.reviewed++;
        continue;
      }
      const fact = facts.get(row.id);
      if (fact.reason) reasons[fact.reason]++;
      else {
        if (
          store.spanAvailable &&
          !store.spanAvailable(note.id, fact.track, fact.startSample, fact.endSample)
        ) {
          reasons.audio++;
          continue;
        }
        const reviewed =
          db
            .prepare(
              `SELECT 1 FROM voice_exemplars WHERE profile_id = ?
          AND note_id = ? AND track = ? AND start_sample < ? AND end_sample > ?`
            )
            .get(profileId, note.id, fact.track, fact.endSample, fact.startSample) ||
          db
            .prepare(
              `SELECT 1 FROM voice_enrollment_candidates WHERE profile_id = ?
          AND note_id = ? AND track = ? AND start_sample = ? AND end_sample = ?`
            )
            .get(profileId, note.id, fact.track, fact.startSample, fact.endSample);
        if (reviewed) {
          reasons.reviewed++;
          continue;
        }
        const candidate = {
          id: candidateId(
            profileId,
            note.id,
            row.id,
            {
              trackId: fact.track,
              startSample: fact.startSample,
              endSample: fact.endSample,
            },
            note.client_note_id
          ),
          profileId,
          noteId: note.id,
          noteTitle: note.title,
          meetingDate: captureDate(note, status, fact.startSample),
          rowIds: [row.id],
          ...fact,
        };
        offered.push(candidate);
        rememberOffer(database, candidate, fingerprint);
      }
    }
  }
  enrollmentTiming.candidateCount(offered.length);
  return { candidates: offered, reasons };
}
function candidateReport(database, store, profileId, rulesVersion = ENROLLMENT_RULES_VERSION) {
  return enrollmentTiming.measure("candidate_scan_ms", () =>
    candidateReportImpl(database, store, profileId, rulesVersion)
  );
}
function listCandidates(database, store, profileId) {
  return candidateReport(database, store, profileId).candidates;
}
function focusedOffer(database, store, id) {
  const db = database.db;
  const existing = db.prepare("SELECT * FROM voice_enrollment_candidates WHERE id = ?").get(id);
  if (existing) return null;
  const saved = offers(database).get(id);
  if (saved) {
    const candidate = saved.candidate;
    const note = db
      .prepare(
        `SELECT id, client_note_id, title, created_at, transcript, speaker_action_log,
      speaker_label_undo FROM notes WHERE id = ? AND note_type = 'meeting' AND deleted_at IS NULL`
      )
      .get(candidate.noteId);
    const status = note && store.status(note.id);
    if (
      note &&
      ["complete", "incomplete"].includes(status.state) &&
      status.bytes !== 0 &&
      offerFingerprint(note, status) === saved.fingerprint
    ) {
      const row = readTranscriptDocument(note.transcript).rows.find(
        (item) => item.id === candidate.rowIds[0]
      );
      const approved = samples(db, candidate.profileId).length;
      const reviewed = db
        .prepare(
          `SELECT 1 FROM voice_exemplars WHERE profile_id = ? AND note_id = ?
        AND track = ? AND start_sample < ? AND end_sample > ?`
        )
        .get(
          candidate.profileId,
          candidate.noteId,
          candidate.track,
          candidate.endSample,
          candidate.startSample
        );
      const rejected = db
        .prepare(
          `SELECT 1 FROM voice_enrollment_candidates WHERE profile_id = ?
        AND note_id = ? AND track = ? AND start_sample = ? AND end_sample = ?`
        )
        .get(
          candidate.profileId,
          candidate.noteId,
          candidate.track,
          candidate.startSample,
          candidate.endSample
        );
      if (
        row &&
        !row.deleted &&
        attributed(db, note.id, row, candidate.profileId) &&
        approved < MAX_SAMPLES &&
        !reviewed &&
        !rejected &&
        db.prepare("SELECT 1 FROM speaker_profiles WHERE id = ?").get(candidate.profileId) &&
        (!store.spanAvailable ||
          store.spanAvailable(
            candidate.noteId,
            candidate.track,
            candidate.startSample,
            candidate.endSample
          ))
      )
        return candidate;
    }
    offers(database).delete(id);
  }
  return null;
}
function locate(database, store, id) {
  const found = focusedOffer(database, store, id);
  if (found) {
    enrollmentTiming.candidateCount(1);
    return found;
  }
  const db = database.db;
  if (db.prepare("SELECT 1 FROM voice_enrollment_candidates WHERE id = ?").get(id)) return null;
  // A fresh scan rechecks attribution, correction and retention at action time.
  for (const { id: profileId } of db.prepare("SELECT id FROM speaker_profiles").all()) {
    const found = listCandidates(database, store, profileId).find(
      (candidate) => candidate.id === id
    );
    if (found) return found;
  }
  return null;
}
function play(database, store, id, sender = null) {
  forgetPlayback(id);
  const exemplar = exemplarAudio.play(database.db, store, id);
  if (exemplar) return exemplar;
  const candidate = locate(database, store, id);
  if (!candidate) return { state: "unavailable" };
  const audio = store.span(
    candidate.noteId,
    candidate.track,
    candidate.startSample / RATE,
    candidate.endSample / RATE
  );
  if (audio.state !== "available" || audio.partial) return { state: "unavailable" };
  const token = randomUUID();
  const now = (store.now || Date.now)();
  const durationMs = Math.ceil(candidate.durationSeconds * 1000);
  const session = {
    wav: Buffer.from(audio.wav),
    token,
    revision: candidate.revision,
    noteId: candidate.noteId,
    profileId: candidate.profileId,
    rowIds: candidate.rowIds,
    durationMs,
    completeAfter: now + durationMs,
    expires: now + 10 * 60 * 1000,
    completed: false,
    sender,
    audibleMs: 0,
    audibleSince: null,
    audioListener: null,
  };
  if (sender) {
    // Chromium reports actual audio output from this WebContents. The renderer
    // can request completion, but cannot make a silent WebContents audible via IPC.
    session.audioListener = (event) => {
      const at = (store.now || Date.now)();
      if (session.audibleSince != null) session.audibleMs += Math.max(0, at - session.audibleSince);
      session.audibleSince = event.audible ? at : null;
    };
    sender.on("audio-state-changed", session.audioListener);
  }
  played.set(id, session);
  session.expiryTimer = setTimeout(() => forgetPlayback(id), 10 * 60 * 1000);
  session.expiryTimer.unref?.();
  return { state: "available", wav: audio.wav, token, candidate, expiresAt: session.expires };
}
function complete(database, store, id, token, sender = null) {
  const session = played.get(id);
  const now = (store.now || Date.now)();
  if (
    !session ||
    session.token !== token ||
    session.expires < now ||
    now < session.completeAfter ||
    session.sender !== sender
  )
    return { success: false, error: "playback_required" };
  if (sender) {
    const audibleMs =
      session.audibleMs +
      (session.audibleSince == null ? 0 : Math.max(0, now - session.audibleSince));
    if (audibleMs < session.durationMs * 0.75)
      return { success: false, error: "playback_required" };
  }
  const candidate = locate(database, store, id);
  if (!candidate || candidate.revision !== session.revision) {
    forgetPlayback(id);
    return { success: false, error: "candidate_unavailable" };
  }
  session.completed = true;
  stopObserving(session);
  return { success: true, expiresAt: session.expires };
}
function missingCandidateReason(database, store, id, playback) {
  const db = database.db;
  if (db.prepare("SELECT 1 FROM voice_exemplars WHERE id = ?").get(id)) return "already_approved";
  if (
    !db.prepare("SELECT 1 FROM speaker_profiles WHERE id = ?").get(playback.profileId) ||
    !db.prepare("SELECT 1 FROM notes WHERE id = ? AND deleted_at IS NULL").get(playback.noteId)
  )
    return "person_or_meeting_changed";
  const rows = rowsFor(db, playback.noteId);
  if (store.status(playback.noteId).state === "key_unavailable") return "exemplar_key_unavailable";
  const recordingId = store.status(playback.noteId).recordingId ?? playback.noteId;
  if (
    playback.rowIds.some((rowId) => {
      const row = rows.find((item) => item.id === rowId);
      return row?.audioSpan?.recordingId && row.audioSpan.recordingId !== recordingId;
    })
  )
    return "span_mismatch";
  return "candidate_unavailable";
}
function decisionFailure(code, id, playback, statement) {
  debugLogger.warn(
    "Voice enrollment decision failed",
    JSON.stringify({
      code,
      noteId: playback?.noteId ?? null,
      personId: playback?.profileId ?? null,
      candidateId: id,
      statement,
    }),
    "voice-enrollment"
  );
  return { success: false, error: code };
}
function playbackContext(id) {
  const session = played.get(id);
  return { noteId: session?.noteId ?? null, personId: session?.profileId ?? null };
}
async function embed(wav, extractor) {
  if (wav.subarray(0, 4).toString() !== "RIFF") return null;
  const samples = (wav.length - 44) / 2;
  if (samples < RATE * 3) return null;
  let power = 0,
    clipped = 0;
  for (let i = 0; i < samples; i++) {
    const amplitude = wav.readInt16LE(44 + i * 2);
    power += amplitude * amplitude;
    if (Math.abs(amplitude) >= 32750) clipped++;
  }
  if (
    Math.sqrt(power / samples) / 32768 < calibration.minRms.value ||
    clipped / samples > calibration.clippingFraction.value
  )
    return null;
  const windows = [];
  const windowLength = Math.min(samples, RATE * 3);
  for (let k = 0; k < 3; k++) {
    const start = Math.round(((samples - windowLength) * k) / 2);
    const mono = new Float32Array(Math.round((windowLength * MODEL_RATE) / RATE));
    for (let i = 0; i < mono.length; i++) {
      const source = start + (i * RATE) / MODEL_RATE;
      const lo = Math.floor(source),
        hi = Math.min(samples - 1, lo + 1);
      const a = wav.readInt16LE(44 + lo * 2) / 32768;
      const b = wav.readInt16LE(44 + hi * 2) / 32768;
      mono[i] = a + (b - a) * (source - lo);
    }
    const output = await extractor.extractEmbeddingFromSamples(mono);
    if (!output || output.length !== 512) return null;
    const normalized = unit(output);
    if (!normalized) return null;
    windows.push(normalized);
  }
  if (
    windows.some((left, i) =>
      windows.some((right, j) => j > i && cosine(left, right) < MIN_OWN_SIMILARITY)
    )
  )
    return null;
  return unit(
    Float32Array.from(
      { length: 512 },
      (_, i) => windows.reduce((sum, item) => sum + item[i], 0) / windows.length
    )
  );
}
function echoLike(wav, other) {
  if (!other || other.length < wav.length / 2) return false;
  const count = Math.min((wav.length - 44) / 2, (other.length - 44) / 2);
  let dot = 0,
    left = 0,
    right = 0;
  for (let i = 0; i < count; i += 24) {
    const a = wav.readInt16LE(44 + i * 2),
      b = other.readInt16LE(44 + i * 2);
    dot += a * b;
    left += a * a;
    right += b * b;
  }
  return left > 0 && right > 0 && dot / Math.sqrt(left * right) > calibration.echoCorrelation.value;
}
function isEchoSpanImpl(
  store,
  noteId,
  track,
  startSample,
  endSample,
  status = store.status(noteId),
  wav = null
) {
  const otherTrack = track === "mic" ? "system" : "mic";
  if (!status.tracks?.[otherTrack]?.chunks?.length) return false;
  if (store.spanAvailable && !store.spanAvailable(noteId, otherTrack, startSample, endSample))
    return false;
  const start = startSample / RATE,
    end = endSample / RATE;
  const current = wav ? { state: "available", wav } : store.span(noteId, track, start, end);
  const other = store.span(noteId, otherTrack, start, end);
  return (
    current.state === "available" && other.state === "available" && echoLike(current.wav, other.wav)
  );
}
function isEchoSpan(...args) {
  return enrollmentTiming.measure("echo_decode_ms", () => isEchoSpanImpl(...args));
}
async function decide(database, store, extractor, id, choice, token, sender = null) {
  const playback = played.get(id);
  if (
    !["approve", "reject"].includes(choice) ||
    !playback ||
    playback.token !== token ||
    !playback.completed ||
    playback.expires < (store.now || Date.now)() ||
    playback.sender !== sender
  )
    return decisionFailure("playback_required", id, playback, "validate completed playback");
  const candidate = locate(database, store, id);
  if (!candidate || candidate.revision !== playback.revision)
    return decisionFailure(
      candidate ? "candidate_unavailable" : missingCandidateReason(database, store, id, playback),
      id,
      playback,
      "recheck candidate and recording"
    );
  // Keep exactly the bytes that earned the playback proof, without a second
  // decode or encode (or a race against a changed recording).
  const audio = { wav: playback.wav };
  if (choice === "approve") {
    if (
      isEchoSpan(
        store,
        candidate.noteId,
        candidate.track,
        candidate.startSample,
        candidate.endSample,
        store.status(candidate.noteId),
        audio.wav
      )
    )
      return decisionFailure("echo_audio", id, playback, "check other audio track for echo");
  }
  const embedding =
    choice === "approve"
      ? await enrollmentTiming.measureAsync("embed_ms", () => embed(audio.wav, extractor))
      : null;
  if (choice === "approve" && !embedding)
    return decisionFailure("poor_audio", id, playback, "check audio suitability");
  let statement = "BEGIN voice enrollment decision";
  try {
    const ciphertext = choice === "approve" ? exemplarAudio.seal(store, audio.wav) : null;
    const result = database.db.transaction(() => {
      if (!focusedOffer(database, store, id))
        return { success: false, error: "candidate_unavailable" };
      const db = database.db;
      const actionId = randomUUID();
      if (choice === "approve") {
        statement = "INSERT INTO voice_exemplars";
        db.prepare(
          `INSERT INTO voice_exemplars (id, profile_id, note_id, track, start_sample, end_sample,
        embedding, approved_at, row_ids, meeting_date) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`
        ).run(
          id,
          candidate.profileId,
          candidate.noteId,
          candidate.track,
          candidate.startSample,
          candidate.endSample,
          packed(embedding),
          JSON.stringify(candidate.rowIds),
          candidate.meetingDate
        );
        exemplarAudio.save(db, candidate, audio.wav, ciphertext, packed(embedding));
        statement = "UPDATE speaker_profiles SET voice_needs_reapproval = 0 WHERE id = ?";
        db.prepare("UPDATE speaker_profiles SET voice_needs_reapproval = 0 WHERE id = ?").run(
          candidate.profileId
        );
        statement = "rebuild speaker profile";
        rebuild(db, candidate.profileId);
      } else {
        statement = "INSERT INTO voice_enrollment_candidates";
        db.prepare(
          `INSERT INTO voice_enrollment_candidates (id, profile_id, note_id, track, start_sample,
        end_sample, row_ids, meeting_date, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        ).run(
          id,
          candidate.profileId,
          candidate.noteId,
          candidate.track,
          candidate.startSample,
          candidate.endSample,
          JSON.stringify(candidate.rowIds),
          candidate.meetingDate
        );
      }
      statement = "INSERT INTO voice_enrollment_actions";
      db.prepare(
        "INSERT INTO voice_enrollment_actions (id, candidate_id, profile_id, note_id, choice) VALUES (?, ?, ?, ?, ?)"
      ).run(actionId, id, candidate.profileId, candidate.noteId, choice);
      statement = "INSERT INTO speaker_global_actions";
      history.add(db, {
        id: actionId,
        kind: "enrollment",
        profileId: candidate.profileId,
        noteId: candidate.noteId,
        label: `${choice}: ${candidate.rowIds.join(", ")}`,
      });
      statement = "SELECT voice enrollment progress";
      return {
        success: true,
        id: actionId,
        removedCandidateId: id,
        noteId: candidate.noteId,
        personId: candidate.profileId,
        progress: progress(database, candidate.profileId),
      };
    })();
    if (result.success) {
      forgetPlayback(id);
      result.offers = candidateReport(database, store, candidate.profileId);
    } else decisionFailure(result.error, id, playback, "recheck candidate inside transaction");
    return result;
  } catch (cause) {
    const sqliteCode = cause?.code || "";
    const error =
      sqliteCode === "exemplar_key_unavailable"
        ? sqliteCode
        : sqliteCode.startsWith("SQLITE_BUSY") || sqliteCode.startsWith("SQLITE_LOCKED")
          ? "database_busy"
          : sqliteCode.startsWith("SQLITE_CONSTRAINT") && sqliteCode !== "SQLITE_CONSTRAINT_TRIGGER"
            ? "constraint_failed"
            : "persistence_failed";
    debugLogger.warn(
      "Voice enrollment decision failed",
      JSON.stringify({
        code: error,
        noteId: candidate.noteId,
        personId: candidate.profileId,
        candidateId: id,
        statement,
      }),
      "voice-enrollment"
    );
    return { success: false, error };
  }
}
function undo(database, id) {
  return database.db.transaction(() => {
    const db = database.db;
    if (
      !history.canUndo(
        db,
        id,
        db.prepare("SELECT note_id FROM voice_enrollment_actions WHERE id = ?").get(id)?.note_id ??
          null
      )
    )
      return { success: false, error: "later_change" };
    const action = db.prepare("SELECT * FROM voice_enrollment_actions WHERE id = ?").get(id);
    if (!action) return { success: false, error: "action_missing" };
    if (action.choice === "approve") {
      db.prepare("DELETE FROM voice_exemplar_audio WHERE id = ?").run(action.candidate_id);
      db.prepare("DELETE FROM voice_exemplars WHERE id = ?").run(action.candidate_id);
    } else if (action.choice === "remove") {
      const sample = JSON.parse(action.before_sample);
      const columns = Object.keys(sample);
      db.prepare(
        `INSERT INTO voice_exemplars (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`
      ).run(
        ...columns.map((column) =>
          column === "embedding" ? Buffer.from(sample[column], "base64") : sample[column]
        )
      );
      db.prepare("DELETE FROM voice_enrollment_candidates WHERE id = ?").run(action.candidate_id);
    } else
      db.prepare("DELETE FROM voice_enrollment_candidates WHERE id = ?").run(action.candidate_id);
    db.prepare("DELETE FROM voice_enrollment_actions WHERE id = ?").run(id);
    history.remove(db, id, action.note_id);
    if (db.prepare("SELECT 1 FROM speaker_profiles WHERE id = ?").get(action.profile_id))
      rebuild(db, action.profile_id);
    return { success: true };
  })();
}
function removeSample(database, sampleId) {
  return database.db.transaction(() => {
    const db = database.db;
    const durable = db
      .prepare(
        `SELECT id, profile_id, note_id, track, start_sample, end_sample,
      embedding, approved_at, created_at, row_ids, meeting_date FROM voice_exemplar_audio WHERE id = ?`
      )
      .get(sampleId);
    const sample =
      durable || db.prepare("SELECT * FROM voice_exemplars WHERE id = ?").get(sampleId);
    if (!sample) return { success: false, error: "sample_missing" };
    const actionId = randomUUID();
    if (db.prepare("SELECT 1 FROM notes WHERE id = ?").get(sample.note_id))
      db.prepare(
        `INSERT OR IGNORE INTO voice_enrollment_candidates
      (id, profile_id, note_id, track, start_sample, end_sample, row_ids, meeting_date, rejected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).run(
        sample.id,
        sample.profile_id,
        sample.note_id,
        sample.track,
        sample.start_sample,
        sample.end_sample,
        sample.row_ids,
        sample.meeting_date
      );
    db.prepare("DELETE FROM voice_exemplars WHERE id = ?").run(sampleId);
    db.prepare("DELETE FROM voice_exemplar_audio WHERE id = ?").run(sampleId);
    db.prepare(
      `INSERT INTO voice_enrollment_actions
      (id, candidate_id, profile_id, note_id, choice, before_sample) VALUES (?, ?, ?, ?, 'remove', ?)`
    ).run(
      actionId,
      sampleId,
      sample.profile_id,
      sample.note_id,
      JSON.stringify({ ...sample, embedding: sample.embedding.toString("base64") })
    );
    rebuild(db, sample.profile_id);
    history.add(db, {
      id: actionId,
      kind: "enrollment",
      profileId: sample.profile_id,
      noteId: sample.note_id,
      label: `removed: ${JSON.parse(sample.row_ids || "[]").join(", ")}`,
    });
    if (durable)
      db.prepare(
        "UPDATE speaker_global_actions SET unavailable_reason = 'voice_data_cleared' WHERE id = ?"
      ).run(actionId);
    return { success: true, id: actionId };
  })();
}
function rowCorrected(db, noteId, rowIds, explicitMappingChange = false) {
  if (
    !rowIds.length ||
    typeof db?.prepare !== "function" ||
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'voice_exemplars'")
      .get()
  )
    return;
  const affected = db
    .prepare(
      `SELECT profile_id FROM voice_exemplars WHERE note_id = ?
      UNION SELECT profile_id FROM voice_exemplar_audio WHERE note_id = ?`
    )
    .all(noteId, noteId);
  for (const { profile_id } of affected) {
    const profileName = db
      .prepare("SELECT display_name FROM speaker_profiles WHERE id = ?")
      .get(profile_id)?.display_name;
    const touched = samples(db, profile_id).filter(
      (sample) =>
        sample.note_id === noteId &&
        JSON.parse(sample.row_ids || "[]").some((id) => rowIds.includes(id)) &&
        (!sample.durable_audio ||
          explicitMappingChange ||
          rowsFor(db, noteId).some(
            (row) =>
              JSON.parse(sample.row_ids).includes(row.id) &&
              row.speakerLockSource === "user" &&
              (!attributed(db, noteId, row, profile_id) ||
                (row.speakerName && row.speakerName !== profileName))
          ))
    );
    if (touched.length) {
      for (const sample of touched) {
        if (sample.durable_audio)
          db.prepare("UPDATE voice_exemplar_audio SET valid = 0 WHERE id = ?").run(sample.id);
        db.prepare("DELETE FROM voice_exemplars WHERE id = ?").run(sample.id);
      }
      db.prepare(
        "UPDATE speaker_profiles SET voice_usable = 0, voice_needs_reapproval = 1 WHERE id = ?"
      ).run(profile_id);
      rebuild(db, profile_id);
    }
  }
}
function attributionChangedRows(beforeRaw, afterRaw) {
  const before = new Map(readTranscriptDocument(beforeRaw).rows.map((row) => [row.id, row]));
  const after = readTranscriptDocument(afterRaw).rows;
  const fields = [
    "speaker",
    "speakerName",
    "speakerIsPlaceholder",
    "suggestedProfileId",
    "speakerLockSource",
    "speakerStatus",
    "diarizationRunId",
    "correctionRevision",
    "audioSpan",
    "deleted",
  ];
  return after
    .filter((row) => {
      const prior = before.get(row.id);
      return (
        !prior ||
        fields.some((field) => JSON.stringify(prior[field]) !== JSON.stringify(row[field]))
      );
    })
    .map((row) => row.id)
    .concat([...before.keys()].filter((id) => !after.some((row) => row.id === id)));
}
function snapshotEvidence(db, actionId, profileId = null, mergedInto = null) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS voice_sample_action_snapshots (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)"
  );
  const where = profileId == null ? "" : " WHERE profile_id = ?";
  const args = profileId == null ? [] : [profileId];
  const exemplars = db
    .prepare(`SELECT * FROM voice_exemplars${where}`)
    .all(...args)
    .map((row) => ({ ...row, embedding: row.embedding?.toString("base64") || null }));
  const candidates = db
    .prepare(`SELECT * FROM voice_enrollment_candidates${where}`)
    .all(...args)
    .map((row) => ({ ...row, embedding: row.embedding?.toString("base64") || null }));
  const survivorHasSamples =
    mergedInto != null &&
    !!db.prepare("SELECT 1 FROM voice_exemplars WHERE profile_id = ? LIMIT 1").get(mergedInto);
  const survivor =
    mergedInto == null || survivorHasSamples
      ? null
      : db
          .prepare(
            `SELECT embedding, sample_count,
    voice_usable, voice_needs_reapproval FROM speaker_profiles WHERE id = ?`
          )
          .get(mergedInto);
  db.prepare("INSERT INTO voice_sample_action_snapshots (id, snapshot) VALUES (?, ?)").run(
    actionId,
    JSON.stringify({
      exemplars,
      candidates,
      audioOwnership: exemplarAudio
        .list(db, profileId)
        .map((sample) => ({ id: sample.id, profile_id: sample.profile_id })),
      derivedProfiles: [...new Set(exemplars.map((row) => row.profile_id))],
      mergedInto,
      survivorBefore: survivor && { ...survivor, embedding: survivor.embedding.toString("base64") },
    })
  );
  return { exemplars: exemplars.length, candidates: candidates.length };
}
function removeEvidence(db, profileId = null, preserveRejections = false) {
  for (const [id, session] of played)
    if (profileId == null || session.profileId === profileId) forgetPlayback(id);
  for (const table of ["voice_exemplar_audio", "voice_exemplars", "voice_enrollment_candidates"]) {
    if (table === "voice_enrollment_candidates" && preserveRejections) continue;
    const where = profileId == null ? "" : " WHERE profile_id = ?";
    db.prepare(`DELETE FROM ${table}${where}`).run(...(profileId == null ? [] : [profileId]));
  }
  if (profileId == null)
    db.prepare("UPDATE speaker_profiles SET voice_usable = 0, voice_needs_reapproval = 0").run();
  else
    db.prepare(
      "UPDATE speaker_profiles SET voice_usable = 0, voice_needs_reapproval = 0 WHERE id = ?"
    ).run(profileId);
}
function restoreEvidence(db, actionId) {
  const found = db
    .prepare("SELECT snapshot FROM voice_sample_action_snapshots WHERE id = ?")
    .get(actionId);
  if (!found) return [];
  const {
    exemplars,
    candidates,
    derivedProfiles = [],
    mergedInto,
    survivorBefore,
    audioOwnership = [],
  } = JSON.parse(found.snapshot);
  const profiles = new Set(derivedProfiles);
  for (const sample of audioOwnership) {
    if (!db.prepare("SELECT 1 FROM speaker_profiles WHERE id = ?").get(sample.profile_id)) continue;
    db.prepare("UPDATE voice_exemplar_audio SET profile_id = ? WHERE id = ?").run(
      sample.profile_id,
      sample.id
    );
    profiles.add(sample.profile_id);
  }
  const sourceDeleted = (noteId) =>
    !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meeting_audio_tombstones'")
      .get() &&
    !!db.prepare("SELECT 1 FROM meeting_audio_tombstones WHERE note_id = ?").get(noteId);
  for (const row of exemplars) {
    if (
      sourceDeleted(row.note_id) ||
      !db.prepare("SELECT 1 FROM notes WHERE id = ?").get(row.note_id) ||
      !db.prepare("SELECT 1 FROM speaker_profiles WHERE id = ?").get(row.profile_id)
    )
      continue;
    const columns = Object.keys(row);
    db.prepare(
      `INSERT OR REPLACE INTO voice_exemplars (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`
    ).run(
      ...columns.map((column) =>
        column === "embedding" && row[column] ? Buffer.from(row[column], "base64") : row[column]
      )
    );
    profiles.add(row.profile_id);
  }
  for (const row of candidates) {
    if (
      sourceDeleted(row.note_id) ||
      !db.prepare("SELECT 1 FROM notes WHERE id = ?").get(row.note_id) ||
      !db.prepare("SELECT 1 FROM speaker_profiles WHERE id = ?").get(row.profile_id)
    )
      continue;
    const columns = Object.keys(row);
    db.prepare(
      `INSERT OR REPLACE INTO voice_enrollment_candidates (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`
    ).run(
      ...columns.map((column) =>
        column === "embedding" && row[column] ? Buffer.from(row[column], "base64") : row[column]
      )
    );
  }
  db.prepare("DELETE FROM voice_sample_action_snapshots WHERE id = ?").run(actionId);
  for (const id of profiles)
    if (db.prepare("SELECT 1 FROM speaker_profiles WHERE id = ?").get(id)) rebuild(db, id);
  if (
    mergedInto != null &&
    db.prepare("SELECT 1 FROM speaker_profiles WHERE id = ?").get(mergedInto)
  ) {
    if (!survivorBefore) rebuild(db, mergedInto);
    else
      db.prepare(
        `UPDATE speaker_profiles SET embedding = ?, sample_count = ?,
      voice_usable = ?, voice_needs_reapproval = ? WHERE id = ?`
      ).run(
        Buffer.from(survivorBefore.embedding, "base64"),
        survivorBefore.sample_count,
        survivorBefore.voice_usable,
        survivorBefore.voice_needs_reapproval,
        mergedInto
      );
  }
  return [...profiles];
}
function pruneSnapshots(db, field, id) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'voice_sample_action_snapshots'"
      )
      .get()
  )
    return;
  for (const saved of db.prepare("SELECT id, snapshot FROM voice_sample_action_snapshots").all()) {
    const snapshot = JSON.parse(saved.snapshot);
    let changed = false;
    for (const table of ["exemplars", "candidates"]) {
      const before = snapshot[table].length;
      snapshot[table] = snapshot[table].filter((row) => row[field] !== id);
      changed ||= snapshot[table].length !== before;
    }
    if (field === "note_id" && changed && snapshot.survivorBefore) {
      snapshot.survivorBefore = null;
    }
    if (field === "profile_id" && snapshot.derivedProfiles?.includes(id)) {
      snapshot.derivedProfiles = snapshot.derivedProfiles.filter((profileId) => profileId !== id);
      changed = true;
    }
    if (field === "profile_id" && snapshot.mergedInto === id) {
      snapshot.exemplars = [];
      snapshot.candidates = [];
      snapshot.derivedProfiles = [];
      snapshot.survivorBefore = null;
      changed = true;
    }
    if (changed)
      db.prepare("UPDATE voice_sample_action_snapshots SET snapshot = ? WHERE id = ?").run(
        JSON.stringify(snapshot),
        saved.id
      );
  }
}
function removeNoteEvidence(db, noteId) {
  const affected = new Set(
    db
      .prepare("SELECT DISTINCT profile_id FROM voice_exemplars WHERE note_id = ?")
      .all(noteId)
      .map((row) => row.profile_id)
  );
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='voice_sample_action_snapshots'"
      )
      .get()
  )
    for (const saved of db.prepare("SELECT snapshot FROM voice_sample_action_snapshots").all())
      for (const row of JSON.parse(saved.snapshot).exemplars || [])
        if (row.note_id === noteId) affected.add(row.profile_id);
  db.exec("CREATE TABLE IF NOT EXISTS meeting_audio_tombstones (note_id INTEGER PRIMARY KEY)");
  db.prepare("INSERT OR IGNORE INTO meeting_audio_tombstones (note_id) VALUES (?)").run(noteId);
  require("./peopleActions").scrubDeletedRecordingSnapshots(db, noteId, [...affected]);
  pruneSnapshots(db, "note_id", noteId);
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_global_actions'"
      )
      .get()
  )
    db.prepare(
      `UPDATE speaker_global_actions SET unavailable_reason = 'audio_deleted'
      WHERE id IN (SELECT id FROM voice_enrollment_actions WHERE note_id = ?)`
    ).run(noteId);
  db.prepare("DELETE FROM voice_enrollment_actions WHERE note_id = ?").run(noteId);
  db.prepare("DELETE FROM voice_enrollment_candidates WHERE note_id = ?").run(noteId);
  db.prepare("DELETE FROM voice_exemplars WHERE note_id = ?").run(noteId);
  for (const profileId of affected) {
    rebuild(db, profileId);
    if (exemplarAudio.list(db, profileId).length) continue;
    db.prepare("UPDATE speaker_profiles SET voice_needs_reapproval = 1 WHERE id = ?").run(
      profileId
    );
  }
}
module.exports = {
  MAX_SAMPLES,
  ENROLLMENT_RULES_VERSION,
  listCandidates,
  candidateReport,
  createEligibilityContext,
  listSamples,
  play,
  complete,
  decide,
  playbackContext,
  progress,
  rebuild,
  resolveProfile,
  undo,
  removeSample,
  rowCorrected,
  snapshotEvidence,
  removeEvidence,
  restoreEvidence,
  pruneSnapshots,
  removeNoteEvidence,
  calibration,
  attributionChangedRows,
};
