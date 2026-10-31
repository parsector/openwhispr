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
  // Revisions and event sequences are the recorded order. Names can repeat,
  // so comparing them to sort actions can create a non-transitive comparator.
  entries.sort((a, b) => a.order - b.order ||
    (a.kind === 'adoption' && b.kind === 'adoption' ? a.index - b.index : 0));
  for (let i = 1; i < entries.length; i++)
    if (entries[i].order === entries[i - 1].order &&
        !(entries[i].kind === 'adoption' && entries[i - 1].kind === 'adoption')) ambiguous = true;
  const chains = new Map();
  for (const entry of entries) {
    const changes = entry.kind === 'adoption'
      ? entry.rows.map(row => [row.id, row.before, row.after])
      : Object.entries(entry.event.snapshots || {}).map(([id, saved]) =>
        [id, saved.previous, saved.next]);
    for (const [id, before, after] of changes) {
      if (!before || !after) continue;
      const previous = label(before), next = label(after);
      const chain = chains.get(id);
      if (chain && chain.last !== previous) ambiguous = true;
      if (chain?.seen.has(next)) ambiguous = true;
      chains.set(id, { last: next, seen: new Set([...(chain?.seen || []), previous, next]) });
    }
  }
  for (const row of rows) {
    const chain = chains.get(row.id);
    if (chain && chain.last !== label(row)) ambiguous = true;
  }
  let sequence = 0;
  const actions = entries.map(({ kind, id, event, record, order }) => ({
    sequence: sequence = Math.max(sequence + 1, order), kind, id,
    ...(kind === 'adoption' ? { record } : { event: {
      ...event,
      affectedRowIds: event.affectedRowIds || event.rowIds || (event.rowId ? [event.rowId] : []),
      rowIds: event.rowIds || event.affectedRowIds || (event.rowId ? [event.rowId] : []),
    } }),
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

function remapSpeakerActionLog(raw, idMap) {
  if (!raw) return raw;
  const log = JSON.parse(raw);
  let unresolved = false;
  const id = old => {
    const next = idMap.get(old);
    if (!next) unresolved = true;
    return next || old;
  };
  const ids = values => values?.map(id);
  const rowRefs = row => {
    if (!row || typeof row !== 'object') return row;
    return { ...row,
      ...(row.id ? { id: id(row.id) } : {}),
      ...(row.parentRowId ? { parentRowId: id(row.parentRowId) } : {}),
      ...(row.finalRevision?.splitFromRowId ? { finalRevision: {
        ...row.finalRevision, splitFromRowId: id(row.finalRevision.splitFromRowId),
      } } : {}),
    };
  };
  const eventRefs = event => {
    if (!event) return event;
    return { ...event,
      ...(event.rowId ? { rowId: id(event.rowId) } : {}),
      ...(event.affectedRowIds ? { affectedRowIds: ids(event.affectedRowIds) } : {}),
      ...(event.rowIds ? { rowIds: ids(event.rowIds) } : {}),
      ...(event.target?.rowIds ? { target: { ...event.target,
        rowIds: ids(event.target.rowIds) } } : {}),
      ...(event.snapshots ? { snapshots: Object.fromEntries(Object.entries(event.snapshots)
        .map(([old, saved]) => [id(old), saved && typeof saved === 'object'
          ? { ...saved, previous: rowRefs(saved.previous), next: rowRefs(saved.next) }
          : saved])) } : {}),
    };
  };
  const document = rawDocument => {
    if (!rawDocument) return rawDocument;
    try {
      const parsed = JSON.parse(rawDocument);
      const rows = Array.isArray(parsed) ? parsed : parsed.rows;
      if (!Array.isArray(rows)) return rawDocument;
      const mapped = rows.map(row => ({ ...rowRefs(row),
        ...(row.corrections ? { corrections: row.corrections.map(record => ({
          ...eventRefs(record),
          ...(record.event ? { event: eventRefs(record.event) } : {}),
        })) } : {}),
      }));
      return JSON.stringify(Array.isArray(parsed) ? mapped : { ...parsed, rows: mapped });
    } catch { unresolved = true; return rawDocument; }
  };
  for (const action of log.actions || []) {
    if (action.event) action.event = eventRefs(action.event);
    const record = action.record;
    if (record) {
      if (record.rows) record.rows = record.rows.map(row => ({ ...rowRefs(row),
        before: rowRefs(row.before), after: rowRefs(row.after) }));
      if (record.before) record.before = document(record.before);
      if (record.after) record.after = document(record.after);
    }
  }
  if (unresolved) log.quarantined = true;
  return JSON.stringify(log);
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

module.exports = { readSpeakerActionLog, migrateSpeakerHistory, remapSpeakerActionLog,
  appendAction, removeNewestAction, newestAvailableAction, MAX_ACTION_LOG_BYTES };
