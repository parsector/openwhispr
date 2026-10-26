const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { PRESETS } = require('../../src/helpers/routines/routinePresets');
const { selectedNoteContext, RoutineRunner } = require('../../src/helpers/routines/routineRunner');

const schedule = { schema_version: 1, slots: [{ days: [5], time: '16:00' }] };
function save(database, name, id) {
  return database.saveRoutine({ id, name, prompt: 'Write a digest', trigger_config: schedule });
}

test('routine rename refuses folder collision and deletion offers both folder outcomes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-folders-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => directory, getAppPath: () => process.cwd(), isReady: () => false } };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  process.env.NODE_ENV = 'test';
  let database;
  try { database = new (require('../../src/helpers/database.js'))(); }
  catch (error) {
    if (/NODE_MODULE_VERSION|Could not locate the bindings file/.test(String(error))) { t.skip('better-sqlite3 binding unavailable'); return; }
    throw error;
  }
  t.after(() => database.db.close());
  const first = save(database, 'First');
  assert.equal(first.success, true, first.error);
  assert.deepEqual(database.getRoutine(first.routine.id).source_config,
    { folder_ids: null, people: null, lookback_days: 7 });
  assert.ok(database.db.prepare('PRAGMA table_info(routines)').all().some((column) => column.name === 'source_config'));
  const sourceConfig = { folder_ids: [], people: ['alex@example.com'], lookback_days: 7 };
  const configured = database.saveRoutine({ id: first.routine.id, name: 'First', prompt: 'Write a digest',
    trigger_config: schedule, source_config: sourceConfig });
  assert.equal(configured.success, true, configured.error);
  assert.deepEqual(database.getRoutine(first.routine.id).source_config, sourceConfig);
  const second = save(database, 'Second');
  assert.equal(second.success, true, second.error);
  const participantNote = database.saveNote('Meeting', 'content', 'personal', null, null,
    null, first.routine.space_id).note;
  database.db.prepare('UPDATE notes SET participants=? WHERE id=?').run(
    JSON.stringify([{ email: 'Alex@Example.com', displayName: 'Alex' }, { email: 'self@example.com', self: true }]),
    participantNote.id);
  assert.deepEqual(database.listRoutinePeople(), [{ email: 'alex@example.com', name: 'Alex' }]);
  const collision = save(database, 'Second', first.routine.id);
  assert.equal(collision.success, false);
  assert.equal(database.getRoutine(first.routine.id).name, 'First');
  assert.ok(database.getFolders().some((folder) => folder.routine_id === first.routine.id && folder.name === 'First'));
  assert.equal(save(database, 'Second').success, false);

  const firstFolder = database.getFolders().find((folder) => folder.routine_id === first.routine.id);
  assert.equal(database.deleteFolder(firstFolder.id).success, true);
  assert.ok(database.getRoutine(first.routine.id));
  assert.equal(database.getFolders().some((folder) => folder.routine_id === first.routine.id), false);
  // A run recreates a hand-deleted folder before writing its note.
  const run = database.claimRoutineRun(first.routine.id, 'manual:test', 'manual');
  const runner = new RoutineRunner({ database, infer: async () => ({ text: 'Digest text', toolsAvailable: false }) });
  return runner.run({ id: run.id, routineId: first.routine.id, model: { mode: 'local', provider: 'local', model: 'test' } }).then((result) => {
    assert.equal(result.status, 'done', result.error);
    const recreated = database.getFolders().find((folder) => folder.routine_id === first.routine.id);
    assert.ok(recreated);
    assert.notEqual(recreated.id, firstFolder.id);
    assert.equal(database.deleteRoutine(first.routine.id, false).success, true);
    assert.equal(database.getRoutine(first.routine.id), null);
    assert.ok(database.getFolders().some((folder) => folder.id === recreated.id && !folder.routine_id));
    assert.ok(database.db.prepare('SELECT id FROM notes WHERE id=?').get(result.note.id));
    const selected = selectedNoteContext(database,
      { folder_ids: [], people: [], lookback_days: 7 }, Date.now());
    assert.doesNotMatch(selected.text, new RegExp(`\\[Note ${result.note.id}\\]`));

    const secondFolder = database.getFolders().find((folder) => folder.routine_id === second.routine.id);
    const note = database.saveNote('To remove', 'content', 'personal', null, null, secondFolder.id, second.routine.space_id).note;
    assert.equal(database.deleteRoutine(second.routine.id, true).success, true);
    assert.equal(database.getRoutine(second.routine.id), null);
    assert.equal(database.getFolders().some((folder) => folder.id === secondFolder.id), false);
    assert.equal(database.db.prepare('SELECT id FROM notes WHERE id=?').get(note.id), undefined);
  });
});

test('selected note pre-filter bounds input and excludes routine notes by ID', () => {
  const now = Date.now();
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, title: `Note ${i + 1}`, created_at: new Date(now - i * 1000).toISOString(),
    participants: JSON.stringify([{ email: 'alex@example.com', displayName: 'Alex' }]),
    enhanced_content: 'x'.repeat(4000), content: '', folder_id: 2, routine_id: null,
  }));
  rows[0].routine_id = 'another-routine';
  const db = { _accountScopeCondition: () => ({ sql: '1=1', params: [] }), db: { prepare: (sql) => {
    assert.match(sql, /NOT IN \(SELECT note_id FROM routine_runs/);
    assert.match(sql, /LIMIT 200/);
    return { all: () => rows };
  } } };
  const result = selectedNoteContext(db, { folder_ids: [2], people: ['alex@example.com'], lookback_days: 7 }, now);
  assert.equal(result.count, 15);
  assert.ok(result.text.length <= 60000);
  assert.doesNotMatch(result.text, /\[Note 1\]/);
  assert.match(result.text, /\[Note 2\]/);
});

test('Friday digest template has Friday trigger and source selection requirements', () => {
  const preset = PRESETS.find((item) => item.id === 'friday-digest');
  assert.deepEqual(preset.trigger_config.slots[0].days, [5]);
  assert.deepEqual(preset.source_config, { folder_ids: [], people: [], lookback_days: 7 });
  assert.deepEqual(preset.needs, ['routines.presets.fridayDigest.pickFolders', 'routines.presets.fridayDigest.pickPeople']);
  assert.deepEqual(preset.required_selection, ['folders', 'people']);
  for (const item of ['decisions', 'risks', 'blockers', 'status update']) assert.match(preset.prompt, new RegExp(item));
});


test('selected notes treats null as all and empty arrays as nothing', () => {
  const now = Date.now();
  const rows = [{ id: 1, title: 'Meeting', created_at: new Date(now).toISOString(),
    participants: JSON.stringify([{ email: 'alex@example.com' }]), enhanced_content: '', content: 'Decision', folder_id: 2, routine_id: null }];
  const db = { _accountScopeCondition: () => ({ sql: '1=1', params: [] }), db: { prepare: () => ({ all: () => rows }) } };
  assert.equal(selectedNoteContext(db, { folder_ids: null, people: null, lookback_days: 7 }, now).count, 1);
  assert.equal(selectedNoteContext(db, { folder_ids: [], people: null, lookback_days: 7 }, now).count, 0);
  assert.equal(selectedNoteContext(db, { folder_ids: null, people: [], lookback_days: 7 }, now).count, 0);
});
