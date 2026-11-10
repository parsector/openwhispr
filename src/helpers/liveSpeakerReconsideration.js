const { resolveAutomaticSpeaker } = require("./automaticSpeakerAttribution");
const {
  needsSpeakerReevaluation,
  evaluationSnapshot,
  rowForSpeakerEvaluation,
} = require("./speakerRowEvaluation");
const speakerScope = require("./noteSpeakerScope");
const { eligible, humanProtected, recordedNameAllowed } = require("./speakerRosterPolicy");
// Reassess only unnamed, clean clusters in the current run. The identifier
// supplies acoustic evidence; transcript rows supply the owner's decisions.
const { randomUUID } = require("node:crypto");
const {
  readTranscriptDocument,
  writeTranscriptDocument,
  normalizeRowIds,
} = require("./transcriptDocument");
const { readSpeakerActionLog, appendAction } = require("./speakerActionLog");
const history = require("./speakerGlobalHistory");

const FIELDS = [
  "speakerName",
  "speakerIsPlaceholder",
  "speakerStatus",
  "speakerLockSource",
  "suggestedName",
  "suggestedProfileId",
  "uncertainty",
  "machineReason",
  "speakerDecision",
];
const snapshot = (row) =>
  Object.fromEntries(FIELDS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));

function eligibilityState(identifier, speakerId, rows) {
  const cohort = identifier.transientCohorts.get(speakerId) || "system";
  if (!rows.length) return "insufficient-evidence";
  if (identifier.dismissedReconsiderations?.has(speakerId)) return "owner-rejected";
  if (rows.some((row) => row.speakerLockSource === "user" && !row.speakerName))
    return "explicit-unknown";
  if (identifier.getAnchorState(speakerId) === "active") return "anchored";
  if (rows.some((row) => row.speakerLockSource === "user" && row.speakerName))
    return "confirmed-by-owner";
  if (rows.some(humanProtected)) return "locked";
  if (rows.some((row) => row.overlap || row.uncertainty?.reason === "overlapping_speech"))
    return "uncertain-overlap";
  if (
    rows.some(
      (row) => row.source !== cohort || row.uncertainty?.reason === "possible_mixed_speakers"
    )
  )
    return "mixed-audio";
  if (rows.some((row) => row.uncertainty?.reason === "too_short")) return "insufficient-evidence";
  if (rows.some((row) => row.uncertainty && row.uncertainty.reason !== "close_match"))
    return "uncertain";
  if (rows.some((row) => row.speakerName && !row.speakerIsPlaceholder)) return "machine-matched";
  if (rows.some((row) => row.suggestedName || row.suggestedProfileId))
    return "provisional-suggestion";
  if (
    (identifier.transientVoicedSamples.get(speakerId) || 0) < 16000 * 3 ||
    (identifier.transientObservations.get(speakerId) || 0) < 2
  )
    return "insufficient-evidence";
  if ((identifier.transientMinimumSimilarity.get(speakerId) ?? 1) < 0.8) return "mixed-audio";
  return "eligible-unmatched";
}

