const { randomUUID } = require('node:crypto');
const { readTranscriptDocument, writeTranscriptDocument } = require('./transcriptDocument');
const { readSpeakerActionLog, appendAction, removeNewestAction } = require('./speakerActionLog');

const normalized = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
function near(a, b) {
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 2) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = next;
  }
  return previous[b.length] <= 2;
}
function allMappings(db) {
  const grouped = new Map();
  for (const table of ['speaker_mappings', 'speaker_run_mappings'])
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      if (!grouped.has(row.note_id)) grouped.set(row.note_id, []);
      grouped.get(row.note_id).push({ ...row, table });
    }
  return grouped;
}
function rowProfile(row, noteMappings) {
  if (row.speakerLockSource === 'user' && row.suggestedProfileId) return row.suggestedProfileId;
  const run = noteMappings.find(m => m.table === 'speaker_run_mappings' && m.run_id === (row.diarizationRunId || 'legacy') && m.cluster_id === row.speaker);
  return (run || noteMappings.find(m => m.table === 'speaker_mappings' && m.speaker_id === row.speaker))?.profile_id ?? null;
}
const NOTE_COLUMNS = 'id, title, transcript, created_at, updated_at, speaker_action_log, speaker_label_undo';
function notes(db) { return db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE deleted_at IS NULL`).all(); }
function allNotes(db) { return db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes`).all(); }
function listPeople(database) {
  const db = database.db;
  const profiles = db.prepare('SELECT id, display_name, email, sample_count, embedding, created_at, updated_at FROM speaker_profiles').all();
  const byName = new Map();
  for (const p of profiles) {
    const key = normalized(p.display_name);
    byName.set(key, byName.has(key) ? null : p.id);
  }
  const usage = new Map(profiles.map(p => [p.id, { notes: new Set(), segmentCount: 0, lastHeard: null }]));
  const identity = profiles.map(p => ({ id: p.id, name: normalized(p.display_name), email: normalized(p.email) }));
  const duplicates = new Map(profiles.map(p => [p.id, []]));
  for (let i = 0; i < profiles.length; i++) for (let j = i + 1; j < profiles.length; j++) {
    const a = identity[i], b = identity[j];
    if (a.name !== b.name && !(a.email && a.email === b.email) && !near(a.name, b.name)) continue;
    duplicates.get(a.id).push({ id: b.id, name: profiles[j].display_name });
    duplicates.get(b.id).push({ id: a.id, name: profiles[i].display_name });
  }
  const mappingByNote = allMappings(db);
  for (const note of notes(db)) {
    const map = mappingByNote.get(note.id) || [];
    for (const row of readTranscriptDocument(note.transcript).rows) {
      if (row.deleted) continue;
      const id = rowProfile(row, map) || byName.get(normalized(row.speakerName));
      const hit = usage.get(id);
      if (!hit) continue;
      hit.notes.add(note.id); hit.segmentCount++;
      const heard = typeof row.timestamp === 'string' && !Number.isNaN(Date.parse(row.timestamp))
        ? row.timestamp : typeof row.timestamp === 'number' && row.timestamp > 1e12
          ? new Date(row.timestamp).toISOString() : note.created_at;
      if (!hit.lastHeard || heard > hit.lastHeard) hit.lastHeard = heard;
    }
    for (const item of map) if (usage.has(item.profile_id)) usage.get(item.profile_id).notes.add(note.id);
  }
  return profiles.map(p => {
    const hit = usage.get(p.id);
    return { id: p.id, displayName: p.display_name, email: p.email, noteCount: hit.notes.size,
      segmentCount: hit.segmentCount, lastHeard: hit.lastHeard, sampleCount: p.sample_count || 0,
      hasVoice: !!p.embedding?.length && p.sample_count > 0,
      legacyVoice: !!p.embedding?.length && p.sample_count > 0,
      usedOnce: hit.notes.size === 1,
      duplicates: duplicates.get(p.id) };
  });
}
function profile(db, id) { return db.prepare('SELECT * FROM speaker_profiles WHERE id = ?').get(id); }
function plan(database, request) {
  const db = database.db;
  const current = profile(db, request.profileId);
  if (!current) return { success: false, error: 'person_missing' };
  if (!['rename', 'merge', 'delete', 'reset'].includes(request.type)) return { success: false, error: 'invalid_request' };
  if (request.type === 'rename' && (!String(request.name || '').trim() || String(request.name).trim().length > 120)) return { success: false, error: 'invalid_name' };
  const survivor = request.type === 'merge' ? profile(db, request.survivorId) : null;
  if (request.type === 'merge' && (!survivor || survivor.id === current.id)) return { success: false, error: 'survivor_missing' };
  const uniqueName = db.prepare('SELECT display_name FROM speaker_profiles').all()
    .filter(p => normalized(p.display_name) === normalized(current.display_name)).length === 1;
  const affected = [];
  const mappingByNote = allMappings(db);
  let segmentCount = 0, pinnedCount = 0;
  for (const note of allNotes(db)) {
    const map = mappingByNote.get(note.id) || [];
    const rows = readTranscriptDocument(note.transcript).rows;
    const rowIds = [];
    for (const row of rows) {
      if (row.deleted) continue;
      const mappedProfile = rowProfile(row, map);
      const linked = mappedProfile === current.id;
      const named = uniqueName && mappedProfile == null && normalized(row.speakerName) === normalized(current.display_name);
      if (!linked && !named) continue;
      rowIds.push(row.id);
      if (row.speakerLocked || row.speakerLockSource === 'user') pinnedCount++;
    }
    const mappingRows = map.filter(m => m.profile_id === current.id);
    if (rowIds.length || mappingRows.length) {
      affected.push({ note, rows, rowIds, mappingRows });
      segmentCount += rowIds.length;
    }
  }
  return { success: true, current, survivor, affected, preview: {
    noteCount: affected.length, segmentCount, pinnedCount,
    voiceSamples: current.sample_count || 0, personName: current.display_name,
    survivorName: survivor?.display_name || null } };
}
function previewPersonAction(database, request) {
  const result = plan(database, request);
  return result.success ? result.affected.length || ['reset', 'delete'].includes(request.type) ? { success: true, ...result.preview,
    historyCount: request.type === 'delete' ? countPersonHistory(database.db, result.current.id) : 0 }
    : { success: false, error: 'no_note_history' } : result;
}
function countPersonHistory(db, id) {
  let count = 0;
  const clearTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_voice_clear_actions'").get();
  const clearIds = new Set(clearTable ? db.prepare('SELECT id, snapshot FROM speaker_voice_clear_actions').all()
    .filter(saved => JSON.parse(saved.snapshot).profiles.some(p => p.id === id)).map(saved => saved.id) : []);
  for (const note of allNotes(db)) {
    const ids = new Set();
    for (const row of readTranscriptDocument(note.transcript).rows)
      for (const correction of row.corrections || []) if (referencesProfile(correction, id)) ids.add(correction.id);
    for (const action of readSpeakerActionLog(note).actions)
      if (referencesProfile(action, id) || clearIds.has(action.id)) ids.add(action.id);
    count += ids.size;
    if (note.speaker_label_undo && referencesProfile(JSON.parse(note.speaker_label_undo), id)) count++;
  }
  return count;
}
const serializedProfile = p => p && { ...p, embedding: Buffer.from(p.embedding || []).toString('base64') };
function writeProfile(db, p) {
  db.prepare('INSERT OR REPLACE INTO speaker_profiles (id, display_name, email, embedding, sample_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, p.display_name, p.email, Buffer.from(p.embedding, 'base64'), p.sample_count, p.created_at, p.updated_at);
}
function applyPersonAction(database, request) {
  return database.db.transaction(() => {
    const db = database.db;
    const built = plan(database, request);
    if (!built.success) return built;
    const { current, survivor, affected, preview } = built;
    if (!affected.length && !['reset', 'delete'].includes(request.type)) return { success: false, error: 'no_note_history' };
    if (request.expected && ['noteCount', 'segmentCount', 'pinnedCount'].some(key =>
      request.expected[key] !== preview[key])) return { success: false, error: 'preview_changed' };
    if (request.type === 'delete' && request.expected?.historyCount !== undefined &&
      request.expected.historyCount !== countPersonHistory(db, current.id))
      return { success: false, error: 'preview_changed' };
    if (request.type === 'delete') return deletePerson(database, built);
    const id = randomUUID();
    const nextName = request.type === 'merge' ? survivor.display_name : request.type === 'rename' ? String(request.name).trim() : null;
    const records = [];
    for (const item of affected) {
      const doc = readTranscriptDocument(item.note.transcript);
      const ids = new Set(item.rowIds);
      const before = item.rows.filter(r => ids.has(r.id)).map(r => ({ id: r.id, speakerName: r.speakerName,
        speakerIsPlaceholder: r.speakerIsPlaceholder, unknownNumber: r.unknownNumber,
        suggestedProfileId: r.suggestedProfileId, correctionRevision: r.correctionRevision }));
      const changed = doc.rows.map(row => ids.has(row.id) && request.type !== 'reset' ? {
        ...row, speakerName: nextName || undefined, speakerIsPlaceholder: !nextName,
        suggestedProfileId: request.type === 'merge' ? survivor.id : request.type === 'delete' ? undefined : row.suggestedProfileId,
        unknownNumber: request.type === 'delete' ? undefined : row.unknownNumber,
        correctionRevision: (Number(row.correctionRevision) || 0) + 1,
      } : row);
      const after = request.type === 'reset' ? item.note.transcript : writeTranscriptDocument(changed, doc.unknownNumberHighWater);
      const log = readSpeakerActionLog(item.note);
      if (log.quarantined) return { success: false, error: 'history_quarantined' };
      const nextLog = appendAction(log, { kind: 'person', id, action: request.type, profileId: current.id,
        before, mappingBefore: item.mappingRows });
      if (!nextLog) return { success: false, error: 'history_full' };
      records.push({ noteId: item.note.id, after, nextLog });
    }
    // The full person snapshot lives in each affected note so undo remains possible after restart.
    for (const record of records) {
      const action = record.nextLog.actions.at(-1);
      action.profileBefore = serializedProfile(current);
      action.survivorId = survivor?.id || null;
      action.affectedNoteIds = affected.map(a => a.note.id);
      if (Buffer.byteLength(JSON.stringify(record.nextLog)) > 16 * 1024 * 1024)
        return { success: false, error: 'history_full' };
    }
    if (request.type === 'reset' && !affected.length) {
      db.exec('CREATE TABLE IF NOT EXISTS speaker_person_voice_actions (id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, snapshot TEXT NOT NULL)');
      db.prepare('INSERT INTO speaker_person_voice_actions (id, profile_id, snapshot) VALUES (?, ?, ?)')
        .run(id, current.id, JSON.stringify(serializedProfile(current)));
    }
    for (const record of records) {
      if (request.type === 'reset') db.prepare('UPDATE notes SET speaker_action_log = ?, speaker_label_undo = NULL WHERE id = ?')
        .run(JSON.stringify(record.nextLog), record.noteId);
      else db.prepare("UPDATE notes SET transcript = ?, speaker_action_log = ?, speaker_label_undo = NULL, sync_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(record.after, JSON.stringify(record.nextLog), record.noteId);
    }
    if (request.type === 'rename') db.prepare('UPDATE speaker_profiles SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextName, current.id);
    if (request.type === 'merge' || request.type === 'delete') {
      for (const table of ['speaker_mappings', 'speaker_run_mappings']) db.prepare(
        `UPDATE ${table} SET profile_id = ?, display_name = ? WHERE profile_id = ?`)
        .run(survivor?.id || null, nextName || '', current.id);
      db.prepare('DELETE FROM speaker_profiles WHERE id = ?').run(current.id);
    } else if (request.type === 'rename') {
      for (const table of ['speaker_mappings', 'speaker_run_mappings']) db.prepare(
        `UPDATE ${table} SET display_name = ? WHERE profile_id = ?`).run(nextName, current.id);
    } else if (request.type === 'reset') {
      for (const table of ['speaker_mappings', 'speaker_run_mappings']) db.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(current.id);
      db.prepare('UPDATE speaker_profiles SET embedding = ?, sample_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(Buffer.alloc(0), current.id);
    }
    return { success: true, id, ...preview, noteIds: affected.map(a => a.note.id) };
  })();
}
function undoPersonAction(database, id) {
  return database.db.transaction(() => {
    const db = database.db;
    const found = allNotes(db).map(note => ({ note, log: readSpeakerActionLog(note) }))
      .find(({ log }) => log.actions.some(action => action.kind === 'person' && action.id === id));
    if (!found) {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_person_voice_actions'").get();
      const saved = table && db.prepare('SELECT profile_id, snapshot FROM speaker_person_voice_actions WHERE id = ?').get(id);
      if (!saved) return { success: false, error: 'action_missing' };
      const p = profile(db, saved.profile_id);
      if (!p) return { success: false, error: 'person_deleted' };
      const old = JSON.parse(saved.snapshot);
      db.prepare('UPDATE speaker_profiles SET embedding = ?, sample_count = ? WHERE id = ?')
        .run(Buffer.from(old.embedding, 'base64'), old.sample_count, old.id);
      db.prepare('DELETE FROM speaker_person_voice_actions WHERE id = ?').run(id);
      return { success: true, noteIds: [] };
    }
    const action = found.log.actions.find(a => a.kind === 'person' && a.id === id);
    if (action.unavailableReason) return { success: false, error: action.unavailableReason };
    if (action.action === 'delete') return { success: false, error: 'person_deleted' };
    if (!profile(db, action.profileId) && action.action !== 'merge') return { success: false, error: 'person_deleted' };
    if (action.action === 'merge' && !profile(db, action.survivorId)) return { success: false, error: 'person_deleted' };
    const affected = action.affectedNoteIds.map(noteId => {
      const note = database.getNote(noteId);
      return { note, log: note && readSpeakerActionLog(note) };
    });
    if (affected.some(x => !x.note || x.log.actions.at(-1)?.id !== id)) return { success: false, error: 'later_change' };
    const person = action.profileBefore;
    if (!person) return { success: false, error: 'action_missing' };
    if (action.action === 'merge' || action.action === 'delete') writeProfile(db, person);
    else db.prepare('UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, sample_count = ?, updated_at = ? WHERE id = ?')
      .run(person.display_name, person.email, Buffer.from(person.embedding, 'base64'), person.sample_count, person.updated_at, person.id);
    for (const { note, log } of affected) {
      const entry = log.actions.at(-1);
      const doc = readTranscriptDocument(note.transcript);
      const before = new Map(entry.before.map(row => [row.id, row]));
      const fields = ['speakerName', 'speakerIsPlaceholder', 'unknownNumber', 'suggestedProfileId', 'correctionRevision'];
      const rows = doc.rows.map(row => {
        const saved = before.get(row.id); if (!saved) return row;
        const restored = { ...row };
        for (const field of fields) { if (saved[field] === undefined) delete restored[field]; else restored[field] = saved[field]; }
        return restored;
      });
      for (const mapping of entry.mappingBefore) {
        const key = mapping.table === 'speaker_mappings' ? ['note_id', 'speaker_id'] : ['note_id', 'run_id', 'cluster_id'];
        db.prepare(`INSERT OR REPLACE INTO ${mapping.table} (${key.join(', ')}, profile_id, display_name) VALUES (${key.map(() => '?').join(', ')}, ?, ?)`)
          .run(...key.map(k => mapping[k]), mapping.profile_id, mapping.display_name);
      }
      if (action.action === 'reset') db.prepare('UPDATE notes SET speaker_action_log = ? WHERE id = ?')
        .run(JSON.stringify(removeNewestAction(log)), note.id);
      else db.prepare("UPDATE notes SET transcript = ?, speaker_action_log = ?, sync_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(writeTranscriptDocument(rows, doc.unknownNumberHighWater), JSON.stringify(removeNewestAction(log)), note.id);
    }
    return { success: true, noteIds: action.affectedNoteIds };
  })();
}
function referencesProfile(value, id) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    ['profileId', 'profile_id', 'createdProfileId', 'survivorId', 'suggestedProfileId'].includes(key) && item === id ||
    referencesProfile(item, id));
}
function deletePerson(database, built) {
  const db = database.db;
  const { current, affected, preview } = built;
  const rowIdsByNote = new Map(affected.map(item => [item.note.id, new Set(item.rowIds)]));
  const clearTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_voice_clear_actions'").get();
  const affectedClearIds = new Set();
  if (clearTable) for (const saved of db.prepare('SELECT id, snapshot FROM speaker_voice_clear_actions').all()) {
    const snapshot = JSON.parse(saved.snapshot);
    if (!snapshot.profiles.some(p => p.id === current.id)) continue;
    snapshot.profiles = snapshot.profiles.filter(p => p.id !== current.id);
    snapshot.mappings = snapshot.mappings.filter(m => m.profile_id !== current.id);
    snapshot.personDeleted = true;
    db.prepare('UPDATE speaker_voice_clear_actions SET snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), saved.id);
    affectedClearIds.add(saved.id);
  }
  const resetTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_person_voice_actions'").get();
  if (resetTable) db.prepare('DELETE FROM speaker_person_voice_actions WHERE profile_id = ?').run(current.id);
  let historyCount = 0;
  for (const note of allNotes(db)) {
    const doc = readTranscriptDocument(note.transcript);
    const targetRows = rowIdsByNote.get(note.id) || new Set();
    let changedHistory = false;
    const removedHistory = new Set();
    let highWater = doc.unknownNumberHighWater || 0;
    const rows = doc.rows.map(row => {
      const next = { ...row };
      const old = next.corrections || [];
      const kept = old.filter(record => !referencesProfile(record, current.id));
      for (const record of old) if (referencesProfile(record, current.id)) removedHistory.add(record.id);
      if (old.length !== kept.length) changedHistory = true;
      if (kept.length) next.corrections = kept; else delete next.corrections;
      if (targetRows.has(row.id)) {
        highWater++;
        delete next.suggestedProfileId;
        delete next.suggestedName;
        next.speakerName = undefined;
        next.speakerIsPlaceholder = true;
        next.unknownNumber = highWater;
        next.speakerLocked = false;
        next.speakerLockSource = undefined;
        next.correctionRevision = (Number(row.correctionRevision) || 0) + 1;
      } else if (next.suggestedProfileId === current.id) delete next.suggestedProfileId;
      return next;
    });
    const log = readSpeakerActionLog(note);
    const actions = [];
    for (const action of log.actions) {
      if (action.kind === 'clear_voice' && affectedClearIds.has(action.id)) {
        removedHistory.add(action.id);
        actions.push({ kind: action.kind, id: action.id, sequence: action.sequence,
          unavailableReason: 'person_deleted' });
        changedHistory = true;
        continue;
      }
      if (action.kind === 'person' && action.profileId === current.id ||
          action.kind === 'correction' && (action.event?.createdProfileId === current.id || action.event?.mappingAfter?.profileId === current.id)) {
        removedHistory.add(action.id); continue;
      }
      if (referencesProfile(action, current.id)) {
        removedHistory.add(action.id);
        actions.push({ kind: action.kind, id: action.id, sequence: action.sequence,
          unavailableReason: 'person_deleted' });
        changedHistory = true;
      } else actions.push(action);
    }
    const legacy = note.speaker_label_undo ? JSON.parse(note.speaker_label_undo) : null;
    const nextLegacy = legacy && referencesProfile(legacy, current.id) ? null : note.speaker_label_undo;
    if (nextLegacy === null && legacy) { removedHistory.add('legacy'); changedHistory = true; }
    historyCount += removedHistory.size;
    if (targetRows.size || changedHistory || actions.length !== log.actions.length)
      db.prepare('UPDATE notes SET transcript = ?, speaker_action_log = ?, speaker_label_undo = ? WHERE id = ?')
        .run(writeTranscriptDocument(rows, highWater), JSON.stringify({ ...log, actions }), nextLegacy, note.id);
  }
  for (const table of ['speaker_mappings', 'speaker_run_mappings'])
    db.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(current.id);
  db.prepare('DELETE FROM speaker_profiles WHERE id = ?').run(current.id);
  return { success: true, id: null, ...preview, historyCount, noteIds: affected.map(a => a.note.id) };
}
function previewClearVoiceData(database) {
  const db = database.db;
  const personCount = db.prepare('SELECT COUNT(*) AS n FROM speaker_profiles').get().n;
  const embeddingCount = db.prepare('SELECT COUNT(*) AS n FROM speaker_profiles WHERE length(embedding) > 0').get().n;
  const mappingCount = ['speaker_mappings', 'speaker_run_mappings'].reduce((n, table) =>
    n + db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  return { success: true, personCount, embeddingCount, mappingCount };
}
function clearVoiceData(database, expected) {
  return database.db.transaction(() => {
    const db = database.db;
    const preview = previewClearVoiceData(database);
    if (expected && ['personCount', 'embeddingCount', 'mappingCount'].some(key => expected[key] !== preview[key]))
      return { success: false, error: 'preview_changed' };
    const id = randomUUID();
    const profiles = db.prepare('SELECT id, embedding, sample_count FROM speaker_profiles').all()
      .map(p => ({ ...p, embedding: Buffer.from(p.embedding).toString('base64') }));
    const mappings = ['speaker_mappings', 'speaker_run_mappings'].flatMap(table =>
      db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row, table })));
    const noteIds = [];
    const noteLogs = [];
    for (const note of allNotes(db)) {
      const log = readSpeakerActionLog(note);
      if (log.quarantined) continue;
      const next = appendAction(log, { kind: 'clear_voice', id });
      if (!next) return { success: false, error: 'history_full' };
      noteIds.push(note.id);
      noteLogs.push([JSON.stringify(next), note.id]);
    }
    db.exec('CREATE TABLE IF NOT EXISTS speaker_voice_clear_actions (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)');
    for (const [log, noteId] of noteLogs)
      db.prepare('UPDATE notes SET speaker_action_log = ?, speaker_label_undo = NULL WHERE id = ?').run(log, noteId);
    db.prepare('INSERT INTO speaker_voice_clear_actions (id, snapshot) VALUES (?, ?)')
      .run(id, JSON.stringify({ profiles, mappings, noteIds }));
    db.prepare('UPDATE speaker_profiles SET embedding = ?, sample_count = 0').run(Buffer.alloc(0));
    db.prepare('DELETE FROM speaker_mappings').run();
    db.prepare('DELETE FROM speaker_run_mappings').run();
    return { ...preview, id, noteIds };
  })();
}
function undoClearVoiceData(database, id) {
  return database.db.transaction(() => {
    const db = database.db;
    const saved = db.prepare('SELECT snapshot FROM speaker_voice_clear_actions WHERE id = ?').get(id);
    if (!saved) return { success: false, error: 'action_missing' };
    const { profiles, mappings, noteIds, personDeleted } = JSON.parse(saved.snapshot);
    if (personDeleted) return { success: false, error: 'person_deleted' };
    const notesToUpdate = noteIds.map(noteId => database.getNote(noteId));
    if (notesToUpdate.some(note => !note || readSpeakerActionLog(note).actions.at(-1)?.id !== id))
      return { success: false, error: 'later_change' };
    if (profiles.some(p => !profile(db, p.id))) return { success: false, error: 'person_deleted' };
    if (db.prepare('SELECT COUNT(*) AS n FROM speaker_mappings').get().n || db.prepare('SELECT COUNT(*) AS n FROM speaker_run_mappings').get().n)
      return { success: false, error: 'later_change' };
    for (const p of profiles) db.prepare('UPDATE speaker_profiles SET embedding = ?, sample_count = ? WHERE id = ?')
      .run(Buffer.from(p.embedding, 'base64'), p.sample_count, p.id);
    for (const m of mappings) {
      const keys = m.table === 'speaker_mappings' ? ['note_id', 'speaker_id'] : ['note_id', 'run_id', 'cluster_id'];
      db.prepare(`INSERT INTO ${m.table} (${keys.join(', ')}, profile_id, display_name) VALUES (${keys.map(() => '?').join(', ')}, ?, ?)`)
        .run(...keys.map(key => m[key]), m.profile_id, m.display_name);
    }
    for (const note of notesToUpdate) db.prepare('UPDATE notes SET speaker_action_log = ? WHERE id = ?')
      .run(JSON.stringify(removeNewestAction(readSpeakerActionLog(note))), note.id);
    db.prepare('DELETE FROM speaker_voice_clear_actions WHERE id = ?').run(id);
    return { success: true };
  })();
}
function listReviewRows(database, selectedProfileId = null) {
  const result = [];
  const people = database.db.prepare('SELECT id, display_name AS displayName FROM speaker_profiles').all();
  const mappingByNote = allMappings(database.db);
  const byName = new Map();
  for (const p of people) {
    const key = normalized(p.displayName);
    byName.set(key, byName.has(key) ? null : p.id);
  }
  for (const note of notes(database.db)) {
    const map = mappingByNote.get(note.id) || [];
    for (const row of readTranscriptDocument(note.transcript).rows) {
      if (row.deleted) continue;
      const reason = row.uncertainty?.reason ||
        (row.changedAfterFinalAnalysis ? 'changed_after_final' : !row.speakerAssessmentAvailable && !row.speakerLocked && !row.speakerName ? 'unassessed' : null);
      const profileId = rowProfile(row, map) || byName.get(normalized(row.speakerName)) || null;
      if (selectedProfileId != null ? profileId !== selectedProfileId : !reason) continue;
      result.push({ noteId: note.id, noteTitle: note.title, rowId: row.id, text: row.text,
        speakerName: row.speakerName || null, profileId, reason: reason || 'person',
        candidates: row.uncertainty?.candidates || null,
        timestamp: note.created_at });
    }
  }
  return result;
}
module.exports = { listPeople, listReviewRows, previewPersonAction, applyPersonAction, undoPersonAction,
  previewClearVoiceData, clearVoiceData, undoClearVoiceData };
