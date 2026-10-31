const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let dir;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => dir, getAppPath: () => process.cwd(), isReady: () => false } };
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = 'test';
const Database = require('../../src/helpers/database');
const enrollment = require('../../src/helpers/voiceEnrollment');
const { LiveSpeakerIdentifier } = require('../../src/helpers/liveSpeakerIdentifier');
const { reconsiderLiveClusters, undoReconsideration } = require('../../src/helpers/liveSpeakerReconsideration');
const { applySpeakerCorrection } = require('../../src/helpers/speakerCorrectionTransaction');
const { reconcileAutomaticTranscript } = require('../../src/helpers/transcriptDocument');
Module._load = originalLoad;

const vector = (x, y = 0) => Float32Array.from({ length: 512 }, (_, i) => i === 0 ? x : i === 1 ? y : 0);
function fixture(t) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-reconsider-'));
  const ownDir = dir;
  const db = new Database();
  t.after(() => { db.db.close(); fs.rmSync(ownDir, { recursive: true, force: true }); });
  const person = db.createNamedSpeakerProfile('Alex');
  const wav = Buffer.alloc(44 + 24000 * 2 * 4);
  wav.write('RIFF');
  for (let i = 0; i < 24000 * 4; i++) wav.writeInt16LE(Math.round(10000 * Math.sin(i / 24)), 44 + i * 2);
  let clock = Date.now();
  const audio = { now: () => clock, status: () => ({ state: 'complete', bytes: wav.length }),
    span: () => ({ state: 'available', wav, partial: false }) };
  const extractor = { extractEmbeddingFromSamples: async () => vector(1) };
  for (const [title, count] of [['Earlier one', 2], ['Earlier two', 1]]) {
    const id = db.saveNote(title, '', 'meeting').note.id;
    const rows = Array.from({ length: count }, (_, i) => ({ id: `${title}-${i}`, source: 'system',
      speaker: 'speaker_0', speakerName: 'Alex', speakerLockSource: 'user', suggestedProfileId: person.id,
      audioSpan: { recordingId: id, trackId: 'system', startSample: i * 120000, endSample: i * 120000 + 96000 } }));
    db.updateNote(id, { transcript: JSON.stringify({ version: 2, rows }) });
  }
  const noteId = db.saveNote('Live', '', 'meeting').note.id;
  const runId = 'run-live';
  const row = { id: 'live-row', text: 'Hello', source: 'system', diarizationRunId: runId,
    speaker: 'speaker_3', speakerIsPlaceholder: true, speakerStatus: 'suggested',
    audioSpan: { recordingId: noteId, trackId: 'system', startSample: 0, endSample: 96000 } };
  db.updateNote(noteId, { transcript: JSON.stringify({ version: 2, rows: [row] }) });
  const identifier = new LiveSpeakerIdentifier();
  identifier.running = true;
  identifier.activeRunId = runId;
  identifier.nextLiveIndex = 3;
  identifier.getSpeakerProfiles = () => db.getSpeakerProfiles(true);
  identifier._resolveSpeakerForEmbedding(vector(1), { updateCentroid: true, voicedSamples: 16000 * 4 });
  identifier._resolveSpeakerForEmbedding(vector(1), { updateCentroid: true, voicedSamples: 16000 * 4 });
  const graduate = async () => {
    for (const candidate of enrollment.listCandidates(db, audio, person.id)) {
      const { token } = enrollment.play(db, audio, candidate.id);
      clock += 5000;
      assert.equal(enrollment.complete(db, audio, candidate.id, token).success, true);
      assert.equal((await enrollment.decide(db, audio, extractor, candidate.id, 'approve', token)).success, true);
    }
  };
  return { db, person, noteId, runId, row, identifier, graduate };
}

