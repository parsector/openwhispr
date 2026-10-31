const { randomUUID } = require('node:crypto');
const { readTranscriptDocument, writeTranscriptDocument } = require('./transcriptDocument');
const { readSpeakerActionLog, appendAction, removeNewestAction, newestAvailableAction } = require('./speakerActionLog');
const { isEventGuest } = require('./eventAttendees');
const history = require('./speakerGlobalHistory');

const normalized = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const later = (first, second) => !first ? second : !second ? first
  : Date.parse(first) >= Date.parse(second) ? first : second;
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
function ownedSpeakerIds(mappings, profileId, rows, personName, uniqueName) {
  const speakers = new Set(mappings.filter(m => m.profile_id === profileId)
    .map(m => m.speaker_id || m.cluster_id));
  for (const row of rows) {
    if (!row.speaker || row.speakerLockSource === 'user' && !row.speakerName && row.speakerIsPlaceholder) continue;
    const mapped = rowProfile(row, mappings);
    if (mapped === profileId || uniqueName && mapped == null && normalized(row.speakerName) === normalized(personName))
      speakers.add(row.speaker);
  }
  return speakers;
}
function ownedEmbeddings(db, noteId, mappings, profileId, rows, personName, uniqueName) {
  const speakers = ownedSpeakerIds(mappings, profileId, rows, personName, uniqueName);
  return db.prepare('SELECT note_id, speaker_id, embedding FROM note_speaker_embeddings WHERE note_id = ?')
    .all(noteId).filter(row => speakers.has(row.speaker_id));
}
const savedEmbedding = row => ({ note_id: row.note_id, speaker_id: row.speaker_id,
  embedding: Buffer.from(row.embedding).toString('base64') });
