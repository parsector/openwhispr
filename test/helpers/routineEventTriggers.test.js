const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { RoutineScheduler } = require('../../src/helpers/routines/routineScheduler');
const { RoutineQueue } = require('../../src/helpers/routines/routineQueue');
const { matchesBeforeEvent, matchesMeetingEnded, meetingEndedPreview } = require('../../src/helpers/routines/routineEventTriggers');
const { PRESETS } = require('../../src/helpers/routines/routinePresets');

const before = { schema_version: 1, minutes_before: 10, title_pattern: '', has_attendees: false, has_meeting_link: false, skip_declined: true };
const ended = { schema_version: 1, folder_ids: [7], title_pattern: 'Planning' };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(config = before, type = 'before_event', meetingWaitMs = 90000) {
  const routine = { id: 'r1', trigger_type: type, trigger_config: config, catch_up_window_hours: 4, paused: 0 };
  const event = { id: 'e1', summary: 'Planning', start_time: new Date(Date.now() + 11 * 60000).toISOString(),
    end_time: new Date(Date.now() + 71 * 60000).toISOString(), status: 'confirmed', is_all_day: 0,
    attendees_count: 2, self_response_status: 'accepted' };
  const rows = new Map();
  const calls = [];
  const database = {
    db: { prepare: (sql) => ({
      get: (...args) => sql.includes('calendar_events') ? event : rows.get(sql.includes('routine_id=?') ? args[1] : args[0]),
      run: () => {},
    }) },
    listRoutines: () => [routine], getRoutine: () => routine,
    getCalendarEventsInRange: () => event.status === 'cancelled' ? [] : [event],
    getNote: () => ({ id: 42, folder_id: 7, title: 'Planning', calendar_event_id: null }),
    claimRoutineRun: (_routineId, slotKey, trigger, id) => {
      if (!rows.has(slotKey)) rows.set(slotKey, { id: id || 'run', routine_id: 'r1', slot_key: slotKey, trigger, status: 'queued' });
      return rows.get(slotKey);
    },
    updateRoutineRun: (id, fields) => { for (const row of rows.values()) if (row.id === id) Object.assign(row, fields); },
  };
  const queue = new RoutineQueue({ isRecording: () => true, run: async (job) => {
    calls.push(job); database.updateRoutineRun(job.id, { status: 'done' }); return { status: 'done' };
  } });
  const scheduler = new RoutineScheduler({ database, queue, modelChoice: () => ({ mode: 'local' }), meetingWaitMs });
  return { scheduler, queue, database, routine, event, rows, calls };
}

test('before-event plans move and cancel independently of the reminder; dedupes and honors catch-up', async () => {
  const h = harness();
  h.scheduler.checkEvents();
  const first = h.scheduler.eventTimers.get('r1:event:e1');
  assert.ok(first);
  h.event.start_time = new Date(Date.now() + 21 * 60000).toISOString();
  h.scheduler.checkEvents();
  const moved = h.scheduler.eventTimers.get('r1:event:e1');
  assert.ok(moved && moved.due > first.due);
  h.event.status = 'cancelled';
  h.scheduler.checkEvents();
  assert.equal(h.scheduler.eventTimers.size, 0);
  h.event.status = 'confirmed';
  h.event.start_time = new Date(Date.now() + 9 * 60000).toISOString();
  h.scheduler.checkEvents();
  await settle();
  h.scheduler.checkEvents();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].slotKey, 'event:e1');
  assert.equal(h.calls[0].trigger, 'before_event');
  assert.equal(h.rows.get('event:e1').event_id, 'e1');
  h.scheduler.stop();

  const late = harness();
  late.event.start_time = new Date(Date.now() - 30 * 60000).toISOString();
  late.scheduler.checkEvents();
  await settle();
  assert.equal(late.calls.length, 1);
  late.scheduler.stop();
  const stale = harness();
  stale.event.start_time = new Date(Date.now() - 5 * 3600000).toISOString();
  stale.scheduler.checkEvents();
  await settle();
  assert.equal(stale.calls.length, 0);
  stale.scheduler.stop();
});

