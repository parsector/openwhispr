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
const DatabaseManager = require('../../src/helpers/database');
const enrollment = require('../../src/helpers/voiceEnrollment');

test('all voice guard thresholds carry the same uncalibrated label', () => {
  assert.deepEqual(Object.values(enrollment.calibration).map(item => item.status),
    ['uncalibrated', 'uncalibrated', 'uncalibrated', 'uncalibrated']);
});

function fixture(t) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-enroll-'));
  const db = new DatabaseManager();
  t.after(() => { db.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const person = db.createNamedSpeakerProfile('Alex');
  const wav = Buffer.alloc(44 + 24000 * 2 * 4);
  let reviewClock = Date.now();
  wav.write('RIFF');
  for (let i = 0; i < 24000 * 4; i++) wav.writeInt16LE(Math.round(10000 * Math.sin(i / 24)), 44 + i * 2);
  const audio = { now: () => reviewClock, status: () => ({ state: 'complete' }), span: () => ({ state: 'available',
    wav, partial: false }) };
  const vector = (x, y = 0) => Float32Array.from({ length: 512 }, (_, i) => i === 0 ? x : i === 1 ? y : 0);
  const extractor = { extractEmbeddingFromSamples: async () => vector(1) };
  const note = (suffix, count = 1) => {
    const saved = db.saveNote(`Meeting ${suffix}`, '', 'meeting');
    const noteId = (saved.note || saved).id;
    const rows = Array.from({ length: count }, (_, i) => ({ id: `${suffix}-${i}`, speaker: 'speaker_0',
      speakerName: 'Alex', speakerLockSource: 'user', suggestedProfileId: person.id,
      audioSpan: { recordingId: noteId, trackId: 'mic', startSample: i * 24000 * 5,
        endSample: (i * 5 + 4) * 24000 } }));
    db.updateNote(noteId, { transcript: JSON.stringify({ version: 2, rows }) });
    return { noteId, rows };
  };
  const completeReview = (candidateId, token, store = audio) => {
    reviewClock += 5000;
    store.now = audio.now;
    assert.equal(enrollment.complete(db, store, candidateId, token).success, true);
  };
  return { db, person, audio, extractor, vector, note, completeReview };
}

test('fresh identity stays unenrolled; approval needs playback; rejection is durable', async t => {
  const f = fixture(t);
  const { noteId } = f.note('one');
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 0);
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  assert.equal(candidate.noteId, noteId);
  assert.deepEqual(candidate.rowIds, ['one-0']);
  assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', null)).success, false);
  const played = enrollment.play(f.db, f.audio, candidate.id);
  assert.equal(played.state, 'available');
  f.completeReview(candidate.id, played.token);
  assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'reject', played.token)).success, true);
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);
});

test('first naming is eligible for review but a later correction is not', t => {
  const f = fixture(t);
  const { noteId } = f.note('first-name');
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  Object.assign(doc.rows[0], { speakerName: undefined, suggestedProfileId: undefined,
    speakerLockSource: undefined, speakerIsPlaceholder: true });
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  const { applySpeakerCorrection } = require('../../src/helpers/speakerCorrectionTransaction');
  assert.equal(applySpeakerCorrection(f.db, null, { type: 'apply', noteId, id: 'initial',
    scope: 'row', rowIds: ['first-name-0'], name: 'Alex', profileId: f.person.id }).success, true);
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 1);
  assert.equal(applySpeakerCorrection(f.db, null, { type: 'apply', noteId, id: 'later',
    scope: 'row', rowIds: ['first-name-0'], name: 'Sam' }).success, true);
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);
});

test('approval requires server-observed playback completion for the same candidate revision', async t => {
  const f = fixture(t);
  const { noteId } = f.note('playback');
  let clock = 1_700_000_000_000;
  f.audio.now = () => clock;
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  const { token } = enrollment.play(f.db, f.audio, candidate.id);
  assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, false);
  assert.equal(enrollment.complete(f.db, f.audio, candidate.id, token).success, false);
  clock += 4000;
  assert.equal(enrollment.complete(f.db, f.audio, candidate.id, token).success, true);
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  doc.rows[0].speakerName = 'Changed after playback';
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, false);
});

