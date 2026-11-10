const {
  resolveAutomaticSpeaker,
  currentSpeakerDecision,
} = require("./automaticSpeakerAttribution");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const {
  resolveSpeakerRoster,
  eligible,
  humanProtected,
  recordedNameAllowed,
  normalizedEmail,
  SPEAKER_ROSTER_POLICY_VERSION,
} = require("./speakerRosterPolicy");
const { readTranscriptDocument, writeTranscriptDocument } = require("./transcriptDocument");
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Only reads note, its linked event, and profile identities. In particular this
// must never registerAttendees: that legacy path also links by display name.
function readScope(database, noteId, profiles = null, noteOverride = null) {
  try {
    const note = noteOverride || (noteId != null ? database?.getNote?.(noteId) : null);
    const identities = database?.db?.prepare
      ? database.db.prepare("SELECT id, email FROM speaker_profiles ORDER BY id").all()
      : profiles || database?.getSpeakerProfiles?.() || [];
    return resolveSpeakerRoster(note && { ...note, deleted_at: null }, null, identities);
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
  {
    runId,
    path,
    profile = null,
    runnerUpProfileId = null,
    profiles = [],
    scores = null,
    effectiveThresholds = null,
    rejectionReason = null,
    profileFingerprints,
  }
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
    acceptedIdentity: rejectionReason ? null : { email: normalizedEmail(profile?.email) },
    acousticWinnerProfileId: profile?.id ?? null,
    acousticRunnerUpProfileId: runnerUpProfileId,
    effectiveThresholds,
    origin: "machine",
    path,
    scores,
    rejectionReason,
    profileFingerprints:
      profileFingerprints ||
      scope.profileFingerprints ||
      profiles.map((p) => ({ id: p.id, fingerprint: profileFingerprint(p) })),
    acousticEvaluation: "evaluated",
    modelFingerprint: modelFingerprint(),
  };
}
function veto(row, evidence, scope) {
  Object.assign(
    row,
    resolveAutomaticSpeaker(row, row.speakerDecision, scope, {
      ...row,
      speakerName: undefined,
      speakerIsPlaceholder: true,
      suggestedName: undefined,
      suggestedProfileId: undefined,
      speakerStatus: "provisional",
      machineReason: undefined,
      uncertainty: row.uncertainty?.candidates
        ? { reason: row.uncertainty.reason }
        : row.uncertainty,
      speakerDecision: evidence,
    })
  );
  return row;
}

