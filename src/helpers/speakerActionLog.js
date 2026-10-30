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
    ...adoptions.map((record, index) => ({ kind: 'adoption', id: `legacy-adoption-${index}`,
      record, order: Math.max(0, ...(record.rows || []).map((row) => Number(row.revision) || 0)) })),
  ];
  const label = (value) => JSON.stringify({ name: value?.speakerName,
    placeholder: !!value?.speakerIsPlaceholder, locked: !!value?.speakerLocked });
  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      const correction = a.kind === 'correction' ? a : b;
      const adoption = a.kind === 'adoption' ? a : b;
      const match = (side, other) => (adoption.record.rows || []).some((row) => {
        const saved = correction.event.snapshots?.[row.id];
        return saved && label(row[side]) === label(saved[other]);
      });
      // Snapshot continuity gives a real cross-store order when the same row
      // was touched by both actions, even if their numeric counters tie.
      if (match('after', 'previous') && !match('before', 'next'))
        return a === adoption ? -1 : 1;
      if (match('before', 'next') && !match('after', 'previous'))
        return a === correction ? -1 : 1;
    }
    return a.order - b.order ||
      (a.kind === b.kind ? 0 : a.kind === 'correction' ? -1 : 1) ||
      String(a.id).localeCompare(String(b.id));
  });
  let sequence = 0;
  const actions = entries.map(({ kind, id, event, record, order }) => ({
    sequence: sequence = Math.max(sequence + 1, order), kind, id,
    ...(kind === 'correction' ? { event } : { record }),
  }));
  return { version: 1, nextSequence: sequence + 1, actions };
}

function appendAction(log, action) {
  const next = { version: 1, nextSequence: log.nextSequence + 1,
    actions: [...log.actions, { ...action, sequence: log.nextSequence }] };
  return Buffer.byteLength(JSON.stringify(next), 'utf8') <= MAX_ACTION_LOG_BYTES ? next : null;
}

function removeNewestAction(log) {
  return { ...log, actions: log.actions.slice(0, -1) };
}

module.exports = { readSpeakerActionLog, appendAction, removeNewestAction, MAX_ACTION_LOG_BYTES };
