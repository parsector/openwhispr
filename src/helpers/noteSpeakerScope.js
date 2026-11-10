const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const {
  resolveSpeakerRoster,
  eligible,
  humanProtected,
  SPEAKER_ROSTER_POLICY_VERSION,
} = require("./speakerRosterPolicy");
const { readTranscriptDocument, writeTranscriptDocument } = require("./transcriptDocument");
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Only reads note, its linked event, and profile identities. In particular this
// must never registerAttendees: that legacy path also links by display name.
function readScope(database, noteId, profiles = null, noteOverride = null) {
  try {
    const note = noteOverride || (noteId != null ? database?.getNote?.(noteId) : null);
    const identities = database?.db
      ? database.db.prepare("SELECT id, email FROM speaker_profiles ORDER BY id").all()
      : profiles || database?.getSpeakerProfiles?.() || [];
    const event =
      note?.participants == null && note?.calendar_event_id
        ? database?.getCalendarEventById?.(note.calendar_event_id)
        : null;
    return resolveSpeakerRoster(note, event, identities);
  } catch {
    return resolveSpeakerRoster(null, null);
  }
}

let modelCache = null;
function modelFingerprint() {
  try {
    const path = require("./speakerEmbeddings").getModelPath();
    const stat = fs.statSync(path);
    const key = `${path}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (modelCache?.key !== key) modelCache = { key, fingerprint: hash(fs.readFileSync(path)) };
    return modelCache.fingerprint;
  } catch {
    return null; // unavailable is evidence, never invent a model hash
  }
}
function profileFingerprint(profile) {
  if (!profile?.embedding) return null;
  const vector = profile.embedding;
  const bytes = Array.isArray(vector)
    ? Buffer.from(Float32Array.from(vector).buffer)
    : Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  return hash(
    Buffer.concat([
      Buffer.from(JSON.stringify([profile.id, profile.voice_usable, profile.updated_at])),
      bytes,
    ])
  );
}
function decision(
  scope,
  { runId, path, profile = null, profiles = [], scores = null, rejectionReason = null }
) {
  return {
    candidateSetStatus: "recorded",
    decisionId: randomUUID(),
    runId: runId || randomUUID(),
    noteId: scope.noteId,
    rosterRevision: scope.rosterRevision,
    linkedEventId: scope.linkedEventId,
    source: scope.source,
    revision: scope.revision,
    rawRoster: scope.rawRoster,
    roster: scope.roster,
    unrestricted: scope.unrestricted,
    scopeFailure: scope.failure,
    eligibleProfileIds: [...scope.eligibleProfileIds],
    policyVersion: SPEAKER_ROSTER_POLICY_VERSION,
    acceptedProfileId: rejectionReason ? null : (profile?.id ?? null),
    acousticWinnerProfileId: profile?.id ?? null,
    origin: "machine",
    path,
    scores,
    rejectionReason,
    profileFingerprints: profiles.map((p) => ({ id: p.id, fingerprint: profileFingerprint(p) })),
    modelFingerprint: modelFingerprint(),
  };
}
function veto(row, evidence) {
  if (humanProtected(row)) return row;
  row.speakerName = undefined;
  row.speakerIsPlaceholder = true;
  row.suggestedName = undefined;
  row.suggestedProfileId = undefined;
  row.speakerStatus = "provisional";
  row.machineReason = undefined;
  if (row.uncertainty?.candidates) row.uncertainty = { reason: row.uncertainty.reason };
  row.speakerDecision = evidence;
  return row;
}

// Recheck at every commit, including saves from a renderer holding an old final
// result. Never rewrite historical unrecorded rows merely because they are read.
function enforceRows(
  database,
  noteId,
  rows,
  { runId, path = "commit", scope, profiles, includeUnrecorded = false, noteOverride } = {}
) {
  const current = readScope(database, noteId, profiles, noteOverride);
  for (const row of rows) {
    if (humanProtected(row)) continue;
    const recorded = row.speakerDecision;
    if (!recorded && !includeUnrecorded) continue;
    const profileId = recorded?.acceptedProfileId ?? row.suggestedProfileId;
    const stale = (recorded?.revision || scope?.revision) !== current.revision;
    if (recorded?.rejectionReason && !stale) {
      veto(row, recorded);
      continue;
    }
    const unsafe =
      row.overlap ||
      [
        "too_short",
        "close_match",
        "not_sure",
        "overlapping_speech",
        "possible_mixed_speakers",
      ].includes(row.uncertainty?.reason);
    if (stale || !eligible(current, profileId) || unsafe) {
      const evidence = decision(current, {
        runId: runId || recorded?.runId,
        path,
        rejectionReason: stale ? "roster_changed" : unsafe ? "unsafe_span" : "outside_roster",
        profiles: profiles || [],
      });
      // Read projections participate in expectedTranscript comparisons. The
      // same saved decision and roster must produce the same veto on each read.
      if (recorded) {
        evidence.decisionId = hash(
          JSON.stringify([recorded.decisionId, row.id, current.revision, path])
        );
        evidence.profileFingerprints = recorded.profileFingerprints || evidence.profileFingerprints;
        if (Object.hasOwn(recorded, "modelFingerprint"))
          evidence.modelFingerprint = recorded.modelFingerprint;
      }
      evidence.previousDecision = recorded || null;
      veto(row, evidence);
    }
  }
  return rows;
}
function enforceTranscript(database, noteId, raw, options) {
  const doc = readTranscriptDocument(raw);
  return writeTranscriptDocument(
    enforceRows(database, noteId, doc.rows, options),
    doc.unknownNumberHighWater
  );
}
module.exports = {
  readScope,
  decision,
  veto,
  enforceRows,
  enforceTranscript,
  profileFingerprint,
  modelFingerprint,
};