test('two meetings and three clean spans graduate; a correction demotes', async t => {
  const f = fixture(t);
  f.note('one', 2); f.note('two');
  const candidates = enrollment.listCandidates(f.db, f.audio, f.person.id);
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, true);
  }
  assert.equal(enrollment.progress(f.db, f.person.id).usable, true);
  assert.equal(f.db.getSpeakerProfiles(true).length, 1);
  const { applySpeakerCorrection } = require('../../src/helpers/speakerCorrectionTransaction');
  const note = f.db.db.prepare("SELECT id FROM notes WHERE title = 'Meeting one'").get().id;
  assert.equal(applySpeakerCorrection(f.db, null, { type: 'apply', noteId: note, id: 'fix-one',
    scope: 'row', rowIds: ['one-0'], name: 'Bob' }).success, true);
  assert.equal(enrollment.progress(f.db, f.person.id).usable, false);
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
});

test('cloud label adoption demotes a profile backed by changed rows', async t => {
  const f = fixture(t);
  f.note('adopt-one', 2); f.note('adopt-two');
  for (const candidate of enrollment.listCandidates(f.db, f.audio, f.person.id)) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, true);
  }
  assert.equal(enrollment.progress(f.db, f.person.id).usable, true);
  const noteId = f.db.db.prepare("SELECT id FROM notes WHERE title = 'Meeting adopt-one'").get().id;
  const cloud = JSON.parse(f.db.getNote(noteId).transcript);
  cloud.rows[0].speakerName = 'Cloud name';
  f.db.db.prepare('UPDATE notes SET cloud_transcript = ? WHERE id = ?').run(JSON.stringify(cloud), noteId);
  assert.equal(f.db.takeCloudSpeakerLabels(noteId).success, true);
  assert.equal(enrollment.progress(f.db, f.person.id).usable, false);
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
});

test('a direct transcript attribution change invalidates contributing evidence', async t => {
  const f = fixture(t);
  f.note('direct-one', 2); f.note('direct-two');
  for (const candidate of enrollment.listCandidates(f.db, f.audio, f.person.id)) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, true);
  }
  const noteId = f.db.db.prepare("SELECT id FROM notes WHERE title = 'Meeting direct-one'").get().id;
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  doc.rows[0].speakerName = 'Sam';
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
});

test('changing a contributing speaker mapping demotes the old identity', async t => {
  const f = fixture(t);
  const first = f.note('mapped-one', 2), second = f.note('mapped-two');
  for (const { noteId } of [first, second]) {
    const doc = JSON.parse(f.db.getNote(noteId).transcript);
    for (const row of doc.rows) { delete row.speakerLockSource; delete row.suggestedProfileId; }
    f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
    assert.equal(f.db.setSpeakerMapping(noteId, 'speaker_0', f.person.id, 'Alex').success, true);
  }
  for (const candidate of enrollment.listCandidates(f.db, f.audio, f.person.id)) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, true);
  }
  assert.equal(f.db.getSpeakerProfiles(true).length, 1);
  const bob = f.db.createNamedSpeakerProfile('Bob');
  assert.equal(f.db.setSpeakerMapping(first.noteId, 'speaker_0', bob.id, 'Bob').success, true);
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
});

test('two spans in one meeting stay provisional; an odd approved vector is surfaced', async t => {
  const f = fixture(t);
  f.note('one', 2);
  for (const candidate of enrollment.listCandidates(f.db, f.audio, f.person.id)) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token);
  }
  assert.equal(enrollment.progress(f.db, f.person.id).usable, false);
  assert.equal(enrollment.progress(f.db, f.person.id).meetings, 1);
  f.note('two');
  f.extractor.extractEmbeddingFromSamples = async () => f.vector(0, 1);
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  const { token } = enrollment.play(f.db, f.audio, candidate.id);
  f.completeReview(candidate.id, token);
  await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token);
  assert.equal(enrollment.progress(f.db, f.person.id).conflict, true);
  const samples = enrollment.listSamples(f.db, f.person.id);
  assert.equal(samples.find(sample => sample.noteTitle === 'Meeting two').odd, true);
  assert.equal(enrollment.progress(f.db, f.person.id).usable, false);
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
  assert.equal(enrollment.removeSample(f.db, samples.find(sample => sample.odd).id).success, true);
  assert.equal(enrollment.progress(f.db, f.person.id).conflict, false);
});