function restoreEmbeddings(db, rows) {
  for (const row of rows || []) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meeting_audio_tombstones'").get() &&
        db.prepare('SELECT 1 FROM meeting_audio_tombstones WHERE note_id = ?').get(row.note_id)) continue;
    db.prepare('INSERT OR REPLACE INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)')
    .run(row.note_id, row.speaker_id, Buffer.from(row.embedding, 'base64'));
  }
}
function scrubDeletedRecordingSnapshots(db, noteId, affectedProfiles = []) {
  const cleared = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='speaker_voice_clear_actions'").get();
  if (cleared) for (const saved of db.prepare('SELECT id, snapshot FROM speaker_voice_clear_actions').all()) {
    const snapshot = JSON.parse(saved.snapshot);
    snapshot.noteEmbeddings = (snapshot.noteEmbeddings || []).filter(row => row.note_id !== noteId);
    for (const profile of snapshot.profiles || []) if (affectedProfiles.includes(profile.id)) {
      profile.embedding = '';
      profile.sample_count = 0;
    }
    db.prepare('UPDATE speaker_voice_clear_actions SET snapshot = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), saved.id);
  }
  const reset = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='speaker_person_voice_actions'").get();
  if (reset) for (const saved of db.prepare('SELECT id, profile_id, snapshot FROM speaker_person_voice_actions').all()) {
    if (!affectedProfiles.includes(saved.profile_id)) continue;
    const snapshot = JSON.parse(saved.snapshot);
    snapshot.embedding = '';
    snapshot.sample_count = 0;
    db.prepare('UPDATE speaker_person_voice_actions SET snapshot = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), saved.id);
  }
  for (const note of db.prepare('SELECT id, speaker_action_log FROM notes WHERE speaker_action_log IS NOT NULL').all()) {
    let log;
    try { log = JSON.parse(note.speaker_action_log); }
    catch { continue; } // Malformed history cannot be restored by the action handlers.
    let changed = false;
    for (const action of log.actions || []) if (action.embeddingBefore) {
      const kept = action.embeddingBefore.filter(row => row.note_id !== noteId);
      changed ||= kept.length !== action.embeddingBefore.length;
      action.embeddingBefore = kept;
    }
    if (changed) db.prepare('UPDATE notes SET speaker_action_log = ? WHERE id = ?').run(JSON.stringify(log), note.id);
  }
}
function rowProfile(row, noteMappings) {
  if (row.speakerLockSource === 'user' && row.suggestedProfileId) return row.suggestedProfileId;
  if (row.speakerLockSource === 'user' && !row.speakerName && row.speakerIsPlaceholder) return null;
  const run = noteMappings.find(m => m.table === 'speaker_run_mappings' && m.run_id === (row.diarizationRunId || 'legacy') && m.cluster_id === row.speaker);
  return (run || noteMappings.find(m => m.table === 'speaker_mappings' && m.speaker_id === row.speaker))?.profile_id ?? null;
}
const NOTE_COLUMNS = 'id, title, note_type, transcript, created_at, updated_at, speaker_action_log, speaker_label_undo';
function notes(db) { return db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE deleted_at IS NULL`).all(); }
function allNotes(db) { return db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes`).all(); }
function registerAttendees(database, onlyNoteId = null) {
  const db = database.db;
  const rows = onlyNoteId == null
    ? db.prepare("SELECT id, participants FROM notes WHERE note_type = 'meeting' AND deleted_at IS NULL").all()
    : db.prepare("SELECT id, participants FROM notes WHERE id = ? AND note_type = 'meeting' AND deleted_at IS NULL").all(onlyNoteId);
  const saved = db.prepare('SELECT identity_key, profile_id FROM person_attendance WHERE note_id = ?');
  const insert = db.prepare('INSERT INTO person_attendance (note_id, identity_key, profile_id) VALUES (?, ?, ?)');
  const remove = db.prepare('DELETE FROM person_attendance WHERE note_id = ? AND identity_key = ?');
  for (const note of rows) {
    let participants;
    try { participants = JSON.parse(note.participants || '[]'); } catch { participants = []; }
    if (!Array.isArray(participants)) participants = [];
    const current = new Map(saved.all(note.id).map(row => [row.identity_key, row]));
    const present = new Set();
    for (const attendee of participants) {
      if (!attendee || typeof attendee !== 'object' || attendee.self === true || !isEventGuest(attendee)) continue;
      const email = normalized(attendee.email);
      const name = String(attendee.displayName || attendee.name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!email && !name) continue;
      const key = email ? `e:${email}` : `n:${normalized(name)}`;
      present.add(key);
      if (current.has(key)) continue;
      const profiles = db.prepare('SELECT id, display_name, email FROM speaker_profiles ORDER BY id').all();
      const match = profiles.find(p => email && normalized(p.email) === email)
        || profiles.find(p => name && normalized(p.display_name) === normalized(name));
      let id = match?.id;
      if (!id) id = db.prepare('INSERT INTO speaker_profiles (display_name, email, embedding, sample_count) VALUES (?, ?, ?, 0)')
        .run(name || email, email || null, Buffer.alloc(0)).lastInsertRowid;
      else if (email && !match.email) db.prepare('UPDATE speaker_profiles SET email = ? WHERE id = ?').run(email, id);
      insert.run(note.id, key, id);
    }
    for (const key of current.keys()) if (!present.has(key)) remove.run(note.id, key);
  }
}
function listPeople(database) {
  const db = database.db;
  db.transaction(() => registerAttendees(database))();
  const profiles = db.prepare('SELECT id, display_name, email, sample_count, embedding, voice_usable, voice_needs_reapproval, created_at, updated_at FROM speaker_profiles').all();
  const byName = new Map();
  for (const p of profiles) {
    const key = normalized(p.display_name);
    byName.set(key, byName.has(key) ? null : p.id);
  }
  const usage = new Map(profiles.map(p => [p.id, { notes: new Set(), meetings: new Set(), segmentCount: 0, lastHeard: null, lastSeen: null }]));
  const identity = profiles.map(p => ({ id: p.id, name: normalized(p.display_name), email: normalized(p.email) }));
  const duplicates = new Map(profiles.map(p => [p.id, []]));
  for (let i = 0; i < profiles.length; i++) for (let j = i + 1; j < profiles.length; j++) {
    const a = identity[i], b = identity[j];
    if (a.name !== b.name && !(a.email && a.email === b.email) && !near(a.name, b.name)) continue;
    duplicates.get(a.id).push({ id: b.id, name: profiles[j].display_name });
    duplicates.get(b.id).push({ id: a.id, name: profiles[i].display_name });
  }
  const mappingByNote = allMappings(db);
  for (const attendance of db.prepare(`SELECT pa.note_id, pa.profile_id, n.created_at
    FROM person_attendance pa JOIN notes n ON n.id = pa.note_id
    WHERE pa.profile_id IS NOT NULL AND n.deleted_at IS NULL`).all()) {
    const hit = usage.get(attendance.profile_id);
    if (!hit) continue;
    hit.notes.add(attendance.note_id);
    hit.meetings.add(attendance.note_id);
    hit.lastSeen = later(hit.lastSeen, attendance.created_at);
  }
  for (const note of notes(db)) {
    const map = mappingByNote.get(note.id) || [];
    for (const row of readTranscriptDocument(note.transcript).rows) {
      if (row.deleted) continue;
      const id = row.speakerLockSource === 'user' && !row.suggestedProfileId && !row.speakerName && row.speakerIsPlaceholder ? null
        : rowProfile(row, map) || byName.get(normalized(row.speakerName));
      const hit = usage.get(id);
      if (!hit) continue;
      hit.notes.add(note.id); hit.segmentCount++;
      if (note.note_type === 'meeting') hit.meetings.add(note.id);
      const heard = typeof row.timestamp === 'string' && !Number.isNaN(Date.parse(row.timestamp))
        ? row.timestamp : typeof row.timestamp === 'number' && row.timestamp > 1e12
          ? new Date(row.timestamp).toISOString() : note.created_at;
      if (!hit.lastHeard || heard > hit.lastHeard) hit.lastHeard = heard;
    }
    for (const item of map) if (usage.has(item.profile_id)) {
      const hit = usage.get(item.profile_id);
      hit.notes.add(note.id);
      if (note.note_type === 'meeting') hit.meetings.add(note.id);
    }
  }
  return profiles.map(p => {
    const hit = usage.get(p.id);
    return { id: p.id, displayName: p.display_name, email: p.email, noteCount: hit.notes.size,
      meetingCount: hit.meetings.size, segmentCount: hit.segmentCount,
      lastHeard: hit.lastHeard, lastSeen: later(hit.lastSeen, hit.lastHeard),
      sampleCount: p.sample_count || 0,
      hasVoice: !!p.embedding?.length && p.sample_count > 0,
      needsReapproval: p.voice_needs_reapproval === 1,
      legacyVoice: !!p.embedding?.length && p.sample_count > 0 &&
        !db.prepare('SELECT 1 FROM voice_exemplars WHERE profile_id = ? LIMIT 1').get(p.id),
      voiceProgress: require('./voiceEnrollment').progress(database, p.id),
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
  const clearTable = request.type === 'delete' && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_voice_clear_actions'").get();
  const affectedClearIds = new Set(clearTable ? db.prepare('SELECT id, snapshot FROM speaker_voice_clear_actions').all()
    .filter(saved => JSON.parse(saved.snapshot).profiles.some(p => p.id === current.id)).map(saved => saved.id) : []);
  let segmentCount = 0, pinnedCount = 0, noteEmbeddingCount = 0;
  for (const note of allNotes(db)) {
    const map = mappingByNote.get(note.id) || [];
    const rows = readTranscriptDocument(note.transcript).rows;
    const rowIds = [], suggestionIds = [];
    let activeRowCount = 0;
    for (const row of rows) {
      if (row.speakerLockSource === 'user' && !row.suggestedProfileId && !row.speakerName && row.speakerIsPlaceholder) continue;
      const mappedProfile = rowProfile(row, map);
      const linked = mappedProfile === current.id;
      const named = uniqueName && mappedProfile == null && normalized(row.speakerName) === normalized(current.display_name);
      if (!linked && !named) continue;
      rowIds.push(row.id);
      if (!row.deleted) {
        activeRowCount++;
        if (row.speakerLocked || row.speakerLockSource === 'user') pinnedCount++;
      }
    }
    if (request.type === 'delete') for (const row of rows)
      if (!rowIds.includes(row.id) && row.suggestedProfileId === current.id)
        suggestionIds.push(row.id);
    const mappingRows = map.filter(m => m.profile_id === current.id);
    const embeddingRows = ['delete', 'reset'].includes(request.type)
      ? ownedEmbeddings(db, note.id, map, current.id, rows, current.display_name, uniqueName) : [];
    const historyAffected = request.type === 'delete' &&
      readSpeakerActionLog(note).actions.some(action => referencesPerson(action, current, uniqueName) || affectedClearIds.has(action.id));
    if (rowIds.length || suggestionIds.length || mappingRows.length || embeddingRows.length || historyAffected) {
      affected.push({ note, rows, rowIds, suggestionIds, mappingRows, embeddingRows });
      segmentCount += activeRowCount;
      noteEmbeddingCount += embeddingRows.length;
    }
  }
  return { success: true, current, survivor, affected, preview: {
    noteCount: affected.length, segmentCount, pinnedCount, noteEmbeddingCount,
    voiceSamples: current.sample_count || 0, personName: current.display_name,
    survivorName: survivor?.display_name || null } };
}
function previewPersonAction(database, request) {
  const result = plan(database, request);
  return result.success ? result.affected.length || ['rename', 'merge', 'reset', 'delete'].includes(request.type) ? { success: true, ...result.preview,
    historyCount: request.type === 'delete' ? countPersonHistory(database.db, result.current.id) : 0 }
    : { success: false, error: 'no_note_history' } : result;
}
function listPeopleActions(database) { return history.list(database.db); }
function countPersonHistory(db, id) {
  const person = profile(db, id);
  const unique = db.prepare('SELECT display_name FROM speaker_profiles').all()
    .filter(p => normalized(p.display_name) === normalized(person.display_name)).length === 1;
  let count = 0;
  const clearTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_voice_clear_actions'").get();
  const clearIds = new Set(clearTable ? db.prepare('SELECT id, snapshot FROM speaker_voice_clear_actions').all()
    .filter(saved => JSON.parse(saved.snapshot).profiles.some(p => p.id === id)).map(saved => saved.id) : []);
  const seenClearIds = new Set();
  for (const note of allNotes(db)) {
    const ids = new Set();
    for (const action of readSpeakerActionLog(note).actions)
      if (referencesPerson(action, person, unique) || clearIds.has(action.id)) {
        ids.add(action.id);
        if (clearIds.has(action.id)) seenClearIds.add(action.id);
      }
    count += ids.size;
  }
  return count + [...clearIds].filter(id => !seenClearIds.has(id)).length;
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
    if (request.expected && ['noteCount', 'segmentCount', 'pinnedCount', 'noteEmbeddingCount'].some(key =>
      request.expected[key] !== undefined &&
      request.expected[key] !== preview[key])) return { success: false, error: 'preview_changed' };
    if (request.type === 'delete' && request.expected?.historyCount !== undefined &&
      request.expected.historyCount !== countPersonHistory(db, current.id))
      return { success: false, error: 'preview_changed' };
    if (request.type === 'delete') return deletePerson(database, built);
    const id = randomUUID();
    if (request.type === 'reset' || request.type === 'merge')
      require('./voiceEnrollment').snapshotEvidence(db, id, current.id, survivor?.id);
    const nextName = request.type === 'merge' ? survivor.display_name : request.type === 'rename' ? String(request.name).trim() : null;
    const attendanceBefore = db.prepare('SELECT note_id, identity_key FROM person_attendance WHERE profile_id = ?').all(current.id);
    if (!affected.length && ['rename', 'merge'].includes(request.type)) {
      db.prepare('INSERT INTO person_identity_actions (id, action, profile_id, survivor_id, snapshot) VALUES (?, ?, ?, ?, ?)')
        .run(id, request.type, current.id, survivor?.id || null, JSON.stringify({
          profile: serializedProfile(current), afterName: nextName, attendanceBefore,
        }));
      if (request.type === 'rename') db.prepare('UPDATE speaker_profiles SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextName, current.id);
      else {
        db.prepare('UPDATE person_attendance SET profile_id = ? WHERE profile_id = ?').run(survivor.id, current.id);
        db.prepare('UPDATE voice_exemplars SET profile_id = ? WHERE profile_id = ?').run(survivor.id, current.id);
        db.prepare('UPDATE voice_enrollment_candidates SET profile_id = ? WHERE profile_id = ?').run(survivor.id, current.id);
        if (db.prepare('SELECT 1 FROM voice_exemplars WHERE profile_id = ? LIMIT 1').get(survivor.id))
          require('./voiceEnrollment').rebuild(db, survivor.id);
        db.prepare('DELETE FROM speaker_profiles WHERE id = ?').run(current.id);
      }
      history.add(db, { id, kind: request.type, profileId: current.id, label: current.display_name });
      return { success: true, id, ...preview, noteIds: [] };
    }
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
        correctionRevision: row.correctionRevision,
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
      if (request.type === 'merge') action.attendanceBefore = attendanceBefore;
      if (request.type === 'reset') action.embeddingBefore = affected.find(a => a.note.id === record.noteId).embeddingRows.map(savedEmbedding);
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
      if (request.type === 'merge') db.prepare('UPDATE person_attendance SET profile_id = ? WHERE profile_id = ?').run(survivor.id, current.id);
      else db.prepare('UPDATE person_attendance SET profile_id = NULL WHERE profile_id = ?').run(current.id);
      for (const table of ['speaker_mappings', 'speaker_run_mappings']) db.prepare(
        `UPDATE ${table} SET profile_id = ?, display_name = ? WHERE profile_id = ?`)
        .run(survivor?.id || null, nextName || '', current.id);
      if (request.type === 'merge') {
        db.prepare('UPDATE voice_exemplars SET profile_id = ? WHERE profile_id = ?').run(survivor.id, current.id);
        db.prepare('UPDATE voice_enrollment_candidates SET profile_id = ? WHERE profile_id = ?').run(survivor.id, current.id);
        if (db.prepare('SELECT 1 FROM voice_exemplars WHERE profile_id = ? LIMIT 1').get(survivor.id))
          require('./voiceEnrollment').rebuild(db, survivor.id);
      } else {
        require('./voiceEnrollment').pruneSnapshots(db, 'profile_id', current.id);
        db.prepare('DELETE FROM voice_enrollment_actions WHERE profile_id = ?').run(current.id);
      }
      db.prepare('DELETE FROM speaker_profiles WHERE id = ?').run(current.id);
    } else if (request.type === 'rename') {
      for (const table of ['speaker_mappings', 'speaker_run_mappings']) db.prepare(
        `UPDATE ${table} SET display_name = ? WHERE profile_id = ?`).run(nextName, current.id);
    } else if (request.type === 'reset') {
      for (const item of affected) for (const row of item.embeddingRows)
        db.prepare('DELETE FROM note_speaker_embeddings WHERE note_id = ? AND speaker_id = ?').run(row.note_id, row.speaker_id);
      for (const table of ['speaker_mappings', 'speaker_run_mappings']) db.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(current.id);
      db.prepare('UPDATE speaker_profiles SET embedding = ?, sample_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(Buffer.alloc(0), current.id);
      require('./voiceEnrollment').removeEvidence(db, current.id, true);
    }
    history.add(db, { id, kind: request.type, profileId: current.id, label: current.display_name });
    return { success: true, id, ...preview, noteIds: affected.map(a => a.note.id) };
  })();
}
function undoPersonAction(database, id) {
  return database.db.transaction(() => {
    const db = database.db;
    const unavailable = history.status(db, id)?.unavailable_reason;
    if (unavailable) return { success: false, error: unavailable };
    if (!history.canUndo(db, id)) return { success: false, error: 'later_change' };
    const found = allNotes(db).map(note => ({ note, log: readSpeakerActionLog(note) }))
      .find(({ log }) => log.actions.some(action => action.kind === 'person' && action.id === id));
    if (!found) {
      const identity = db.prepare('SELECT * FROM person_identity_actions WHERE id = ?').get(id);
      if (identity) {
        const saved = JSON.parse(identity.snapshot);
        if (identity.action === 'rename') {
          const current = profile(db, identity.profile_id);
          if (!current || current.display_name !== saved.afterName) return { success: false, error: 'later_change' };
          db.prepare('UPDATE speaker_profiles SET display_name = ?, updated_at = ? WHERE id = ?')
            .run(saved.profile.display_name, saved.profile.updated_at, current.id);
        } else {
          if (profile(db, identity.profile_id) || !profile(db, identity.survivor_id)) return { success: false, error: 'later_change' };
          if (saved.attendanceBefore.some(row => db.prepare('SELECT profile_id FROM person_attendance WHERE note_id = ? AND identity_key = ?')
            .get(row.note_id, row.identity_key)?.profile_id !== identity.survivor_id))
            return { success: false, error: 'later_change' };
          if (saved.profile.email && db.prepare('SELECT 1 FROM speaker_profiles WHERE lower(email) = lower(?)').get(saved.profile.email))
            return { success: false, error: 'later_change' };
          writeProfile(db, saved.profile);
          for (const row of saved.attendanceBefore) {
            db.prepare('UPDATE person_attendance SET profile_id = ? WHERE note_id = ? AND identity_key = ?')
              .run(identity.profile_id, row.note_id, row.identity_key);
          }
          require('./voiceEnrollment').restoreEvidence(db, id);
        }
        db.prepare('DELETE FROM person_identity_actions WHERE id = ?').run(id);
        history.remove(db, id);
        return { success: true, noteIds: [], personAction: { type: identity.action === 'merge' ? 'undo_merge' : 'rename',
          profileId: identity.profile_id, survivorId: identity.survivor_id, displayName: saved.profile.display_name } };
      }
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_person_voice_actions'").get();
      const saved = table && db.prepare('SELECT profile_id, snapshot FROM speaker_person_voice_actions WHERE id = ?').get(id);
      if (!saved) return { success: false, error: 'action_missing' };
      const p = profile(db, saved.profile_id);
      if (!p) return { success: false, error: 'person_deleted' };
      const old = JSON.parse(saved.snapshot);
      db.prepare('UPDATE speaker_profiles SET embedding = ?, sample_count = ? WHERE id = ?')
        .run(Buffer.from(old.embedding, 'base64'), old.sample_count, old.id);
      require('./voiceEnrollment').restoreEvidence(db, id);
      db.prepare('DELETE FROM speaker_person_voice_actions WHERE id = ?').run(id);
      history.remove(db, id);
      return { success: true, noteIds: [], personAction: { type: 'undo_reset', profileId: old.id } };
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
    if (affected.some(x => !x.note || newestAvailableAction(x.log)?.id !== id)) return { success: false, error: 'later_change' };
    const person = action.profileBefore;
    if (!person) return { success: false, error: 'action_missing' };
    for (const { note } of affected) if (note.deleted_at)
      db.prepare("UPDATE notes SET deleted_at = NULL, sync_status = 'pending' WHERE id = ?").run(note.id);
    if (action.action === 'merge' || action.action === 'delete') writeProfile(db, person);
    else db.prepare('UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, sample_count = ?, updated_at = ? WHERE id = ?')
      .run(person.display_name, person.email, Buffer.from(person.embedding, 'base64'), person.sample_count, person.updated_at, person.id);
    if (action.action === 'merge') for (const row of action.attendanceBefore || [])
      db.prepare('UPDATE person_attendance SET profile_id = ? WHERE note_id = ? AND identity_key = ? AND profile_id = ?')
        .run(person.id, row.note_id, row.identity_key, action.survivorId);
    for (const { note, log } of affected) {
      const entry = newestAvailableAction(log);
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
      if (action.action === 'reset') restoreEmbeddings(db, entry.embeddingBefore);
      if (action.action === 'reset') db.prepare('UPDATE notes SET speaker_action_log = ? WHERE id = ?')
        .run(JSON.stringify(removeNewestAction(log)), note.id);
      else db.prepare("UPDATE notes SET transcript = ?, speaker_action_log = ?, sync_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(writeTranscriptDocument(rows, doc.unknownNumberHighWater), JSON.stringify(removeNewestAction(log)), note.id);
    }
    if (action.action === 'reset' || action.action === 'merge')
      require('./voiceEnrollment').restoreEvidence(db, id);
    history.remove(db, id);
    return { success: true, noteIds: action.affectedNoteIds,
      personAction: { type: action.action === 'merge' ? 'undo_merge' : action.action === 'reset' ? 'undo_reset' : action.action,
        profileId: person.id, survivorId: action.survivorId, displayName: person.display_name } };
  })();
}
function referencesProfile(value, id) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    ['profileId', 'profile_id', 'createdProfileId', 'survivorId', 'suggestedProfileId'].includes(key) && item === id ||
    referencesProfile(item, id));
}
function referencesPerson(value, person, uniqueName) {
  if (referencesProfile(value, person.id)) return true;
  if (!uniqueName || !value) return false;
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    try { return referencesPerson(JSON.parse(value), person, uniqueName); } catch { return false; }
  }
  if (typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    ['speakerName', 'suggestedName', 'displayName', 'display_name'].includes(key) &&
      normalized(item) === normalized(person.display_name) || referencesPerson(item, person, uniqueName));
}
function deletePerson(database, built) {
  const db = database.db;
  const { current, affected, preview } = built;
  const uniqueName = db.prepare('SELECT display_name FROM speaker_profiles').all()
    .filter(p => normalized(p.display_name) === normalized(current.display_name)).length === 1;
  const rowIdsByNote = new Map(affected.map(item => [item.note.id, new Set(item.rowIds)]));
  const suggestionIdsByNote = new Map(affected.map(item => [item.note.id, new Set(item.suggestionIds)]));
  const clearTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_voice_clear_actions'").get();
  const affectedClearIds = new Set();
  if (clearTable) for (const saved of db.prepare('SELECT id, snapshot FROM speaker_voice_clear_actions').all()) {
    const snapshot = JSON.parse(saved.snapshot);
    if (!snapshot.profiles.some(p => p.id === current.id)) continue;
    snapshot.profiles = snapshot.profiles.filter(p => p.id !== current.id);
    const ownedSpeakers = new Set();
    for (const note of allNotes(db)) {
      const mappings = snapshot.mappings.filter(m => m.note_id === note.id);
      const rows = readTranscriptDocument(note.transcript).rows;
      for (const speaker of ownedSpeakerIds(mappings, current.id, rows, current.display_name, uniqueName))
        ownedSpeakers.add(`${note.id}:${speaker}`);
    }
    snapshot.noteEmbeddings = (snapshot.noteEmbeddings || []).filter(row => !ownedSpeakers.has(`${row.note_id}:${row.speaker_id}`));
    snapshot.mappings = snapshot.mappings.filter(m => m.profile_id !== current.id);
    snapshot.personDeleted = true;
    db.prepare('UPDATE speaker_voice_clear_actions SET snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), saved.id);
    affectedClearIds.add(saved.id);
    history.invalidateAction(db, saved.id);
  }
  const resetTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_person_voice_actions'").get();
  if (resetTable) db.prepare('DELETE FROM speaker_person_voice_actions WHERE profile_id = ?').run(current.id);
  for (const action of db.prepare('SELECT id FROM person_identity_actions WHERE profile_id = ? OR survivor_id = ?')
    .all(current.id, current.id)) history.invalidateAction(db, action.id);
  db.prepare('DELETE FROM person_identity_actions WHERE profile_id = ? OR survivor_id = ?').run(current.id, current.id);
  let historyCount = 0;
  const changedNoteIds = new Set();
  for (const note of allNotes(db)) {
    const doc = readTranscriptDocument(note.transcript);
    const log = readSpeakerActionLog(note);
    const invalidCorrectionIds = new Set();
    for (const action of log.actions) if (['correction', 'reconsideration'].includes(action.kind) &&
      referencesPerson(action, current, uniqueName)) invalidCorrectionIds.add(action.id);
    const targetRows = rowIdsByNote.get(note.id) || new Set();
    const suggestionRows = suggestionIdsByNote.get(note.id) || new Set();
    let changedHistory = false;
    const removedHistory = new Set();
    let highWater = doc.unknownNumberHighWater || 0;
    const rows = doc.rows.map(row => {
      const next = { ...row };
      delete next.corrections;
      if (targetRows.has(row.id)) {
        highWater++;
        delete next.suggestedProfileId;
        delete next.suggestedName;
        next.speakerName = undefined;
        next.speakerIsPlaceholder = true;
        next.machineReason = undefined;
        next.unknownNumber = highWater;
        next.speakerLocked = false;
        next.speakerLockSource = undefined;
        next.correctionRevision = (Number(row.correctionRevision) || 0) + 1;
      } else if (suggestionRows.has(row.id) || next.suggestedProfileId === current.id) {
        delete next.suggestedProfileId;
        delete next.suggestedName;
      }
      return next;
    });
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
          action.kind === 'correction' && invalidCorrectionIds.has(action.id)) {
        removedHistory.add(action.id); continue;
      }
      if (referencesPerson(action, current, uniqueName)) {
        removedHistory.add(action.id);
        actions.push({ kind: action.kind, id: action.id, sequence: action.sequence,
          unavailableReason: 'person_deleted' });
        changedHistory = true;
      } else actions.push(action);
    }
    historyCount += removedHistory.size;
    for (const actionId of removedHistory) {
      history.invalidateAction(db, actionId, note.id);
      history.invalidateAction(db, actionId);
    }
    if (targetRows.size || suggestionRows.size || changedHistory || actions.length !== log.actions.length) {
      db.prepare('UPDATE notes SET transcript = ?, speaker_action_log = ?, speaker_label_undo = NULL WHERE id = ?')
        .run(writeTranscriptDocument(rows, highWater), JSON.stringify({ ...log, actions }), note.id);
      changedNoteIds.add(note.id);
    }
  }
  for (const table of ['speaker_mappings', 'speaker_run_mappings'])
    db.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(current.id);
  for (const item of affected) for (const row of item.embeddingRows)
    db.prepare('DELETE FROM note_speaker_embeddings WHERE note_id = ? AND speaker_id = ?').run(row.note_id, row.speaker_id);
  db.prepare('UPDATE person_attendance SET profile_id = NULL WHERE profile_id = ?').run(current.id);
  require('./voiceEnrollment').pruneSnapshots(db, 'profile_id', current.id);
  db.prepare('DELETE FROM voice_enrollment_actions WHERE profile_id = ?').run(current.id);
  db.prepare('DELETE FROM speaker_profiles WHERE id = ?').run(current.id);
  history.add(db, { id: randomUUID(), kind: 'delete', profileId: current.id, label: 'deleted_person' });
  history.invalidateProfile(db, current.id);
  return { success: true, id: null, ...preview, historyCount, noteIds: [...changedNoteIds] };
}
function previewClearVoiceData(database) {
  const db = database.db;
  const personCount = db.prepare('SELECT COUNT(*) AS n FROM speaker_profiles').get().n;
  const embeddingCount = db.prepare('SELECT COUNT(*) AS n FROM speaker_profiles WHERE length(embedding) > 0').get().n;
  const mappingCount = ['speaker_mappings', 'speaker_run_mappings'].reduce((n, table) =>
    n + db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  const noteEmbeddingCount = db.prepare('SELECT COUNT(*) AS n FROM note_speaker_embeddings').get().n;
  return { success: true, personCount, embeddingCount, mappingCount, noteEmbeddingCount };
}
function clearVoiceData(database, expected) {
  return database.db.transaction(() => {
    const db = database.db;
    const preview = previewClearVoiceData(database);
    if (expected && ['personCount', 'embeddingCount', 'mappingCount', 'noteEmbeddingCount'].some(key =>
      expected[key] !== undefined && expected[key] !== preview[key]))
      return { success: false, error: 'preview_changed' };
    const id = randomUUID();
    require('./voiceEnrollment').snapshotEvidence(db, id);
    const profiles = db.prepare('SELECT id, embedding, sample_count FROM speaker_profiles').all()
      .map(p => ({ ...p, embedding: Buffer.from(p.embedding).toString('base64') }));
    const mappings = ['speaker_mappings', 'speaker_run_mappings'].flatMap(table =>
      db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row, table })));
    const noteEmbeddings = db.prepare('SELECT * FROM note_speaker_embeddings').all().map(savedEmbedding);
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
      .run(id, JSON.stringify({ profiles, mappings, noteEmbeddings, noteIds }));
    db.prepare('UPDATE speaker_profiles SET embedding = ?, sample_count = 0').run(Buffer.alloc(0));
    require('./voiceEnrollment').removeEvidence(db);
    db.prepare('DELETE FROM speaker_mappings').run();
    db.prepare('DELETE FROM speaker_run_mappings').run();
    db.prepare('DELETE FROM note_speaker_embeddings').run();
    history.add(db, { id, kind: 'clear_voice', label: 'All people' });
    return { ...preview, id, noteIds };
  })();
}
function undoClearVoiceData(database, id) {
  return database.db.transaction(() => {
    const db = database.db;
    const unavailable = history.status(db, id)?.unavailable_reason;
    if (unavailable) return { success: false, error: unavailable };
    if (!history.canUndo(db, id)) return { success: false, error: 'later_change' };
    const saved = db.prepare('SELECT snapshot FROM speaker_voice_clear_actions WHERE id = ?').get(id);
    if (!saved) return { success: false, error: 'action_missing' };
    const { profiles, mappings, noteEmbeddings, noteIds, personDeleted } = JSON.parse(saved.snapshot);
    if (personDeleted) return { success: false, error: 'person_deleted' };
    const notesToUpdate = noteIds.map(noteId => database.getNote(noteId));
    if (notesToUpdate.some(note => !note || newestAvailableAction(readSpeakerActionLog(note))?.id !== id))
      return { success: false, error: 'later_change' };
    if (profiles.some(p => !profile(db, p.id))) return { success: false, error: 'person_deleted' };
    if (db.prepare('SELECT COUNT(*) AS n FROM speaker_mappings').get().n || db.prepare('SELECT COUNT(*) AS n FROM speaker_run_mappings').get().n)
      return { success: false, error: 'later_change' };
    for (const note of notesToUpdate) if (note.deleted_at)
      db.prepare("UPDATE notes SET deleted_at = NULL, sync_status = 'pending' WHERE id = ?").run(note.id);
    for (const p of profiles) db.prepare('UPDATE speaker_profiles SET embedding = ?, sample_count = ? WHERE id = ?')
      .run(Buffer.from(p.embedding, 'base64'), p.sample_count, p.id);
    for (const m of mappings) {
      const keys = m.table === 'speaker_mappings' ? ['note_id', 'speaker_id'] : ['note_id', 'run_id', 'cluster_id'];
      db.prepare(`INSERT INTO ${m.table} (${keys.join(', ')}, profile_id, display_name) VALUES (${keys.map(() => '?').join(', ')}, ?, ?)`)
        .run(...keys.map(key => m[key]), m.profile_id, m.display_name);
    }
    restoreEmbeddings(db, noteEmbeddings);
    require('./voiceEnrollment').restoreEvidence(db, id);
    for (const note of notesToUpdate) db.prepare('UPDATE notes SET speaker_action_log = ? WHERE id = ?')
      .run(JSON.stringify(removeNewestAction(readSpeakerActionLog(note))), note.id);
    db.prepare('DELETE FROM speaker_voice_clear_actions WHERE id = ?').run(id);
    history.remove(db, id);
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
    const changedRows = new Set(readSpeakerActionLog(note).actions
      .filter(action => ['correction', 'split'].includes(action.kind) && action.event?.afterFinalAnalysis)
      .flatMap(action => action.event?.affectedRowIds || action.event?.rowIds || []));
    for (const row of readTranscriptDocument(note.transcript).rows) {
      if (row.deleted) continue;
      const reason = row.uncertainty?.reason ||
        (changedRows.has(row.id) || row.changedAfterFinal || row.changedAfterFinalAnalysis ? 'changed_after_final'
          : !row.speakerAssessmentAvailable && !row.speakerLocked && !row.speakerName ? 'unassessed' : null);
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
module.exports = { listPeople, registerAttendees, listReviewRows, previewPersonAction, applyPersonAction, undoPersonAction,
  previewClearVoiceData, clearVoiceData, undoClearVoiceData, listPeopleActions, scrubDeletedRecordingSnapshots };
