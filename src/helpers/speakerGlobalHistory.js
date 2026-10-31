function ensure(db) {
  if (typeof db.exec !== 'function') return false;
  db.exec(`CREATE TABLE IF NOT EXISTS speaker_global_actions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    profile_id INTEGER,
    note_id INTEGER,
    label TEXT NOT NULL,
    unavailable_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_speaker_global_actions_id_note ON speaker_global_actions(id, note_id)');
  // Older databases may still contain actions for notes deleted before this cleanup existed.
  db.exec('DELETE FROM speaker_global_actions WHERE note_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM notes WHERE notes.id = speaker_global_actions.note_id)');
  db.exec(`UPDATE speaker_global_actions SET label = 'deleted_person'
    WHERE (unavailable_reason = 'person_deleted' OR kind = 'delete')
      AND label != 'deleted_person'`);
  return true;
}
const MAX_HISTORY_ROWS = 100;
function compact(db) {
  const rows = db.prepare('SELECT sequence, profile_id, note_id, kind, unavailable_reason FROM speaker_global_actions ORDER BY sequence DESC').all();
  if (rows.length <= MAX_HISTORY_ROWS) return;
  const kept = new Set();
  const owners = new Set();
  // Preserve each owner's current undo point before filling with recent context.
  for (const row of rows) {
    if (row.unavailable_reason) continue;
    const owner = row.profile_id != null ? `person:${row.profile_id}`
      : row.note_id != null ? `note:${row.note_id}` : `global:${row.kind}`;
    if (!owners.has(owner) && kept.size < MAX_HISTORY_ROWS) {
      kept.add(row.sequence);
      owners.add(owner);
    }
  }
  for (const row of rows) if (kept.size < MAX_HISTORY_ROWS) kept.add(row.sequence);
  const remove = db.prepare('DELETE FROM speaker_global_actions WHERE sequence = ?');
  for (const row of rows) if (!kept.has(row.sequence)) remove.run(row.sequence);
}
function add(db, action) {
  if (!ensure(db)) return;
  db.prepare(`INSERT INTO speaker_global_actions (id, kind, profile_id, note_id, label)
    VALUES (?, ?, ?, ?, ?)`).run(action.id, action.kind, action.profileId ?? null,
    action.noteId ?? null, action.label || action.kind);
  compact(db);
}
function latest(db) {
  if (!ensure(db)) return null;
  return db.prepare('SELECT * FROM speaker_global_actions WHERE unavailable_reason IS NULL ORDER BY sequence DESC LIMIT 1').get();
}
function status(db, id, noteId = null) {
  if (!ensure(db)) return null;
  return db.prepare('SELECT unavailable_reason FROM speaker_global_actions WHERE id = ? AND note_id IS ? ORDER BY sequence DESC LIMIT 1')
    .get(id, noteId);
}
function canUndo(db, id, noteId = null) {
  if (status(db, id, noteId)?.unavailable_reason) return false;
  const last = latest(db);
  return !last || last.id === id && last.note_id === noteId;
}
function remove(db, id, noteId = null) {
  if (!ensure(db)) return;
  db.prepare('DELETE FROM speaker_global_actions WHERE id = ? AND note_id IS ?').run(id, noteId);
}
function invalidateProfile(db, id) {
  if (!ensure(db)) return;
  db.prepare("UPDATE speaker_global_actions SET unavailable_reason = 'person_deleted', label = 'deleted_person' WHERE profile_id = ?")
    .run(id);
  compact(db);
}
function invalidateAction(db, id, noteId = null) {
  if (!ensure(db)) return;
  db.prepare("UPDATE speaker_global_actions SET unavailable_reason = 'person_deleted', label = 'deleted_person' WHERE id = ? AND note_id IS ?")
    .run(id, noteId);
}
function retireNotes(db, subquery, params = []) {
  if (!ensure(db)) return;
  if (!db.prepare('PRAGMA table_info(notes)').all().some(column => column.name === 'speaker_action_log')) {
    db.prepare(`DELETE FROM speaker_global_actions WHERE note_id IN (${subquery})`).run(...params);
    return;
  }
  const notes = db.prepare(`SELECT id, speaker_action_log FROM notes WHERE id IN (${subquery})`).all(...params);
  const affected = new Set();
  for (const note of notes) {
    if (!note.speaker_action_log) continue;
    const log = JSON.parse(note.speaker_action_log);
    for (const action of log.actions || []) if (db.prepare(
      'SELECT 1 FROM speaker_global_actions WHERE id = ? AND note_id IS NULL').get(action.id))
      affected.add(action.id);
  }
  for (const id of affected) {
    db.prepare("UPDATE speaker_global_actions SET unavailable_reason = 'action_missing' WHERE id = ? AND note_id IS NULL AND unavailable_reason IS NULL").run(id);
    const clearTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_voice_clear_actions'").get();
    if (clearTable) db.prepare('DELETE FROM speaker_voice_clear_actions WHERE id = ?').run(id);
  }
  if (affected.size) for (const note of db.prepare('SELECT id, speaker_action_log FROM notes WHERE speaker_action_log IS NOT NULL').all()) {
    const log = JSON.parse(note.speaker_action_log);
    let changed = false;
    const actions = (log.actions || []).map(action => {
      if (!affected.has(action.id) || action.unavailableReason) return action;
      changed = true;
      return { id: action.id, kind: action.kind, sequence: action.sequence, unavailableReason: 'action_missing' };
    });
    if (changed) db.prepare('UPDATE notes SET speaker_action_log = ? WHERE id = ?')
      .run(JSON.stringify({ ...log, actions }), note.id);
  }
  db.prepare(`DELETE FROM speaker_global_actions WHERE note_id IN (${subquery})`).run(...params);
  compact(db);
}
function list(db) {
  if (!ensure(db)) return [];
  compact(db);
  return db.prepare(`SELECT speaker_global_actions.id, kind, profile_id AS profileId,
    note_id AS noteId, label, speaker_global_actions.unavailable_reason AS unavailableReason,
    notes.deleted_at IS NOT NULL AS noteInTrash,
    speaker_global_actions.created_at AS createdAt FROM speaker_global_actions
    LEFT JOIN notes ON notes.id = speaker_global_actions.note_id
    ORDER BY sequence DESC`).all();
}
module.exports = { add, latest, canUndo, remove, invalidateProfile, invalidateAction, retireNotes, status, list };