test('overlapping rows cannot count the same audio twice', async t => {
  const f = fixture(t);
  const { noteId } = f.note('same-audio', 2);
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  doc.rows[1].audioSpan.startSample = 24000;
  doc.rows[1].audioSpan.endSample = 24000 * 5;
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  const [first, second] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  assert.ok(first && second);
  const { token } = enrollment.play(f.db, f.audio, first.id);
  f.completeReview(first.id, token);
  assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, first.id, 'approve', token)).success, true);
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);
  assert.equal(enrollment.play(f.db, f.audio, second.id).state, 'unavailable');
});

test('reset and clear voice data remove approved samples; deleted audio cannot leave an offer', async t => {
  const f = fixture(t);
  f.note('one');
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  const { token } = enrollment.play(f.db, f.audio, candidate.id);
  f.completeReview(candidate.id, token);
  await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token);
  const people = require('../../src/helpers/peopleActions');
  assert.equal(people.applyPersonAction(f.db, { type: 'reset', profileId: f.person.id }).success, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 0);
  f.audio.status = () => ({ state: 'deleted', bytes: 0 });
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);
  assert.equal(people.clearVoiceData(f.db, people.previewClearVoiceData(f.db)).success, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 0);
});

test('enrolment decisions undo in the same ordered action history', async t => {
  const f = fixture(t);
  f.note('one');
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  const { token } = enrollment.play(f.db, f.audio, candidate.id);
  f.completeReview(candidate.id, token);
  const action = await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'reject', token);
  assert.equal(require('../../src/helpers/peopleActions').listPeopleActions(f.db)[0].id, action.id);
  assert.equal(enrollment.undo(f.db, action.id).success, true);
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 1);
});

test('deleting real retained audio removes approved vectors and blocks their undo', async t => {
  const f = fixture(t);
  const { noteId } = f.note('one');
  const { MeetingAudioStore, RATE } = require('../../src/helpers/meetingAudioStore');
  const store = new MeetingAudioStore(path.join(dir, 'retained-audio'), { database: f.db,
    encryption: { encryptBytes: bytes => bytes, decryptBytes: bytes => bytes } });
  const pcm = Buffer.alloc(RATE * 2 * 4);
  for (let i = 0; i < RATE * 4; i++) pcm.writeInt16LE(Math.round(10000 * Math.sin(i / 24)), i * 2);
  const startedAt = Date.now();
  store.begin(noteId, startedAt);
  store.append(noteId, 'mic', pcm, startedAt);
  store.finish(noteId);
  const transcript = JSON.parse(f.db.getNote(noteId).transcript);
  transcript.rows[0].audioSpan.recordingId = store.status(noteId).recordingId;
  f.db.updateNote(noteId, { transcript: JSON.stringify(transcript) });
  const [candidate] = enrollment.listCandidates(f.db, store, f.person.id);
  assert.ok(candidate);
  const playback = enrollment.play(f.db, store, candidate.id);
  assert.equal(playback.state, 'available', JSON.stringify({ state: playback.state, status: store.status(noteId) }));
  const { token, wav } = playback;
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  f.completeReview(candidate.id, token, store);
  const decision = await enrollment.decide(f.db, store, f.extractor, candidate.id, 'approve', token);
  assert.equal(decision.success, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 1);
  store.delete(noteId);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 0);
  assert.equal(f.db.db.prepare('SELECT length(embedding) n FROM speaker_profiles WHERE id = ?').get(f.person.id).n, 0);
  assert.equal(enrollment.listCandidates(f.db, store, f.person.id).length, 0);
  assert.equal(enrollment.undo(f.db, decision.id).success, false);
});

