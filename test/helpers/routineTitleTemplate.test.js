const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { renderRoutineTitle } = require('../../src/helpers/routines/routineTitleTemplate');

const now = new Date(2026, 9, 27, 9, 5);

test('renders tokens, local ISO date, unknown tokens, defaults, and missing event', () => {
  const input = { name: 'Meeting prep', triggerType: 'before_event', event: 'Weekly sync', now };
  assert.equal(renderRoutineTitle({ ...input, titleTemplate: 'Prep - {event} - {date} ({name}) {folder}' }),
    'Prep - Weekly sync - 2026-10-27 (Meeting prep) {folder}');
  assert.equal(renderRoutineTitle({ ...input, titleTemplate: '' }), 'Meeting prep — Weekly sync — 2026-10-27');
  assert.equal(renderRoutineTitle({ ...input, event: '', titleTemplate: 'Prep - {event} - {date}' }),
    'Meeting prep — 2026-10-27');
  assert.equal(renderRoutineTitle({ ...input, triggerType: 'time', titleTemplate: 'Prep - {event} - {date}' }),
    'Meeting prep — 2026-10-27');
  assert.equal(renderRoutineTitle({ ...input, triggerType: 'time', titleTemplate: 'Brief for {date}' }),
    'Brief for 2026-10-27');
  assert.ok(renderRoutineTitle({ ...input, event: 'A very long '.repeat(40) }).length <= 200);
});

test('saved template and other trigger keys round-trip; event runs title notes and collisions keep time suffix', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-title-'));
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
  const config = { schema_version: 1, minutes_before: 10, title_pattern: '', has_attendees: false,
    has_meeting_link: false, skip_declined: true, title_template: '  Prep - {event} - {date}  ', extra_key: 'kept' };
  const saved = database.saveRoutine({ name: 'Meeting prep', prompt: 'Prepare', trigger_type: 'before_event', trigger_config: config });
  assert.equal(saved.success, true, saved.error);
  const routine = database.getRoutine(saved.routine.id);
  assert.equal(routine.trigger_config.title_template, 'Prep - {event} - {date}');
  assert.equal(routine.trigger_config.extra_key, 'kept');
  const event = { id: 'event-1', summary: 'Weekly sync', start_time: new Date().toISOString(), attendees: '[]' };
  database.getCalendarEventById = () => event;
  const { RoutineRunner } = require('../../src/helpers/routines/routineRunner');
  const runner = new RoutineRunner({ database, infer: async () => ({ text: 'Prepared', toolsAvailable: false }) });
  async function run(key, trigger, eventId) {
    const row = database.claimRoutineRun(routine.id, key, trigger);
    return runner.run({ id: row.id, routineId: routine.id, trigger, eventId,
      model: { mode: 'local', provider: 'local', model: 'test' } });
  }
  const first = await run('event:first', 'before_event', event.id);
  assert.equal(first.status, 'done', first.error);
  assert.match(first.note.title, /^Prep - Weekly sync - \d{4}-\d\d-\d\d$/);
  const second = await run('event:second', 'before_event', event.id);
  assert.equal(second.status, 'done', second.error);
  assert.match(second.note.title, /^Prep - Weekly sync - \d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.equal(database.getFolders().find((folder) => folder.routine_id === routine.id).name, 'Meeting prep');
  const timeConfig = { schema_version: 1, slots: [{ days: [1], time: '09:00' }],
    title_template: 'Prep - {event} - {date}' };
  const timeSaved = database.saveRoutine({ name: 'Time brief', prompt: 'Brief', trigger_config: timeConfig });
  assert.equal(timeSaved.success, true, timeSaved.error);
  const row = database.claimRoutineRun(timeSaved.routine.id, 'time:first', 'time');
  const timeRun = await runner.run({ id: row.id, routineId: timeSaved.routine.id, trigger: 'time',
    model: { mode: 'local', provider: 'local', model: 'test' } });
  assert.equal(timeRun.status, 'done', timeRun.error);
  assert.match(timeRun.note.title, /^Time brief — \d{4}-\d\d-\d\d$/);
});
