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
    const candidate = record.event || record;
    const previous = corrections.get(record.id);
    if (!previous || (candidate.snapshots && !previous.snapshots)) corrections.set(record.id, candidate);
  }
  // Older row-only notes stored one compact record on each affected row and
  // the full event on its anchor. Recover every row snapshot before stripping.
  for (const row of rows) for (const record of row.corrections || []) {
    const event = corrections.get(record.id);
    if (!event) continue;
    if (record.previous || record.next) {
      event.snapshots = { ...(event.snapshots || {}), [row.id]: {
        previous: record.previous || {}, next: record.next || {},
      } };
    }
  }
  const legacy = note.speaker_label_undo ? JSON.parse(note.speaker_label_undo) : [];
  const adoptions = Array.isArray(legacy) ? legacy : [legacy];
  const entries = [
    ...[...corrections.values()].map((event) => ({ kind: event.newClusterId ? 'split' :
      event.actor === 'machine' ? 'reconsideration' : 'correction', id: event.id,
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
    if (a.kind === b.kind || (a.kind !== 'adoption' && b.kind !== 'adoption')) {
      if (a.kind === 'adoption') return a.index - b.index;
      if (a.order !== b.order) return a.order - b.order;
      const aTime = Date.parse(a.event.timestamp), bTime = Date.parse(b.event.timestamp);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
      ambiguous = true;
      return 0;
    }
    const correction = a.kind === 'adoption' ? b : a;
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
    ...(kind === 'adoption' ? { record } : { event }),
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
  const index = log.actions.findLastIndex(action => !action.unavailableReason);
  return { ...log, actions: log.actions.filter((_, i) => i !== index) };
}

function newestAvailableAction(log) {
  return log.actions.findLast(action => !action.unavailableReason);
}

function migrateSpeakerHistory(note) {
  let log = readSpeakerActionLog(note);
  const raw = readTranscriptDocument(note.transcript);
  const hasRowHistory = raw.rows.some(row => row.corrections?.length);
  const needsMigration = hasRowHistory || !!note.speaker_label_undo || !note.speaker_action_log;
  if (!needsMigration) return null;
  if (note.speaker_action_log && (hasRowHistory || note.speaker_label_undo)) {
    const legacy = readSpeakerActionLog({ ...note, speaker_action_log: null });
    const owned = new Set(log.actions.map(action => action.kind === 'adoption'
      ? `adoption:${JSON.stringify(action.record)}` : `id:${action.id}`));
    const extra = legacy.actions.filter(action => !owned.has(action.kind === 'adoption'
      ? `adoption:${JSON.stringify(action.record)}` : `id:${action.id}`));
    if (extra.length) {
      const next = Math.max(0, ...log.actions.map(action => action.sequence || 0)) + 1;
      log = { ...log, quarantined: true,
        nextSequence: next + extra.length,
        actions: [...log.actions, ...extra.map((action, index) => ({ ...action,
          sequence: next + index }))] };
    }
  }
  const { writeTranscriptDocument } = require('./transcriptDocument');
  const transcript = hasRowHistory ? writeTranscriptDocument(raw.rows.map(({ corrections, ...row }) => row),
    raw.unknownNumberHighWater) : note.transcript;
  const serialized = JSON.stringify(log);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ACTION_LOG_BYTES) return { error: 'history_full' };
  return { transcript, speaker_action_log: serialized, speaker_label_undo: null };
}

module.exports = { readSpeakerActionLog, migrateSpeakerHistory, appendAction, removeNewestAction, newestAvailableAction, MAX_ACTION_LOG_BYTES };
