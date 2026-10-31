// Diarization uses seconds from the selected session input. Stored audio and
// playback use seconds from the manifest's original recording start.
function rebaseDiarizedRows(rows, { sessionOrigin, recordingOrigin, recordingId, audioStartOffsets = {} }) {
  if (!Number.isFinite(sessionOrigin) || !Number.isFinite(recordingOrigin)) return rows;
  const sessionOffset = (sessionOrigin - recordingOrigin) / 1000;
  return rows.map(row => ({ ...row,
    timestamp: row.timestamp == null ? undefined : row.timestamp +
      (row.parentRowId ? audioStartOffsets[row.source] ?? sessionOffset : sessionOffset),
    recordingId,
    recordingOrigin,
    timebase: "recording",
  }));
}

function attachUndiarizedAudioSpans(rows, audioStatus) {
  if (!audioStatus?.recordingId) return rows;
  return require('./meetingWordAlignment').withAudioSpans(rows, audioStatus.recordingId);
}

function extendBatchCapture(bounds, capturedAt, byteLength) {
  if (!Number.isFinite(capturedAt) || !Number.isSafeInteger(byteLength) || byteLength < 0) return bounds;
  return { start: bounds.start ?? capturedAt, end: capturedAt + byteLength / 48 };
}

module.exports = { rebaseDiarizedRows, attachUndiarizedAudioSpans, extendBatchCapture };
