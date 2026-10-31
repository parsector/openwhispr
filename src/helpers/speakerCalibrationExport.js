const { createHash } = require("node:crypto");
const { readTranscriptDocument } = require("./transcriptDocument");
const { readSpeakerActionLog } = require("./speakerActionLog");

function buildCalibrationLabels(note, audio, status = {}) {
  const actions = readSpeakerActionLog(note).actions;
  const rows = readTranscriptDocument(note.transcript).rows.map((row) => {
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
      value == null
        ? null
        : value > 1e12
          ? status.startedAt != null
            ? (value - status.startedAt) / 1000
            : null
          : value;
    const start = row.audioSpan
      ? row.audioSpan.startSample / 24000
      : (relative(row.speechStart) ?? Math.max(0, (relative(row.timestamp) ?? 0) - 10));
    const end = row.audioSpan
      ? row.audioSpan.endSample / 24000
      : (relative(row.speechEnd) ?? relative(row.timestamp));
    const track = row.source;
    const chunks = status.tracks?.[track]?.chunks || [];
    const anchor = row.audioSpan ? start : (relative(row.speechStart) ?? relative(row.timestamp));
    const unavailableReason =
      row.audioSpan?.trackId !== undefined && row.audioSpan.trackId !== track
        ? "track_mismatch"
        : row.audioSpan?.recordingId != null && row.audioSpan.recordingId !== status.recordingId
          ? "recording_mismatch"
          : status.tracks &&
              !chunks.some(
                (chunk) =>
                  chunk.startSample / 24000 <= anchor &&
                  (chunk.startSample + chunk.sampleCount) / 24000 > anchor
              )
            ? "gap"
            : null;
    const firstCorrection = related.find((action) => action.event?.actor !== "machine");
    const ownerCorrectionActionIds = related
      .filter((action) => action.event?.actor !== "machine")
      .map((action) => action.id);
    return {
      rowId: row.id,
      track,
      start,
      end,
      approximate: !row.audioSpan,
      unavailableReason,
      textHash: createHash("sha256")
        .update(String(row.text || ""))
        .digest("hex"),
      currentLabel: row.speakerName || null,
      machineLabel:
        firstCorrection?.event?.snapshots?.[row.id]?.previous?.speakerName ??
        row.speakerName ??
        null,
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