test('speaker_3 gains an approved voice in the current meeting without changing its centroid', async t => {
  const f = fixture(t);
  assert.equal(f.identifier._resolveSpeakerForEmbedding(vector(1)).displayName, null);
  await f.graduate();
  const before = f.db.db.prepare('SELECT embedding, sample_count, voice_usable FROM speaker_profiles WHERE id = ?').get(f.person.id);
  const staleTranscript = f.db.getNote(f.noteId).transcript;
  const centroid = f.identifier.getSpeakerEmbedding('speaker_3');
  const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId);
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].speakerId, 'speaker_3');
  assert.equal(result.assignments[0].displayName, 'Alex');
  assert.equal(JSON.parse(f.db.getNote(f.noteId).transcript).rows[0].speakerName, 'Alex');
  assert.equal(JSON.parse(f.db.getNote(f.noteId).transcript).rows[0].machineReason, 'approved_voice');
  assert.deepEqual(f.identifier.getSpeakerEmbedding('speaker_3'), centroid);
  assert.deepEqual(f.db.db.prepare('SELECT embedding, sample_count, voice_usable FROM speaker_profiles WHERE id = ?').get(f.person.id), before);
  assert.equal(enrollment.listCandidates(f.db, {
    status: () => ({ state: 'complete', bytes: 96044 }), span: () => ({ state: 'available' }),
  }, f.person.id).some(candidate => candidate.noteId === f.noteId), false);
  const reconciled = reconcileAutomaticTranscript(staleTranscript, f.db.getNote(f.noteId).transcript);
  assert.equal(JSON.parse(reconciled).rows[0].machineReason, 'approved_voice');
  assert.equal(undoReconsideration(f.db, f.identifier, f.noteId, result.assignments[0].actionId).success, true);
  assert.equal(JSON.parse(f.db.getNote(f.noteId).transcript).rows[0].speakerName, undefined);
  assert.deepEqual(reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId).skipped,
    [{ speakerId: 'speaker_3', reason: 'owner-rejected' }]);
});

test('a live row not yet saved is reconciled and logged at graduation', async t => {
  const f = fixture(t);
  f.db.updateNote(f.noteId, { transcript: '[]' });
  await f.graduate();
  const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId, [f.row]);
  assert.equal(result.assignments.length, 1);
  assert.equal(JSON.parse(f.db.getNote(f.noteId).transcript).rows[0].speakerName, 'Alex');
  assert.equal(JSON.parse(f.db.getNote(f.noteId).speaker_action_log).actions.at(-1).kind, 'reconsideration');
  const reconciled = reconcileAutomaticTranscript('[]', f.db.getNote(f.noteId).transcript);
  assert.equal(JSON.parse(reconciled).rows[0].machineReason, 'approved_voice');
});

test('explicit Unknown, locked, overlap and mixed audio have distinct eligibility states', async t => {
  const cases = [
    [{ speakerLockSource: 'user', speakerLocked: true, speakerName: undefined }, 'explicit-unknown'],
    [{ speakerLocked: true }, 'locked'],
    [{ uncertainty: { reason: 'overlapping_speech' } }, 'uncertain-overlap'],
    [{ uncertainty: { reason: 'possible_mixed_speakers' } }, 'mixed-audio'],
    [{ suggestedName: 'Alex' }, 'provisional-suggestion'],
    [{ uncertainty: { reason: 'too_short' } }, 'insufficient-evidence'],
  ];
  for (const [patch, reason] of cases) await t.test(reason, async sub => {
    const f = fixture(sub);
    await f.graduate();
    f.db.updateNote(f.noteId, { transcript: JSON.stringify({ version: 2, rows: [{ ...f.row, ...patch }] }) });
    const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId);
    assert.deepEqual(result.skipped, [{ speakerId: 'speaker_3', reason }]);
    assert.equal(f.identifier.getEligibilityState('speaker_3'), reason);
    assert.equal(JSON.parse(f.db.getNote(f.noteId).transcript).rows[0].speakerName, undefined);
  });
});

test('a close runner-up leaves the row uncertain and never names it', async t => {
  const f = fixture(t);
  await f.graduate();
  f.identifier._assignSpeakerId(vector(0.995, 0.1));
  const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId);
  assert.deepEqual(result.assignments, []);
  assert.deepEqual(result.skipped.find(item => item.speakerId === 'speaker_3'),
    { speakerId: 'speaker_3', reason: 'close_match' });
  const row = JSON.parse(f.db.getNote(f.noteId).transcript).rows[0];
  assert.equal(row.speakerName, undefined);
  assert.equal(row.uncertainty.reason, 'close_match');
});

test('an owner correction on the cluster wins over a later graduation', async t => {
  const f = fixture(t);
  const corrected = applySpeakerCorrection(f.db, f.identifier, { type: 'apply', noteId: f.noteId,
    id: 'owner-correction', scope: 'cluster', target: { runId: f.runId, clusterId: 'speaker_3' },
    rowIds: ['live-row'], name: 'Sam' });
  assert.equal(corrected.success, true);
  await f.graduate();
  const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId);
  assert.deepEqual(result.skipped, [{ speakerId: 'speaker_3', reason: 'confirmed-by-owner' }]);
  assert.equal(JSON.parse(f.db.getNote(f.noteId).transcript).rows[0].speakerName, 'Sam');
});
