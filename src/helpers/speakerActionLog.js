const { readTranscriptDocument } = require('./transcriptDocument');

const MAX_ACTION_LOG_BYTES = 16 * 1024 * 1024;

// Legacy corrections lived on transcript rows and adoptions in a note column.
// Fold both once, using recorded row revisions and the correction sequence as
// a deterministic tie breaker. A subsequent write clears the legacy stack.
function readSpeakerActionLog(note) {
  if (note.speaker_action_log) return JSON.parse(note.speaker_action_log);
  const rows = readTranscriptDocument(note.transcript).rows;
  const corrections = new Map();
  for (const row of rows) for (const record of row.corrections || []) {
    const previous = corrections.get(record.id);
    if (!previous || (record.snapshots && !previous.snapshots)) corrections.set(record.id, record);
  }
  const legacy = note.speaker_label_undo ? JSON.parse(note.speaker_label_undo) : [];
  const adoptions = Array.isArray(legacy) ? legacy : [legacy];
  const entries = [
    ...[...corrections.values()].map((event) => ({ kind: 'correction', id: event.id,
      event, order: Number(event.sequence) || 0 })),
    ...adoptions.map((record, index) => {
      const rows = record.rows || (record.before && record.after ? (() => {
        const before = new Map(readTranscriptDocument(record.before).rows.map(row => [row.id, row]));
        return readTranscriptDocument(record.after).rows.map(row => ({ id: row.id,
          before: before.get(row.id), after: row, revision: Number(row.correctionRevision) || 0 }));
      })() : []);
      return { kind: 'adoption', id: `legacy-adoption-${index}`, record, rows, index,
        order: Math.max(0, ...rows.map(row => Number(row.revision) || 0)) };
    }),
  ];
  const label = (value) => JSON.stringify({ name: value?.speakerName,
    placeholder: !!value?.speakerIsPlaceholder, locked: !!value?.speakerLocked });
  let ambiguous = false;
  const compare = (a, b) => {
    if (a.kind === b.kind) {
      if (a.kind === 'adoption') return a.index - b.index;
      if (a.order !== b.order) return a.order - b.order;
      const aTime = Date.parse(a.event.timestamp), bTime = Date.parse(b.event.timestamp);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
      ambiguous = true;
      return 0;
    }
    const correction = a.kind === 'correction' ? a : b;
    const adoption = a.kind === 'adoption' ? a : b;
    const match = (side, other) => adoption.rows.some(row => {
      const saved = correction.event.snapshots?.[row.id];
      return saved && label(row[side]) === label(saved[other]);
    });
    const adoptionFirst = match('after', 'previous');
    const correctionFirst = match('before', 'next');
    let direction = 0;
    if (adoptionFirst !== correctionFirst) direction = adoptionFirst ? -1 : 1;
    else {
      const correctionTime = Date.parse(correction.event.timestamp);
      const adoptionTime = Date.parse(adoption.record.timestamp);
      if (Number.isFinite(correctionTime) && Number.isFinite(adoptionTime) && correctionTime !== adoptionTime)
        direction = adoptionTime < correctionTime ? -1 : 1;
      else ambiguous = true;
    }
    return a === adoption ? direction : -direction;
  };
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) compare(entries[i], entries[j]);
  if (!ambiguous) entries.sort(compare);
  let sequence = 0;
  const actions = entries.map(({ kind, id, event, record, order }) => ({
    sequence: sequence = Math.max(sequence + 1, order), kind, id,
    ...(kind === 'correction' ? { event } : { record }),
  }));
  return { version: 1, nextSequence: sequence + 1, actions,
    ...(ambiguous ? { quarantined: true } : {}) };
}

function appendAction(log, action) {
  if (log.quarantined) return null;
  const next = { version: 1, nextSequence: log.nextSequence + 1,
    actions: [...log.actions, { ...action, sequence: log.nextSequence }] };
  return Buffer.byteLength(JSON.stringify(next), 'utf8') <= MAX_ACTION_LOG_BYTES ? next : null;
}

function removeNewestAction(log) {
  return { ...log, actions: log.actions.slice(0, -1) };
}

module.exports = { readSpeakerActionLog, appendAction, removeNewestAction, MAX_ACTION_LOG_BYTES };