test('a moved event cancels its queued run and reopens the same slot at the new fire time', async () => {
  const h = harness();
  h.queue.isRecording = () => false;
  let release;
  h.queue.run = async (job) => {
    if (job.slotKey === 'manual:block') return new Promise((resolve) => { release = resolve; });
    h.calls.push(job);
    h.database.updateRoutineRun(job.id, { status: 'done' });
    return { status: 'done' };
  };
  const block = h.queue.enqueue({ routineId: 'r1', slotKey: 'manual:block' });
  await settle();
  h.event.start_time = new Date(Date.now() + 9 * 60000).toISOString();
  h.scheduler.checkEvents();
  assert.equal(h.queue.pending.some((job) => job.slotKey === 'event:e1'), true);
  h.event.start_time = new Date(Date.now() + 11 * 60000).toISOString();
  h.scheduler.checkEvents();
  await settle();
  assert.equal(h.queue.pending.some((job) => job.slotKey === 'event:e1'), false);
  assert.equal(h.rows.get('event:e1').status, 'skipped');
  release({ status: 'done' });
  await block;
  await settle();
  h.event.start_time = new Date(Date.now() + 9 * 60000).toISOString();
  h.scheduler.checkEvents();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.rows.get('event:e1').status, 'done');
  h.scheduler.stop();
});

test('meeting-ended wait resolves early, records failure, and times out pending', async () => {
  const early = harness({ schema_version: 1, folder_ids: [7], title_pattern: '' }, 'meeting_ended', 30);
  early.scheduler.meetingStopped(42);
  assert.equal(early.calls.length, 0);
  early.scheduler.meetingFinalized(42, false);
  await settle();
  assert.equal(early.calls.length, 0, 'recording holds non-prep routines');
  assert.deepEqual(JSON.parse(early.rows.get('note:42').source_status), { diarization: 'failed' });
  early.queue.isRecording = () => false;
  early.queue.recordingStopped();
  await settle();
  assert.equal(early.calls[0].sourceNoteId, 42);
  early.scheduler.stop();

  const timeout = harness({ schema_version: 1, folder_ids: [7], title_pattern: '' }, 'meeting_ended', 5);
  timeout.scheduler.meetingStopped(42);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(JSON.parse(timeout.rows.get('note:42').source_status), { diarization: 'pending' });
  timeout.scheduler.stop();
});

test('preview uses the trigger matcher on the same calendar fixture', () => {
  const note = { id: 42, folder_id: 7, calendar_event_id: 'e1', deleted_at: null };
  const events = [{ id: 'e1', summary: 'Planning' }, { id: 'e2', summary: 'Review' }];
  const database = { getCalendarEventsInRange: () => events, _accountScopeCondition: () => ({ sql: '1=1', params: [] }),
    db: { prepare: () => ({ all: () => [note] }) } };
  assert.equal(matchesMeetingEnded(ended, note, events[0]), true);
  assert.equal(matchesMeetingEnded(ended, note, events[1]), false);
  assert.equal(meetingEndedPreview(database, ended), 1);
  assert.equal(matchesBeforeEvent(before, { ...events[0], status: 'cancelled' }), false);
});

test('meeting prep preset has specified defaults and source guidance', () => {
  const preset = PRESETS.find((item) => item.id === 'meeting-prep');
  assert.equal(preset.trigger_type, 'before_event');
  assert.deepEqual(preset.trigger_config, { ...before, has_attendees: true, title_template: 'Prep - {event} - {date}' });
  assert.match(preset.prompt, /agenda|history|open items/);
  assert.ok(preset.needs.length);
});

