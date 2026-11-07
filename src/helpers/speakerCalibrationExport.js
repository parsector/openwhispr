const { createHash } = require("node:crypto");
const { readTranscriptDocument } = require("./transcriptDocument");
const { readSpeakerActionLog } = require("./speakerActionLog");
const {
  resolveMeetingAudioSpan,
  createMeetingAudioSpanContext,
} = require("./meetingAudioSpan.mjs");

function machineAssignment(row, related, personChanges) {
  const ordered = [...related].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  const machineAction = ordered.findLast(
    (action) =>
      action.event?.actor === "machine" &&
      action.event.snapshots?.[row.id]?.next?.speakerName &&
      action.event.snapshots[row.id].next.speakerLockSource !== "user"
  );
  const firstOwnerAction = ordered.find((action) => action.event?.actor !== "machine");
  if (firstOwnerAction) {
    if (machineAction && (machineAction.sequence || 0) > (firstOwnerAction.sequence || 0))
      return { label: machineAction.event.snapshots[row.id].next.speakerName };
    if (personChanges.some((action) => (action.sequence || 0) <= (firstOwnerAction.sequence || 0)))
      return machineAction
        ? { label: machineAction.event.snapshots[row.id].next.speakerName }
        : { label: null, reason: "owner_person_change" };
    const saved = firstOwnerAction.event?.snapshots?.[row.id];
    const previous = saved?.previous || (firstOwnerAction.kind === "split" ? saved : null);
    if (!previous) return { label: null, reason: "missing_snapshot" };
    if (!previous.speakerName) return { label: null, reason: "no_machine_assignment" };
    if (previous.speakerLockSource === "user") return { label: null, reason: "owner_label_only" };
    if (previous.speakerStatus !== "confirmed" && previous.machineReason !== "approved_voice")
      return { label: null, reason: "legacy_provenance_unknown" };
    return { label: previous.speakerName };
  }

  if (personChanges.length)
    return machineAction
      ? { label: machineAction.event.snapshots[row.id].next.speakerName }
      : { label: null, reason: "owner_person_change" };
  if (!row.speakerName) return { label: null, reason: "no_machine_assignment" };
  if (row.speakerLockSource === "user") return { label: null, reason: "owner_label_only" };
  if (row.speakerStatus !== "confirmed" && row.machineReason !== "approved_voice")
    return { label: null, reason: "legacy_provenance_unknown" };
  return { label: row.speakerName };
}

function buildCalibrationLabels(note, audio, status = {}) {
  const actions = readSpeakerActionLog(note).actions;
  const transcriptRows = readTranscriptDocument(note.transcript).rows;
  const recordingId = status.recordingId ?? note.id;
  const context = createMeetingAudioSpanContext(
    transcriptRows,
    recordingId,
    status.startedAt,
    status.tracks
  );
  const relatedByRow = new Map(),
    peopleByRow = new Map();
  const add = (map, id, action) => {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(action);
  };
  for (const action of actions) {
    if (["correction", "split", "reconsideration"].includes(action.kind))
      for (const id of new Set(
        action.event?.affectedRowIds ||
          action.event?.rowIds ||
          (action.event?.rowId ? [action.event.rowId] : [])
      ))
        add(relatedByRow, id, action);
    if (action.kind === "person" && action.action !== "reset")
      for (const id of new Set((action.before || []).map((saved) => saved.id)))
        add(peopleByRow, id, action);
  }
  const rows = transcriptRows.map((row) => {
    const related = relatedByRow.get(row.id) || [];
    const resolved = resolveMeetingAudioSpan(
      row,
      transcriptRows,
      recordingId,
      status.startedAt,
      status.tracks,
      context
    );
    const firstCorrection = related.find((action) => action.event?.actor !== "machine");
    const personChanges = peopleByRow.get(row.id) || [];
    const machine = machineAssignment(row, related, personChanges);
    const ownerCorrectionActionIds = related
      .filter((action) => action.event?.actor !== "machine")
      .map((action) => action.id);
    return {
      rowId: row.id,
      track: resolved.track ?? row.source,
      start: resolved.start ?? null,
      end: resolved.end ?? null,
      from: resolved.from ?? null,
      to: resolved.to ?? null,
      approximate: resolved.approximate ?? true,
      unavailableReason: resolved.reason,
      textHash: createHash("sha256")
        .update(String(row.text || ""))
        .digest("hex"),
      currentLabel: row.speakerName || null,
      machineLabel: machine.label,
      ...(machine.reason ? { machineLabelUnavailable: machine.reason } : {}),
      corrected: !!firstCorrection,
      ownerCorrectionActionIds,
      currentOverlapDetected: row.uncertainty?.reason === "overlapping_speech",
      finalPassChanged: !!row.finalRevision,
      // The owner must review these independently; current labels can be wrong.
      truePerson: null,
      trueOverlap: null,
    };
  });
  return { version: 1, synthetic: false, audio, rows };
}

module.exports = { buildCalibrationLabels };