function reconsiderLiveClusters(
  database,
  identifier,
  noteId,
  runId,
  liveRows = [],
  evaluations = new Map()
) {
  if (!identifier.running || identifier.activeRunId !== runId || !runId || !noteId)
    return { assignments: [], skipped: [{ reason: "not_current_meeting" }] };
  const result = database.db.transaction(() => {
    const note = database.getNote(noteId);
    if (!note || note.deleted_at) return { assignments: [], skipped: [{ reason: "note_missing" }] };
    let log = readSpeakerActionLog(note);
    if (log.quarantined) return { assignments: [], skipped: [{ reason: "history_quarantined" }] };
    const doc = readTranscriptDocument(note.transcript);
    const persisted = normalizeRowIds(doc.rows, note.client_note_id || noteId);
    const byId = new Map(persisted.map((row) => [row.id, row]));
    for (const row of normalizeRowIds(liveRows, note.client_note_id || noteId))
      if (row?.id && !byId.has(row.id)) byId.set(row.id, row);
    const rows = [...byId.values()];
    const assignments = [],
      skipped = [];
    let changed = false;
    const currentScope = speakerScope.readScope(database, noteId);
    const profiles = identifier.getSpeakerProfiles?.() || [];
    const fingerprints = evaluationSnapshot(profiles);
    currentScope.profileFingerprints = fingerprints;
    const cachedScope = identifier.getSpeakerScope?.() || currentScope;
    cachedScope.profileFingerprints = fingerprints;
    const membersBySpeaker = new Map();
    for (const row of rows) {
      if (row.deleted || row.diarizationRunId !== runId) continue;
      const cohort = identifier.transientCohorts.get(row.speaker) || "system";
      if (row.source !== cohort) continue;
      const members = membersBySpeaker.get(row.speaker) || [];
      members.push(row);
      membersBySpeaker.set(row.speaker, members);
    }
    const jobs = [];
    for (const [speakerId] of identifier.transientEmbeddings) {
      const members = membersBySpeaker.get(speakerId) || [];
      const clean = [];
      for (const row of members) {
        if (!row.speakerDecision || recordedNameAllowed(row) || humanProtected(row)) {
          clean.push(row);
          continue;
        }
        if (
          !evaluations.has(row.id) &&
          !needsSpeakerReevaluation(row, currentScope, profiles, fingerprints)
        )
          continue;
        const reevaluation = evaluations.get(row.id);
        if (
          !reevaluation?.embedding ||
          !reevaluation.audioContentHash ||
          reevaluation.previousDecisionId !== row.speakerDecision.decisionId
        )
          continue;
        jobs.push({ speakerId, cluster: [row], reevaluation });
      }
      if (clean.length || !members.length) jobs.push({ speakerId, cluster: clean });
    }
    for (const { speakerId, cluster, reevaluation } of jobs) {
      const cohort = identifier.transientCohorts.get(speakerId) || "system";
      const state = eligibilityState(
        identifier,
        speakerId,
        cluster.map((row) => rowForSpeakerEvaluation(row, reevaluation))
      );
      identifier.setEligibilityState(speakerId, state);
      if (state !== "eligible-unmatched") {
        skipped.push({ speakerId, reason: state });
        continue;
      }
      const match =
        reevaluation?.match ||
        identifier.matchEligibleCluster(speakerId, reevaluation?.embedding, {
          profiles,
          scope: cachedScope,
        });
      if (!match?.profile) {
        const reason = match?.reason || "no_match";
        skipped.push({ speakerId, reason });
        if (match?.speakerDecision) {
          for (const row of cluster) speakerScope.veto(row, match.speakerDecision, currentScope);
          changed = true;
        }
        if (reason === "close_match")
          for (const row of cluster) {
            if (row.uncertainty?.reason !== "close_match" || row.speakerStatus !== "provisional") {
              row.uncertainty = { reason: "close_match" };
              row.speakerStatus = "provisional";
              changed = true;
            }
          }
        continue;
      }
      const profile = match.profile;
      const scope = currentScope;
      if (
        !eligible(scope, profile.id) ||
        (match.speakerDecision && match.speakerDecision.revision !== scope.revision)
      ) {
        for (const row of cluster)
          speakerScope.veto(
            row,
            speakerScope.decision(scope, {
              runId,
              path: "live_reconsideration",
              profile,
              rejectionReason: "outside_roster",
              profiles: [profile],
              profileFingerprints: fingerprints,
            }),
            currentScope
          );
        changed = true;
        skipped.push({ speakerId, reason: "outside_roster" });
        continue;
      }
      const evidence =
        match.speakerDecision ||
        speakerScope.decision(scope, {
          runId,
          path: "live_reconsideration",
          profile,
          profiles: [profile],
          profileFingerprints: fingerprints,
        });
      const id = randomUUID();
      const snapshots = {};
      const sequence = log.nextSequence;
      for (const row of cluster) {
        const previous = snapshot(row);
        const incoming = {
          ...row,
          speakerName: profile.display_name,
          speakerIsPlaceholder: false,
          speakerStatus: cohort === "mic" ? "provisional" : "confirmed",
          suggestedName: undefined,
          suggestedProfileId: profile.id,
          uncertainty: undefined,
          machineReason: "approved_voice",
          speakerDecision: evidence,
          ...(reevaluation ? { audioContentHash: reevaluation.audioContentHash } : {}),
        };
        if (reevaluation) Object.assign(row, incoming);
        else Object.assign(row, resolveAutomaticSpeaker(row, row.speakerDecision, scope, incoming));
        if (!row.speakerName || !recordedNameAllowed(row)) continue;
        snapshots[row.id] = { previous, next: snapshot(row) };
      }
      const admitted = cluster.filter((row) => snapshots[row.id]);
      if (!admitted.length) {
        skipped.push({ speakerId, reason: "row_veto" });
        continue;
      }
      const event = {
        id,
        noteId,
        actor: "machine",
        timestamp: new Date().toISOString(),
        sequence,
        diarizationRunId: runId,
        clusterId: speakerId,
        affectedRowIds: admitted.map((row) => row.id),
        snapshots,
      };
      const nextLog = appendAction(log, { kind: "reconsideration", id, event });
      if (!nextLog) return { assignments: [], skipped: [{ reason: "history_full" }] };
      log = nextLog;
      identifier.setEligibilityState(speakerId, "machine-matched");
      assignments.push({
        speakerId,
        displayName: profile.display_name,
        profileId: profile.id,
        actionId: id,
        speakerDecision: evidence,
        rows: admitted.map((row) => row),
      });
      changed = true;
    }
    if (changed) {
      const transcript = writeTranscriptDocument(rows, doc.unknownNumberHighWater);
      const result = database.updateNote(
        noteId,
        {
          transcript,
          speaker_action_log: JSON.stringify(log),
          speaker_label_undo: null,
        },
        { speakerEvaluations: evaluations }
      );
      if (!result?.success) throw Error(result?.error || "transcript_failed");
      const committed = new Map(
        readTranscriptDocument(
          result.note?.transcript || database.getNote(noteId).transcript
        ).rows.map((row) => [row.id, row])
      );
      for (let i = 0; i < rows.length; i++) rows[i] = committed.get(rows[i].id) || rows[i];
      for (let i = assignments.length - 1; i >= 0; i--) {
        const assignment = assignments[i];
        assignment.rows = assignment.rows
          .map((row) => committed.get(row.id) || row)
          .filter((row) => row.speakerName && recordedNameAllowed(row));
        if (!assignment.rows.length) {
          assignments.splice(i, 1);
          continue;
        }
        history.add(database.db, {
          id: assignment.actionId,
          kind: "reconsideration",
          profileId: assignment.profileId,
          noteId,
          label: `Recognised ${assignment.displayName}`,
        });
      }
    }
    return { assignments, skipped, rows: changed ? rows : [], changed };
  })();
  for (const assignment of result.assignments)
    identifier.mapSpeaker(
      assignment.speakerId,
      assignment.profileId,
      assignment.displayName,
      noteId,
      assignment.speakerDecision
    );
  return result;
}

function undoReconsideration(database, identifier, noteId, id) {
  return require("./speakerCorrectionTransaction").applySpeakerCorrection(database, identifier, {
    type: "undo",
    noteId,
    id,
  });
}

module.exports = { eligibilityState, reconsiderLiveClusters, undoReconsideration };
