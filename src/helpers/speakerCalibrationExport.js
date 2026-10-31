const { createHash } = require('node:crypto');
const { readTranscriptDocument } = require('./transcriptDocument');
const { readSpeakerActionLog } = require('./speakerActionLog');

function buildCalibrationLabels(note, audio) {
  const actions = readSpeakerActionLog(note).actions;
  const rows = readTranscriptDocument(note.transcript).rows.map(row => {
    const related = actions.filter(action => ['correction', 'split', 'reconsideration'].includes(action.kind) &&
      (action.event?.affectedRowIds || action.event?.rowIds ||
        (action.event?.rowId ? [action.event.rowId] : [])).includes(row.id));
    const start = row.audioSpan ? row.audioSpan.startSample / 24000 : row.wordTimings?.[0]?.start ?? row.timestamp;
    const end = row.audioSpan ? row.audioSpan.endSample / 24000 : row.wordTimings?.at(-1)?.end ?? null;
    const firstCorrection = related.find(action => action.event?.actor !== 'machine');
    const ownerCorrectionActionIds = related.filter(action => action.event?.actor !== 'machine').map(action => action.id);
    return { rowId: row.id, track: row.audioSpan?.trackId || row.source,
      start, end, approximate: !row.audioSpan, textHash: createHash('sha256').update(String(row.text || '')).digest('hex'),
      currentLabel: row.speakerName || null,
      machineLabel: firstCorrection?.event?.snapshots?.[row.id]?.previous?.speakerName ?? row.speakerName ?? null,
      corrected: !!firstCorrection,
      ownerCorrectionActionIds,
      currentOverlapDetected: row.uncertainty?.reason === 'overlapping_speech',
      finalPassChanged: !!row.finalRevision,
      // The owner must review these independently; current labels can be wrong.
      truePerson: null, trueOverlap: null };
  });
  return { version: 1, synthetic: false, audio, rows };
}

module.exports = { buildCalibrationLabels };
