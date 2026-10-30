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
  return true;
}
function add(db, action) {
  if (!ensure(db)) return;
  db.prepare(`INSERT INTO speaker_global_actions (id, kind, profile_id, note_id, label)
    VALUES (?, ?, ?, ?, ?)`).run(action.id, action.kind, action.profileId ?? null,
    action.noteId ?? null, action.label || action.kind);
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
  const last = latest(db);
  return !last || last.id === id && last.note_id === noteId;
}
function remove(db, id, noteId = null) {
  if (!ensure(db)) return;
  db.prepare('DELETE FROM speaker_global_actions WHERE id = ? AND note_id IS ?').run(id, noteId);
}
function invalidateProfile(db, id) {
  if (!ensure(db)) return;
  db.prepare("UPDATE speaker_global_actions SET unavailable_reason = 'person_deleted' WHERE profile_id = ?")
    .run(id);
}
function invalidateAction(db, id, noteId = null) {
  if (!ensure(db)) return;
  db.prepare("UPDATE speaker_global_actions SET unavailable_reason = 'person_deleted' WHERE id = ? AND note_id IS ?")
    .run(id, noteId);
}
function list(db) {
  if (!ensure(db)) return [];
  return db.prepare(`SELECT id, kind, profile_id AS profileId, note_id AS noteId, label,
    unavailable_reason AS unavailableReason, created_at AS createdAt
    FROM speaker_global_actions ORDER BY sequence DESC LIMIT 100`).all();
}
module.exports = { add, latest, canUndo, remove, invalidateProfile, invalidateAction, status, list };