test('deleting source audio scrubs older clear-voice embedding snapshots', t => {
  const f = fixture(t);
  const { noteId } = f.note('snapshot');
  f.db.db.prepare('INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)')
    .run(noteId, 'speaker_0', Buffer.from([1, 2, 3, 4]));
  const people = require('../../src/helpers/peopleActions');
  const action = people.clearVoiceData(f.db, people.previewClearVoiceData(f.db));
  assert.equal(action.success, true);
  const { MeetingAudioStore } = require('../../src/helpers/meetingAudioStore');
  const store = new MeetingAudioStore(path.join(dir, 'snapshot-audio'), { database: f.db,
    encryption: { encryptBytes: bytes => bytes, decryptBytes: bytes => bytes } });
  store.begin(noteId); store.finish(noteId);
  store.delete(noteId);
  assert.equal(people.undoClearVoiceData(f.db, action.id).success, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM note_speaker_embeddings WHERE note_id = ?').get(noteId).n, 0);
});

test('fresh install can delete its first recording before any enrolment action', t => {
  const f = fixture(t);
  const { noteId } = f.note('first');
  const { MeetingAudioStore } = require('../../src/helpers/meetingAudioStore');
  const store = new MeetingAudioStore(path.join(dir, 'fresh-audio'), { database: f.db,
    encryption: { encryptBytes: bytes => bytes, decryptBytes: bytes => bytes } });
  store.begin(noteId);
  store.finish(noteId);
  assert.equal(store.delete(noteId).state, 'deleted');
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 0);
});

test('note FK deletion demotes a profile even when other approved meetings remain', async t => {
  const f = fixture(t);
  const first = f.note('one', 2), second = f.note('two');
  for (const candidate of enrollment.listCandidates(f.db, f.audio, f.person.id)) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, true);
  }
  assert.equal(f.db.getSpeakerProfiles(true).length, 1);
  f.db.db.prepare('DELETE FROM notes WHERE id = ?').run(first.noteId);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 1);
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
  assert.equal(f.db.db.prepare('SELECT voice_usable FROM speaker_profiles WHERE id = ?').get(f.person.id).voice_usable, 0);
  assert.ok(f.db.db.prepare('SELECT 1 FROM notes WHERE id = ?').get(second.noteId));
});

test('audio deletion demotes a profile even when enough other samples remain', async t => {
  const f = fixture(t);
  const first = f.note('remove-one'); f.note('keep-two', 2); f.note('keep-three');
  for (const candidate of enrollment.listCandidates(f.db, f.audio, f.person.id)) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, true);
  }
  assert.equal(f.db.getSpeakerProfiles(true).length, 1);
  assert.equal(enrollment.progress(f.db, f.person.id).approvedSpans, 4);
  enrollment.removeNoteEvidence(f.db.db, first.noteId);
  assert.equal(enrollment.progress(f.db, f.person.id).approvedSpans, 3);
  assert.equal(enrollment.progress(f.db, f.person.id).meetings, 2);
  assert.equal(f.db.db.prepare('SELECT voice_usable FROM speaker_profiles WHERE id = ?').get(f.person.id).voice_usable, 0);
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
});

test('hard note deletion scrubs enrollment actions and saved vectors', async t => {
  const f = fixture(t);
  const { noteId } = f.note('gone');
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  const { token } = enrollment.play(f.db, f.audio, candidate.id);
  f.completeReview(candidate.id, token);
  await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token);
  assert.equal(f.db.hardDeleteNote(noteId).success, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 0);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_enrollment_actions').get().n, 0);
  assert.equal(f.db.db.prepare('SELECT length(embedding) n FROM speaker_profiles WHERE id = ?').get(f.person.id).n, 0);
});

test('merging two approved voices preserves samples and flags the mixed profile', async t => {
  const f = fixture(t);
  f.note('one', 2); f.note('two');
  for (const candidate of enrollment.listCandidates(f.db, f.audio, f.person.id)) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token);
  }
  const bob = f.db.createNamedSpeakerProfile('Bob');
  const { noteId } = f.note('bob');
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  doc.rows[0].suggestedProfileId = bob.id;
  doc.rows[0].speakerName = 'Bob';
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  f.extractor.extractEmbeddingFromSamples = async () => f.vector(0, 1);
  const [candidate] = enrollment.listCandidates(f.db, f.audio, bob.id);
  const { token } = enrollment.play(f.db, f.audio, candidate.id);
  f.completeReview(candidate.id, token);
  await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token);
  const people = require('../../src/helpers/peopleActions');
  const merged = people.applyPersonAction(f.db, { type: 'merge', profileId: bob.id, survivorId: f.person.id });
  assert.equal(merged.success, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 4);
  assert.equal(enrollment.progress(f.db, f.person.id).conflict, true);
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
  assert.equal(people.undoPersonAction(f.db, merged.id).success, true);
  assert.equal(enrollment.progress(f.db, f.person.id).conflict, false);
  assert.equal(enrollment.listSamples(f.db, bob.id).length, 1);
});

