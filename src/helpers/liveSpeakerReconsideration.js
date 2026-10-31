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
];
const snapshot = (row) =>
  Object.fromEntries(FIELDS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));

function eligibilityState(identifier, speakerId, rows) {
  if (!rows.length) return "insufficient-evidence";
  if (identifier.dismissedReconsiderations?.has(speakerId)) return "owner-rejected";
  if (rows.some((row) => row.speakerLockSource === "user" && !row.speakerName))
    return "explicit-unknown";
  if (identifier.getAnchorState(speakerId) === "active") return "anchored";
  if (rows.some((row) => row.speakerLockSource === "user" && row.speakerName))
    return "confirmed-by-owner";
  if (rows.some((row) => row.speakerLocked || row.speakerStatus === "locked")) return "locked";
  if (rows.some((row) => row.overlap || row.uncertainty?.reason === "overlapping_speech"))
    return "uncertain-overlap";
  if (
    rows.some(
      (row) => row.source !== "system" || row.uncertainty?.reason === "possible_mixed_speakers"
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

function reconsiderLiveClusters(database, identifier, noteId, runId, liveRows = []) {
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
    for (const [speakerId] of identifier.transientEmbeddings) {
      if ((identifier.transientCohorts.get(speakerId) || "system") !== "system") continue;
      const cluster = rows.filter(
        (row) => !row.deleted && row.diarizationRunId === runId && row.speaker === speakerId
      );
      const state = eligibilityState(identifier, speakerId, cluster);
      identifier.setEligibilityState(speakerId, state);
      if (state !== "eligible-unmatched") {
        skipped.push({ speakerId, reason: state });
        continue;
      }
      const match = identifier.matchEligibleCluster(speakerId);
      if (!match?.profile) {
        const reason = match?.reason || "no_match";
        skipped.push({ speakerId, reason });
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
      const id = randomUUID();
      const snapshots = {};
      const sequence = log.nextSequence;
      for (const row of cluster) {
        const previous = snapshot(row);
        row.speakerName = profile.display_name;
        row.speakerIsPlaceholder = false;
        row.speakerStatus = "confirmed";
        row.suggestedName = undefined;
        row.suggestedProfileId = profile.id;
        row.uncertainty = undefined;
        row.machineReason = "approved_voice";
        snapshots[row.id] = { previous, next: snapshot(row) };
      }
      const event = {
        id,
        noteId,
        actor: "machine",
        timestamp: new Date().toISOString(),
        sequence,
        diarizationRunId: runId,
        clusterId: speakerId,
        affectedRowIds: cluster.map((row) => row.id),
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
        rows: cluster.map((row) => row),
      });
      changed = true;
    }
    if (changed) {
      const transcript = writeTranscriptDocument(rows, doc.unknownNumberHighWater);
      const result = database.updateNote(noteId, {
        transcript,
        speaker_action_log: JSON.stringify(log),
        speaker_label_undo: null,
      });
      if (!result?.success) throw Error(result?.error || "transcript_failed");
      for (const assignment of assignments) {
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
      noteId
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
