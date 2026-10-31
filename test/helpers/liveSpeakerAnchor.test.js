const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let dir;
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => dir, getAppPath: () => process.cwd(), isReady: () => false } };
  return load.call(this, request, parent, isMain);
};
process.env.NODE_ENV = 'test';
const Database = require('../../src/helpers/database');
const enrollment = require('../../src/helpers/voiceEnrollment');
const { LiveSpeakerIdentifier } = require('../../src/helpers/liveSpeakerIdentifier');
const { applySpeakerCorrection } = require('../../src/helpers/speakerCorrectionTransaction');
Module._load = load;

const vector = (x, y = 0) => Float32Array.from({ length: 512 }, (_, i) => i === 0 ? x : i === 1 ? y : 0);
const unit = (x, y) => { const n = Math.hypot(x, y); return vector(x / n, y / n); };
function fixture(t) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-live-anchor-'));
  const ownDir = dir;
  const db = new Database();
  t.after(() => { db.db.close(); fs.rmSync(ownDir, { recursive: true, force: true }); });
  const person = db.createNamedSpeakerProfile('Alex');
  const wav = Buffer.alloc(44 + 24000 * 2 * 4);
  let reviewClock = Date.now();
  wav.write('RIFF');
  for (let i = 0; i < 24000 * 4; i++) wav.writeInt16LE(Math.round(10000 * Math.sin(i / 24)), 44 + i * 2);
  const audio = { now: () => reviewClock, status: () => ({ state: 'complete' }),
    span: () => ({ state: 'available', wav, partial: false }) };
  const extractor = { extractEmbeddingFromSamples: async () => vector(1) };
  const note = (title, count) => {
    const id = db.saveNote(title, '', 'meeting').note.id;
    const rows = Array.from({ length: count }, (_, i) => ({ id: `${title}-${i}`, source: 'system', speaker: 'speaker_0',
      speakerName: 'Alex', speakerLockSource: 'user', suggestedProfileId: person.id,
      audioSpan: { recordingId: id, trackId: 'system', startSample: i * 120000, endSample: i * 120000 + 96000 } }));
    db.updateNote(id, { transcript: JSON.stringify({ version: 2, rows }) });
  };
  const liveNoteId = db.saveNote('Live', '', 'meeting').note.id;
  const identifier = new LiveSpeakerIdentifier();
  identifier.activeRunId = 'run-live';
  identifier.running = true;
  identifier.getSpeakerProfiles = () => db.getSpeakerProfiles(true);
  const anchorVoice = unit(0.8, 0.6);
  identifier._resolveSpeakerForEmbedding(anchorVoice, { updateCentroid: true, voicedSamples: 16000 * 4 });
  identifier._resolveSpeakerForEmbedding(anchorVoice, { updateCentroid: true, voicedSamples: 16000 * 4 });
  const row = { id: 'live-row', source: 'system', speaker: 'speaker_0', diarizationRunId: 'run-live',
    text: 'Live voice' };
  db.updateNote(liveNoteId, { transcript: JSON.stringify({ version: 2, rows: [row] }) });
  const name = () => applySpeakerCorrection(db, identifier, { type: 'apply', noteId: liveNoteId, id: 'name-1', scope: 'cluster',
    target: { runId: 'run-live', clusterId: 'speaker_0' }, rowIds: ['live-row'], name: 'Alex', profileId: person.id });
  const completeReview = (id, token) => {
    reviewClock += 5000;
    assert.equal(enrollment.complete(db, audio, id, token).success, true);
  };
  return { db, person, audio, extractor, note, identifier, liveNoteId, row, name, completeReview };
}

async function graduate(f) {
  f.note('Earlier one', 2); f.note('Earlier two', 1);
  for (const candidate of enrollment.listCandidates(f.db, f.audio, f.person.id)) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, true);
  }
}

test('approved voice named in a live meeting becomes a local comparison and undo removes it', async t => {
  const f = fixture(t);
  await graduate(f);
  const probe = unit(0.02, 1);
  const baseline = new LiveSpeakerIdentifier();
  baseline.getSpeakerProfiles = f.identifier.getSpeakerProfiles;
  baseline._resolveSpeakerForEmbedding(unit(0.8, 0.6), { updateCentroid: true, voicedSamples: 16000 * 4 });
  baseline.mapSpeaker('speaker_0', f.person.id, 'Alex', f.liveNoteId);
  assert.notEqual(baseline._resolveSpeakerForEmbedding(probe).displayName, 'Alex');
  const centroid = f.db.db.prepare('SELECT embedding, sample_count, voice_usable FROM speaker_profiles WHERE id = ?').get(f.person.id);
  const result = f.name();
  assert.deepEqual(result.anchor, { state: 'active', reason: null });
  const saved = f.db.getNote(f.liveNoteId);
  assert.equal(saved.transcript.includes('anchor'), false);
  assert.equal(saved.speaker_action_log.includes('anchor'), false);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars WHERE profile_id = ?').get(f.person.id).n, 3);
  assert.equal(f.identifier._resolveSpeakerForEmbedding(probe).displayName, 'Alex');
  assert.notEqual(f.identifier._resolveSpeakerForEmbedding(probe, { cohort: 'mic' }).displayName, 'Alex');
  const after = f.db.db.prepare('SELECT embedding, sample_count, voice_usable FROM speaker_profiles WHERE id = ?').get(f.person.id);
  assert.deepEqual(after, centroid);
  assert.equal(enrollment.progress(f.db, f.person.id).cleanSpans, 3);
  f.identifier.currentSegmentSpeakerId = 'speaker_0';
  f.identifier.currentSegmentSpeakerName = 'Alex';
  assert.equal(applySpeakerCorrection(f.db, f.identifier, { type: 'undo', noteId: f.liveNoteId, id: 'name-1' }).success, true);
  assert.equal(f.identifier.getAnchorState('speaker_0'), null);
  assert.equal(f.identifier.currentSegmentSpeakerName, null);
  assert.notEqual(f.identifier._resolveSpeakerForEmbedding(probe).displayName, 'Alex');
});