test('merge and reset retain rejected candidate tombstones', async t => {
  const f = fixture(t);
  f.note('rejected');
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  const { token } = enrollment.play(f.db, f.audio, candidate.id);
  f.completeReview(candidate.id, token);
  assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'reject', token)).success, true);
  const survivor = f.db.createNamedSpeakerProfile('Bob');
  const people = require('../../src/helpers/peopleActions');
  assert.equal(people.applyPersonAction(f.db, { type: 'merge', profileId: f.person.id,
    survivorId: survivor.id }).success, true);
  assert.equal(f.db.db.prepare('SELECT profile_id FROM voice_enrollment_candidates WHERE id = ?').get(candidate.id)?.profile_id, survivor.id);
  assert.equal(people.applyPersonAction(f.db, { type: 'reset', profileId: survivor.id }).success, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_enrollment_candidates WHERE id = ?').get(candidate.id).n, 1);
});

test('merge does not reoffer transferred spans or restore a deleted survivor voice on undo', async t => {
  const f = fixture(t);
  const source = f.note('source');
  const survivor = f.db.createNamedSpeakerProfile('Bob');
  const target = f.note('survivor');
  const doc = JSON.parse(f.db.getNote(target.noteId).transcript);
  doc.rows[0].suggestedProfileId = survivor.id;
  f.db.updateNote(target.noteId, { transcript: JSON.stringify(doc) });
  for (const profileId of [f.person.id, survivor.id]) {
    const [candidate] = enrollment.listCandidates(f.db, f.audio, profileId);
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, true);
  }
  const people = require('../../src/helpers/peopleActions');
  const merged = people.applyPersonAction(f.db, { type: 'merge', profileId: f.person.id, survivorId: survivor.id });
  assert.equal(merged.success, true);
  assert.equal(enrollment.listCandidates(f.db, f.audio, survivor.id).length, 0);
  enrollment.removeNoteEvidence(f.db.db, target.noteId);
  assert.equal(people.undoPersonAction(f.db, merged.id).success, true);
  const survivorProfile = f.db.db.prepare('SELECT length(embedding) n, sample_count FROM speaker_profiles WHERE id = ?').get(survivor.id);
  assert.equal(survivorProfile.n, 0);
  assert.equal(survivorProfile.sample_count, 0);
  assert.equal(enrollment.listSamples(f.db, survivor.id).length, 0);
  assert.ok(f.db.db.prepare('SELECT id FROM notes WHERE id = ?').get(source.noteId));
});

test('renaming a person keeps approved acoustic provenance clean', async t => {
  const f = fixture(t);
  f.note('one', 2); f.note('two');
  for (const candidate of enrollment.listCandidates(f.db, f.audio, f.person.id)) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token);
  }
  const people = require('../../src/helpers/peopleActions');
  assert.equal(people.applyPersonAction(f.db, { type: 'rename', profileId: f.person.id, name: 'Alex Rivera' }).success, true);
  assert.equal(enrollment.progress(f.db, f.person.id).usable, true);
  assert.equal(f.db.getSpeakerProfiles(true).length, 1);
});

test('overlapping speech is not offered and clipped audio cannot be approved', async t => {
  const f = fixture(t);
  const { noteId } = f.note('quality');
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  doc.rows[0].uncertainty = { reason: 'overlapping_speech' };
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);
  delete doc.rows[0].uncertainty;
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  const clipped = Buffer.alloc(44 + 24000 * 2 * 4);
  clipped.write('RIFF');
  for (let i = 0; i < 24000 * 4; i++) clipped.writeInt16LE(32767, 44 + i * 2);
  f.audio.span = () => ({ state: 'available', wav: clipped, partial: false });
  const { token } = enrollment.play(f.db, f.audio, candidate.id);
  f.completeReview(candidate.id, token);
  const decision = await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token);
  assert.equal(decision.success, false);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 0);
});