// Recheck at every commit, including saves from a renderer holding an old final
// result. Restricted legacy names become reviewable Unknowns; known human
// choices remain authoritative.
function enforceRows(
  database,
  noteId,
  rows,
  {
    runId,
    path = "commit",
    scope,
    profiles,
    includeUnrecorded = false,
    noteOverride,
    storedRows = null,
    restorationRowIds = [],
    evaluations = new Map(),
  } = {}
) {
  const current = readScope(database, noteId, profiles, noteOverride);
  // Fingerprints are checked against the library at installation time, so an
  // evaluation made before a profile edit cannot supersede a veto.
  let currentProfiles = [];
  try {
    currentProfiles = profiles || database?.getSpeakerProfiles?.(true) || [];
    current.profileFingerprints = currentProfiles.map((profile) => ({
      id: profile.id,
      fingerprint: profileFingerprint(profile),
    }));
  } catch {
    current.profileFingerprints = [];
  }

  try {
    current.speaker_mapping_labels = database?.db?.prepare
      ? Object.fromEntries(
          database.db
            .prepare("SELECT speaker_id, display_name FROM speaker_mappings WHERE note_id = ?")
            .all(noteId)
            .map((mapping) => [mapping.speaker_id, mapping.display_name])
        )
      : noteOverride?.speaker_mapping_labels || {};
  } catch {
    current.speaker_mapping_labels = {};
  }
  let importedIdentities;
  const stored = new Map((storedRows || []).map((row) => [row.id, row]));
  const finish = (row) => {
    const own =
      stored.get(row.id) || stored.get(row.parentRowId) || (storedRows ? { id: row.id } : row);
    const evaluated = evaluations.get(row.id);
    if (evaluated && row.speakerDecision && recordedNameAllowed(row)) {
      row.speakerDecision = { ...row.speakerDecision, evaluation: evaluated.evaluation };
      row.audioContentHash = evaluated.audioContentHash;
      row.audioSpan = evaluated.audioSpan;
    }
    Object.assign(
      row,
      resolveAutomaticSpeaker(own, own.speakerDecision, current, row, { restorationRowIds })
    );
  };
  for (const row of rows) {
    if (humanProtected(row)) {
      Object.assign(row, resolveAutomaticSpeaker(row, row.speakerDecision, current, row));
      continue;
    }
    if (!row.speakerDecision && row.speakerAssignment?.origin === "machine") {
      const assignment = row.speakerAssignment;
      let matches = [];
      try {
        importedIdentities ||= database?.db?.prepare
          ? database.db.prepare("SELECT id, email FROM speaker_profiles ORDER BY id").all()
          : profiles || database?.getSpeakerProfiles?.() || [];
        const identities = importedIdentities;
        const email = normalizedEmail(assignment.email);
        if (email) matches = identities.filter((p) => normalizedEmail(p.email) === email);
      } catch {
        /* unresolved imports fail closed */
      }
      const profile = matches.length === 1 ? matches[0] : null;
      row.speakerDecision = decision(current, {
        runId: `sync:${row.id}`,
        path: "sync_import",
        profile,
        rejectionReason: !assignment.accepted
          ? "imported_rejection"
          : !profile
            ? "identity_unresolved"
            : !eligible(current, profile.id)
              ? "outside_roster"
              : null,
      });
      row.speakerDecision.decisionId = hash(JSON.stringify([row.id, assignment, current.revision]));
      // This device checked identity and scope, not the original audio/model.
      row.speakerDecision.acousticWinnerProfileId = null;
      row.speakerDecision.modelFingerprint = null;
      row.speakerDecision.acousticEvaluation = "not_evaluated";
      row.speakerDecision.candidateSetStatus = "not_recorded";
    }
    const prior = stored.get(row.id) || stored.get(row.parentRowId);
    if (prior?.speakerDecision && !recordedNameAllowed(prior) && recordedNameAllowed(row)) {
      // A proposed supersession must reach the boundary intact. Replacing its
      // decision here would erase the very binding/revision failure we audit.
      finish(row);
      continue;
    }
    const recorded = row.speakerDecision;
    if (!recorded && !includeUnrecorded) {
      finish(row);
      continue;
    }
    const profileId = recorded?.acceptedProfileId ?? row.suggestedProfileId;
    const stale = !currentSpeakerDecision(recorded || scope, current);
    if (recorded?.rejectionReason && !stale) {
      veto(row, recorded, current);
      finish(row);
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
        profileFingerprints: current.profileFingerprints,
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
      // Scope validation does not evaluate audio or record an acoustic candidate
      // set. A derived refusal carries only the provenance its source had.
      evidence.candidateSetStatus = recorded?.candidateSetStatus ?? "not_recorded";
      evidence.acousticEvaluation = recorded?.acousticEvaluation ?? "not_evaluated";
      veto(row, evidence, current);
      row.speakerBoundary = {
        refusalReason: stale ? "revision" : unsafe ? "audio" : "profile",
        proposedDecisionId: recorded?.decisionId ?? null,
        controllingDecisionId: evidence.decisionId,
      };
    }
    finish(row);
  }
  return rows;
}
function enforceTranscript(database, noteId, raw, options) {
  const doc = readTranscriptDocument(raw);
  const before = JSON.stringify(doc.rows);
  const rows = enforceRows(database, noteId, doc.rows, options);
  // A read projection is not a format migration. Preserve optimistic-save
  // tokens and legacy history references when attribution did not change.
  if (JSON.stringify(rows) === before) return raw;
  return writeTranscriptDocument(rows, doc.unknownNumberHighWater);
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
