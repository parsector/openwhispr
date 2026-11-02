const { createHash } = require("node:crypto");
const { readTranscriptDocument } = require("./transcriptDocument");
const { readSpeakerActionLog } = require("./speakerActionLog");

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
  const rows = transcriptRows.map((row, index) => {
    const related = actions.filter(
      (action) =>
        ["correction", "split", "reconsideration"].includes(action.kind) &&
        (
          action.event?.affectedRowIds ||
          action.event?.rowIds ||
          (action.event?.rowId ? [action.event.rowId] : [])
        ).includes(row.id)
    );
    const relative = (value) =>
      value == null || !Number.isFinite(value)
        ? null
        : value > 1e12
          ? status.startedAt != null
            ? (value - status.startedAt) / 1000
            : null
          : value;
    const timebaseUnavailable =
      (!row.audioSpan && (row.timestamp == null || status.startedAt == null)) ||
      (row.recordingId != null && row.recordingId !== recordingId) ||
      (row.recordingOrigin != null && row.recordingOrigin !== status.startedAt) ||
      (row.timebase === "epoch" && row.timestamp != null && row.timestamp < 1e12) ||
      (row.timebase === "recording" &&
        (row.recordingId == null || (row.timestamp != null && row.timestamp > 1e12))) ||
      (row.timebase == null &&
        status.startedAt != null &&
        row.timestamp != null &&
        row.timestamp < 1e12 &&
        !row.audioSpan);
    const start = row.audioSpan
      ? row.audioSpan.startSample / 24000
      : (relative(row.speechStart) ?? Math.max(0, (relative(row.timestamp) ?? 0) - 10));
    const end = row.audioSpan
      ? row.audioSpan.endSample / 24000
      : (relative(row.speechEnd) ?? relative(row.timestamp) ?? start + 10);
    const track = row.source;
    const chunks = status.tracks?.[track]?.chunks || [];
    const anchor = row.audioSpan
      ? start
      : (relative(row.speechStart) ?? relative(row.timestamp) ?? start);
    const regions = [];
    for (const chunk of chunks) {
      const from = chunk.startSample / 24000;
      const to = (chunk.startSample + chunk.sampleCount) / 24000;
      const last = regions.at(-1);
      if (last && from <= last.to) last.to = Math.max(last.to, to);
      else regions.push({ from, to });
    }
    const containing = regions.find((region) => region.from <= anchor && region.to > anchor);
    const nextStart = transcriptRows
      .slice(index + 1)
      .filter(
        (item) =>
          item.source === track && (item.recordingId == null || item.recordingId === recordingId)
      )
      .map((item) =>
        item.audioSpan?.recordingId === recordingId &&
        item.audioSpan.trackId === track &&
        item.wordTimings?.length
          ? item.audioSpan.startSample / 24000
          : relative(item.speechStart)
      )
      .find((value) => value != null && Number.isFinite(value));
    const from = Math.max(0, Math.round((start - 0.04) * 1000) / 1000, containing?.from ?? 0);
    const to =
      Math.round(Math.min(end + 0.04, nextStart ?? Infinity, containing?.to ?? Infinity) * 1000) /
      1000;
    const recordedEnd =
      status.tracks?.[track]?.sampleCount != null
        ? status.tracks[track].sampleCount / 24000
        : Math.max(0, ...chunks.map((chunk) => (chunk.startSample + chunk.sampleCount) / 24000));
    const unavailableReason =
      timebaseUnavailable ||
      (row.audioSpan?.recordingId != null && row.audioSpan.recordingId !== recordingId)
        ? "timebase"
        : row.audioSpan?.trackId !== undefined && row.audioSpan.trackId !== track
          ? "track_mismatch"
          : status.tracks && (!containing || to <= from)
            ? anchor < 0 || anchor >= recordedEnd
              ? "outside_recorded_range"
              : "gap"
            : null;
    const firstCorrection = related.find((action) => action.event?.actor !== "machine");
    const personChanges = actions.filter(
      (action) =>
        action.kind === "person" &&
        action.action !== "reset" &&
        action.before?.some((saved) => saved.id === row.id)
    );
    const machine = machineAssignment(row, related, personChanges);
    const ownerCorrectionActionIds = related
      .filter((action) => action.event?.actor !== "machine")
      .map((action) => action.id);
    return {
      rowId: row.id,
      track,
      start,
      end,
      from,
      to,
      approximate: !row.audioSpan,
      unavailableReason,
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