test('a provisional voice changes no acoustic identification and explains why', t => {
  const f = fixture(t);
  const probe = unit(0.02, 1);
  const result = f.name();
  assert.deepEqual(result.anchor, { state: 'refused', reason: 'not_graduated' });
  assert.equal(f.identifier.getAnchorState('speaker_0'), null);
  assert.notEqual(f.identifier._resolveSpeakerForEmbedding(probe).displayName, 'Alex');
});

test('an anchor abstains when a later voice has a close rival', async t => {
  const f = fixture(t);
  await graduate(f);
  assert.equal(f.name().anchor.state, 'active');
  f.identifier._assignSpeakerId(unit(0, 1));
  const result = f.identifier._resolveSpeakerForEmbedding(unit(0.4, 0.916));
  assert.equal(result.displayName, null);
  assert.equal(result.uncertainty.reason, 'close_match');
});

test('removing an approved exemplar invalidates the live anchor', async t => {
  const f = fixture(t);
  await graduate(f);
  assert.equal(f.name().anchor.state, 'active');
  const [sample] = enrollment.listSamples(f.db, f.person.id);
  assert.equal(enrollment.removeSample(f.db, sample.id).success, true);
  f.identifier.revalidateAnchors();
  assert.equal(f.identifier.getAnchorState('speaker_0'), null);
  assert.notEqual(f.identifier._resolveSpeakerForEmbedding(unit(0.02, 1)).displayName, 'Alex');
});

test('a correction and a cluster merge each invalidate the active anchor', async t => {
  const corrected = fixture(t);
  await graduate(corrected);
  assert.equal(corrected.name().anchor.state, 'active');
  const change = applySpeakerCorrection(corrected.db, corrected.identifier, { type: 'apply', noteId: corrected.liveNoteId,
    id: 'correction-2', scope: 'row', rowIds: ['live-row'], name: 'Bob' });
  assert.equal(change.success, true);
  assert.equal(corrected.identifier.getAnchorState('speaker_0'), null);

  const merged = fixture(t);
  await graduate(merged);
  assert.equal(merged.name().anchor.state, 'active');
  merged.identifier._assignSpeakerId(unit(0.81, 0.59));
  assert.equal(merged.identifier._performRecluster().length, 1);
  assert.equal(merged.identifier.getAnchorState('speaker_0'), null);
});

test('overlapping, locked, explicit Unknown, short and ambiguous clusters have specific refusals', async t => {
  const cases = [
    [{ uncertainty: { reason: 'overlapping_speech' } }, 'overlapping'],
    [{ speakerLocked: true, speakerLockSource: 'user', speakerName: 'Alex' }, 'locked'],
    [{ speakerLocked: true, speakerLockSource: 'user', speakerName: undefined }, 'explicit_unknown'],
  ];
  for (const [patch, reason] of cases) {
    await t.test(reason, async sub => {
      const f = fixture(sub);
      await graduate(f);
      f.db.updateNote(f.liveNoteId, { transcript: JSON.stringify({ version: 2, rows: [{ ...f.row, ...patch }] }) });
      assert.equal(f.name().anchor.reason, reason);
      assert.equal(f.identifier.getAnchorState('speaker_0'), null);
    });
  }
  await t.test('too short', async sub => {
    const f = fixture(sub);
    await graduate(f);
    f.identifier.transientVoicedSamples.set('speaker_0', 16000);
    assert.equal(f.name().anchor.reason, 'too_short');
  });
  await t.test('ambiguous match', async sub => {
    const f = fixture(sub);
    await graduate(f);
    f.identifier._assignSpeakerId(unit(0.85, 0.53));
    assert.equal(f.name().anchor.reason, 'ambiguous_match');
  });
});

test('a split or voice reset drops a live anchor', async t => {
  const f = fixture(t);
  await graduate(f);
  f.db.updateNote(f.liveNoteId, { transcript: JSON.stringify({ version: 2, rows: [f.row,
    { ...f.row, id: 'live-row-2' }] }) });
  assert.equal(f.name().anchor.state, 'active');
  const split = applySpeakerCorrection(f.db, f.identifier, { type: 'split', noteId: f.liveNoteId,
    id: 'split-1', target: { runId: 'run-live', clusterId: 'speaker_0' }, rowIds: ['live-row-2'] });
  assert.equal(split.success, true, split.error);
  assert.equal(f.identifier.getAnchorState('speaker_0'), null);
  assert.notEqual(f.identifier._resolveSpeakerForEmbedding(unit(0.02, 1)).displayName, 'Alex');
  const g = fixture(t);
  await graduate(g);
  assert.equal(g.name().anchor.state, 'active');
  const reset = require('../../src/helpers/peopleActions').applyPersonAction(g.db, { type: 'reset', profileId: g.person.id });
  assert.equal(reset.success, true);
  g.identifier.reconcilePeopleMutation({ type: 'reset', profileId: g.person.id });
  assert.equal(g.identifier.getAnchorState('speaker_0'), null);
});
