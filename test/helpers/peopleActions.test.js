const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
let dir;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => dir, getAppPath: () => process.cwd(), isReady: () => false } };
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = 'test';
const DatabaseManager = require('../../src/helpers/database.js');
const { skipOrFail } = require('./harness/db.js');
const { listPeople, listReviewRows, previewPersonAction, applyPersonAction, undoPersonAction } = require('../../src/helpers/peopleActions');
const { readTranscriptDocument } = require('../../src/helpers/transcriptDocument');
const { readSpeakerActionLog } = require('../../src/helpers/speakerActionLog');
function fixture(t) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhispr-people-'));
  let db;
  try { db = new DatabaseManager(); } catch (error) { skipOrFail(t, error); return null; }
  t.after(() => { db.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const person = (name, byte) => db.upsertSpeakerProfile(name, null, Buffer.alloc(2048, byte));
  const note = (title, rows, mappings) => {
    const saved = db.saveNote(title, '', 'meeting');
    const id = (saved.note || saved).id;
    db.updateNote(id, { transcript: JSON.stringify({ version: 2, unknownNumberHighWater: 2, rows }) });
    for (const [speaker, profile] of mappings) db.db.prepare('INSERT INTO speaker_mappings (note_id, speaker_id, profile_id, display_name) VALUES (?, ?, ?, ?)').run(id, speaker, profile.id, profile.display_name);
    return id;
  };
  const rows = (id) => readTranscriptDocument(db.getNote(id).transcript).rows;
  return { db, person, note, rows };
}
test('people list counts notes and segments and flags near duplicates and used once', t => {
  const f = fixture(t); if (!f) return;
  const alex = f.person('Alexandra', 1), typo = f.person('Alexndra', 2);
  f.note('one', [{ id: 'a', speaker: 'speaker_0', speakerName: 'Alexandra' }, { id: 'b', speaker: 'speaker_0', speakerName: 'Alexandra' }], [['speaker_0', alex]]);
  f.note('two', [{ id: 'c', speaker: 'speaker_1', speakerName: 'Alexndra' }], [['speaker_1', typo]]);
  const people = listPeople(f.db);
  assert.equal(people.find(p => p.id === alex.id).segmentCount, 2);
  assert.equal(people.find(p => p.id === typo.id).noteCount, 1);
  assert.equal(people.find(p => p.id === typo.id).usedOnce, true);
  assert.ok(people.find(p => p.id === typo.id).duplicates.some(d => d.id === alex.id));
  assert.equal(people.find(p => p.id === alex.id).legacyVoice, true);
});
test('rename changes labels across notes, keeps locks, and undo restores labels', t => {
  const f = fixture(t); if (!f) return;
  const alex = f.person('Alec', 1);
  const first = f.note('one', [{ id: 'a', speaker: 'speaker_0', speakerName: 'Alec', speakerLocked: true, speakerLockSource: 'user' }], [['speaker_0', alex]]);
  const second = f.note('two', [{ id: 'b', speaker: 'speaker_1', speakerName: 'Alec' }], [['speaker_1', alex]]);
  const request = { type: 'rename', profileId: alex.id, name: 'Alex' };
  assert.deepEqual([previewPersonAction(f.db, request).noteCount, previewPersonAction(f.db, request).segmentCount], [2, 2]);
  const result = applyPersonAction(f.db, request);
  assert.equal(result.success, true);
  assert.equal(f.rows(first)[0].speakerName, 'Alex');
  assert.equal(f.rows(first)[0].speakerLocked, true);
  assert.equal(f.rows(second)[0].speakerName, 'Alex');
  assert.equal(undoPersonAction(f.db, result.id).success, true);
  assert.equal(f.rows(first)[0].speakerName, 'Alec');
  assert.equal(f.rows(second)[0].speakerName, 'Alec');
});
test('merge preserves survivor embedding, rewrites pinned rows, and restores loser on undo', t => {
  const f = fixture(t); if (!f) return;
  const loser = f.person('Alexndra', 2), winner = f.person('Alexandra', 1);
  const note = f.note('one', [{ id: 'a', speaker: 'speaker_0', speakerName: 'Alexndra', speakerLocked: true, speakerLockSource: 'user' }, { id: 'b', speaker: 'speaker_0', speakerName: 'Alexndra' }], [['speaker_0', loser]]);
  const request = { type: 'merge', profileId: loser.id, survivorId: winner.id };
  assert.deepEqual([previewPersonAction(f.db, request).noteCount, previewPersonAction(f.db, request).segmentCount, previewPersonAction(f.db, request).pinnedCount], [1, 2, 1]);
  const original = Buffer.from(f.db.db.prepare('SELECT embedding FROM speaker_profiles WHERE id = ?').get(winner.id).embedding);
  const result = applyPersonAction(f.db, request);
  assert.equal(result.success, true);
  assert.deepEqual(f.db.db.prepare('SELECT embedding FROM speaker_profiles WHERE id = ?').get(winner.id).embedding, original);
  assert.equal(f.db.db.prepare('SELECT id FROM speaker_profiles WHERE id = ?').get(loser.id), undefined);
  assert.equal(f.rows(note)[0].speakerName, 'Alexandra');
  assert.equal(f.db.db.prepare('SELECT profile_id FROM speaker_mappings WHERE note_id = ?').get(note).profile_id, winner.id);
  assert.equal(undoPersonAction(f.db, result.id).success, true);
  assert.equal(f.rows(note)[0].speakerName, 'Alexndra');
  assert.ok(f.db.db.prepare('SELECT id FROM speaker_profiles WHERE id = ?').get(loser.id));
});
test('delete allocates new unknown numbers and undo restores the person', t => {
  const f = fixture(t); if (!f) return;
  const person = f.person('Wrong', 3);
  const note = f.note('one', [{ id: 'a', speaker: 'speaker_0', speakerName: 'Wrong' }, { id: 'b', speaker: 'speaker_1', speakerName: 'Unknown speaker 2', speakerIsPlaceholder: true, unknownNumber: 2 }], [['speaker_0', person]]);
  const priorHighWater = readTranscriptDocument(f.db.getNote(note).transcript).unknownNumberHighWater;
  const result = applyPersonAction(f.db, { type: 'delete', profileId: person.id });
  assert.equal(result.success, true);
  assert.equal(f.rows(note)[0].speakerName, undefined);
  assert.equal(f.rows(note)[0].unknownNumber, priorHighWater + 1);
  assert.equal(undoPersonAction(f.db, result.id).success, true);
  assert.equal(f.rows(note)[0].speakerName, 'Wrong');
});
test('reset voice removes embedding and samples but keeps name and labels', t => {
  const f = fixture(t); if (!f) return;
  const person = f.person('Alex', 1);
  const note = f.note('one', [{ id: 'a', speaker: 'speaker_0', speakerName: 'Alex' }], [['speaker_0', person]]);
  const result = applyPersonAction(f.db, { type: 'reset', profileId: person.id });
  assert.equal(result.success, true);
  const saved = f.db.db.prepare('SELECT * FROM speaker_profiles WHERE id = ?').get(person.id);
  assert.equal(saved.embedding.length, 0); assert.equal(saved.sample_count, 0);
  assert.equal(listPeople(f.db).find(p => p.id === person.id).hasVoice, false);
  assert.equal(f.rows(note)[0].speakerName, 'Alex');
  assert.equal(undoPersonAction(f.db, result.id).success, true);
  assert.equal(f.db.db.prepare('SELECT sample_count FROM speaker_profiles WHERE id = ?').get(person.id).sample_count, 1);
});
test('person actions share ordered note history with an in-note correction', t => {
  const f = fixture(t); if (!f) return;
  const person = f.person('Alec', 1);
  const note = f.note('one', [{ id: 'a', text: 'hello', source: 'system', speaker: 'speaker_0', diarizationRunId: 'run1', speakerName: 'Alec' }], [['speaker_0', person]]);
  const identifier = { activeRunId: 'run1', transientDisplayNames: new Map(), transientProfileIds: new Map(), mapSpeaker() {}, unmapSpeaker() {} };
  const { applySpeakerCorrection } = require('../../src/helpers/speakerCorrectionTransaction');
  assert.equal(applySpeakerCorrection(f.db, identifier, { type: 'apply', noteId: note, id: 'correction-1', scope: 'row', rowIds: ['a'], name: 'Alec', profileId: person.id }).success, true);
  const renamed = applyPersonAction(f.db, { type: 'rename', profileId: person.id, name: 'Alex' });
  assert.equal(renamed.success, true);
  assert.deepEqual(readSpeakerActionLog(f.db.getNote(note)).actions.map(a => a.kind), ['correction', 'person']);
  assert.equal(applySpeakerCorrection(f.db, identifier, { type: 'undo', noteId: note, id: 'correction-1' }).error, 'later_change');
  assert.equal(undoPersonAction(f.db, renamed.id).success, true);
  assert.equal(applySpeakerCorrection(f.db, identifier, { type: 'undo', noteId: note, id: 'correction-1' }).success, true);
  assert.deepEqual(readSpeakerActionLog(f.db.getNote(note)).actions, []);
});
test('changed preview does not apply a wider action', t => {
  const f = fixture(t); if (!f) return;
  const person = f.person('Alec', 1);
  const one = f.note('one', [{ id: 'a', speaker: 'speaker_0', speakerName: 'Alec' }], [['speaker_0', person]]);
  const request = { type: 'rename', profileId: person.id, name: 'Alex' };
  const expected = previewPersonAction(f.db, request);
  f.note('two', [{ id: 'b', speaker: 'speaker_1', speakerName: 'Alec' }], [['speaker_1', person]]);
  const result = applyPersonAction(f.db, { ...request, expected });
  assert.equal(result.error, 'preview_changed');
  assert.equal(f.rows(one)[0].speakerName, 'Alec');
});
test('naming a new speaker creates a person without voice training', t => {
  const f = fixture(t); if (!f) return;
  const note = f.note('one', [{ id: 'a', text: 'hello', source: 'system', speaker: 'speaker_0', diarizationRunId: 'run1' }], []);
  const { applySpeakerCorrection } = require('../../src/helpers/speakerCorrectionTransaction');
  const result = applySpeakerCorrection(f.db, null, { type: 'apply', noteId: note, id: 'new-name', scope: 'row', rowIds: ['a'], name: 'Maya', email: 'maya@example.com' });
  assert.equal(result.success, true);
  const person = listPeople(f.db).find(p => p.displayName === 'Maya');
  assert.ok(person);
  assert.equal(person.hasVoice, false);
  assert.equal(person.email, 'maya@example.com');
  assert.equal(person.noteCount, 1);
  assert.equal(applySpeakerCorrection(f.db, null, { type: 'undo', noteId: note, id: 'new-name' }).success, true);
  assert.equal(listPeople(f.db).some(p => p.displayName === 'Maya'), false);
});
test('rename, merge, delete, and reset log in order around a note correction and undo in reverse', t => {
  const f = fixture(t); if (!f) return;
  const a = f.person('Alec', 1), b = f.person('Typo', 2), c = f.person('Bad', 3), d = f.person('Voice', 4);
  const note = f.note('one', [
    { id: 'a', text: 'a', source: 'system', speaker: 'speaker_0', diarizationRunId: 'run1', speakerName: 'Alec' },
    { id: 'b', text: 'b', source: 'system', speaker: 'speaker_1', diarizationRunId: 'run1', speakerName: 'Typo' },
    { id: 'c', text: 'c', source: 'system', speaker: 'speaker_2', diarizationRunId: 'run1', speakerName: 'Bad' },
    { id: 'd', text: 'd', source: 'system', speaker: 'speaker_3', diarizationRunId: 'run1', speakerName: 'Voice' },
  ], [['speaker_0', a], ['speaker_1', b], ['speaker_2', c], ['speaker_3', d]]);
  const { applySpeakerCorrection } = require('../../src/helpers/speakerCorrectionTransaction');
  assert.equal(applySpeakerCorrection(f.db, null, { type: 'apply', noteId: note, id: 'row-fix', scope: 'row', rowIds: ['a'], name: 'Alec', profileId: a.id }).success, true);
  const actions = [
    { type: 'rename', profileId: a.id, name: 'Alex' },
    { type: 'merge', profileId: b.id, survivorId: a.id },
    { type: 'delete', profileId: c.id },
    { type: 'reset', profileId: d.id },
  ].map(request => applyPersonAction(f.db, request));
  assert.ok(actions.every(action => action.success));
  assert.deepEqual(readSpeakerActionLog(f.db.getNote(note)).actions.map(action => action.kind), ['correction', 'person', 'person', 'person', 'person']);
  for (const action of actions.reverse()) assert.equal(undoPersonAction(f.db, action.id).success, true);
  assert.deepEqual(f.rows(note).map(row => row.speakerName), ['Alec', 'Typo', 'Bad', 'Voice']);
  assert.equal(applySpeakerCorrection(f.db, null, { type: 'undo', noteId: note, id: 'row-fix' }).success, true);
  assert.deepEqual(readSpeakerActionLog(f.db.getNote(note)).actions, []);
});
test('cross-note review defaults to flagged rows and a person filter finds all their rows', t => {
  const f = fixture(t); if (!f) return;
  const person = f.person('Alex', 1);
  const note = f.note('one', [
    { id: 'a', text: 'uncertain', speaker: 'speaker_0', speakerName: 'Alex', uncertainty: { reason: 'close_match', candidates: ['Alex', 'Sam'] } },
    { id: 'b', text: 'known', speaker: 'speaker_0', speakerName: 'Alex', speakerAssessmentAvailable: true },
  ], [['speaker_0', person]]);
  assert.deepEqual(listReviewRows(f.db).map(row => row.rowId), ['a']);
  const owned = listReviewRows(f.db, person.id);
  assert.deepEqual(owned.map(row => row.rowId), ['a', 'b']);
  assert.deepEqual(owned[0].candidates, ['Alex', 'Sam']);
  assert.equal(owned[0].noteId, note);
});
test('a soft-deleted note is rewritten and logged so restoring it cannot revive a discarded name', t => {
  const f = fixture(t); if (!f) return;
  const person = f.person('Mistyped', 1);
  const active = f.note('active', [{ id: 'a', speaker: 'speaker_0', speakerName: 'Mistyped' }], [['speaker_0', person]]);
  const deleted = f.note('deleted', [{ id: 'b', speaker: 'speaker_1', speakerName: 'Mistyped' }], [['speaker_1', person]]);
  f.db.db.prepare('UPDATE notes SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(deleted);
  const result = applyPersonAction(f.db, { type: 'rename', profileId: person.id, name: 'Correct' });
  assert.equal(result.noteCount, 2);
  assert.equal(f.rows(active)[0].speakerName, 'Correct');
  assert.equal(f.rows(deleted)[0].speakerName, 'Correct');
  assert.equal(readSpeakerActionLog(f.db.getNote(deleted)).actions.at(-1).kind, 'person');
  assert.equal(undoPersonAction(f.db, result.id).success, true);
  assert.equal(f.rows(deleted)[0].speakerName, 'Mistyped');
});