test('meeting prep context includes prior notes with event attendees', () => {
  const { eventContext } = require('../../src/helpers/routines/routineRunner');
  const database = {
    getCalendarEventById: () => ({ id: 'e1', summary: 'Planning', start_time: new Date().toISOString(),
      attendees: JSON.stringify([{ email: 'alex@example.com' }, { email: 'me@example.com', self: true }]) }),
    _accountScopeCondition: () => ({ sql: '1=1', params: [] }),
    db: { prepare: () => ({ all: () => [{ id: 7, title: 'Earlier planning', created_at: new Date().toISOString(),
      participants: JSON.stringify([{ email: 'alex@example.com' }]), content: '- [ ] Follow up with Alex',
      enhanced_content: null, folder_id: 2, routine_id: null }] }) },
  };
  const context = eventContext(database, 'e1');
  assert.match(context.text, /Earlier planning/);
  assert.match(context.text, /Follow up with Alex/);
  assert.match(context.text, /\[Note 7\]\(note:7\)/);
});

test('meeting-ended run without calendar writes only its own note and reads optional summary', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-events-'));
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
  const sourceFolder = database.createFolder('Recorded meetings').folder;
  const source = database.saveNote('Mic meeting', 'Original content', 'meeting', null, null, sourceFolder.id).note;
  database.db.prepare('UPDATE notes SET transcript=?,participants=? WHERE id=?').run('Speaker 1: Hello', '[{"displayName":"Alex"}]', source.id);
  const saved = database.saveRoutine({ name: 'Follow-up', prompt: 'Summarize the meeting', trigger_type: 'meeting_ended',
    trigger_config: { schema_version: 1, folder_ids: [source.folder_id], title_pattern: '' } });
  assert.equal(saved.success, true, saved.error);
  const prompts = [];
  const { RoutineRunner } = require('../../src/helpers/routines/routineRunner');
  const runner = new RoutineRunner({ database, infer: async ({ prompt }) => { prompts.push(prompt); return { text: 'Routine result', toolsAvailable: false }; } });
  const runOnce = async (key, diarization) => {
    const row = database.claimRoutineRun(saved.routine.id, key, 'meeting_ended');
    database.updateRoutineRun(row.id, { source_note_id: source.id });
    return runner.run({ id: row.id, routineId: saved.routine.id, trigger: 'meeting_ended', sourceNoteId: source.id,
      diarization, model: { mode: 'local', provider: 'local', model: 'test' } });
  };
  const original = database.getNote(source.id);
  const first = await runOnce('note:' + source.id, 'skipped');
  assert.equal(first.status, 'done', first.error);
  assert.match(prompts[0], /Speaker 1: Hello/);
  assert.match(prompts[0], /summary: not yet generated/);
  assert.match(prompts[0], /Attendees:.*Alex/);
  assert.match(prompts[0], /Calendar event: none/);
  assert.equal(database.getNote(source.id).content, original.content);
  assert.equal(database.getNote(source.id).transcript, original.transcript);
  assert.notEqual(first.note.folder_id, source.folder_id);
  const savedRun = database.getRoutineRuns(saved.routine.id)[0];
  assert.equal(savedRun.source_note_id, source.id);
  assert.equal(savedRun.event_id, null);
  database.db.prepare('UPDATE notes SET enhanced_content=? WHERE id=?').run('Existing summary', source.id);
  const second = await runOnce('note:second', 'ok');
  assert.equal(second.status, 'done', second.error);
  assert.match(prompts[1], /summary: Existing summary/);
  assert.equal(database.getNote(source.id).content, original.content);
  database.db.prepare('UPDATE notes SET calendar_event_id=? WHERE id=?').run('linked-event', source.id);
  database.getCalendarEventById = () => ({ id: 'linked-event', summary: 'Linked planning', start_time: new Date().toISOString() });
  const third = await runOnce('note:third', 'ok');
  assert.equal(third.status, 'done', third.error);
  assert.match(third.note.title, /^Follow-up — Linked planning — \d{4}-\d\d-\d\d$/);
  const forbidden = database.claimRoutineRun(saved.routine.id, `note:${first.note.id}`, 'meeting_ended');
  const rejected = await runner.run({ id: forbidden.id, routineId: saved.routine.id, trigger: 'meeting_ended',
    sourceNoteId: first.note.id, model: { mode: 'local', provider: 'local', model: 'test' } });
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error, /Routine notes cannot be meeting sources/);
});
