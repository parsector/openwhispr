const createTempDir = require("../lib/tempDir");
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
const retainedSpeakerAudio = require('../lib/retainedSpeakerAudio');
Module._load = originalLoad;

const vector = (x, y = 0) => Float32Array.from({ length: 512 }, (_, i) => i === 0 ? x : i === 1 ? y : 0);
function fixture(t) {
  dir = createTempDir(path.join(os.tmpdir(), 'ow-reconsider-'));
  const ownDir = dir;
  const db = new Database();
  t.after(() => { db.db.close(); fs.rmSync(ownDir, { recursive: true, force: true }); });
  const person = db.createNamedSpeakerProfile('Alex', 'alex@example.com');
  let clock = Date.now();
  const { audio, record } = retainedSpeakerAudio(db, ownDir, () => clock);
  const extractor = { extractEmbeddingFromSamples: async () => vector(1) };
  for (const [title, count] of [['Earlier one', 2], ['Earlier two', 1]]) {
    const id = db.saveNote(title, '', 'meeting').note.id;
    const recordingId = record(id, count);
    const rows = Array.from({ length: count }, (_, i) => ({ id: `${title}-${i}`, source: 'system',
      speaker: 'speaker_0', speakerName: 'Alex', speakerLockSource: 'user', suggestedProfileId: person.id,
      audioSpan: { recordingId, trackId: 'system', startSample: i * 120000, endSample: i * 120000 + 96000 } }));
    db.updateNote(id, { transcript: JSON.stringify({ version: 2, rows }) });
  }
  const noteId = db.saveNote('Live', '', 'meeting').note.id;
  db.updateNote(noteId, { participants: JSON.stringify([{email:'alex@example.com'}]) });
  const runId = 'run-live';
  const row = { id: 'live-row', text: 'Hello', source: 'system', diarizationRunId: runId,
    speaker: 'speaker_3', speakerIsPlaceholder: true, speakerStatus: 'suggested',
    audioSpan: { recordingId: noteId, trackId: 'system', startSample: 0, endSample: 96000 } };
  db.updateNote(noteId, { transcript: JSON.stringify({ version: 2, rows: [row] }) });
  const identifier = new LiveSpeakerIdentifier();
  identifier.getSpeakerScope = () => require('../../src/helpers/noteSpeakerScope').readScope(db, noteId);
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
  return { db, person, noteId, runId, row, identifier, graduate, audio, record };
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

test('a mic cohort becomes nameable after graduation without confirming the mic row', async t => {
  const f = fixture(t);
  const micRow = { ...f.row, source: 'mic', audioSpan: { ...f.row.audioSpan, trackId: 'mic' } };
  f.db.updateNote(f.noteId, { transcript: JSON.stringify({ version: 2, rows: [micRow] }) });
  f.identifier.transientCohorts.set('speaker_3', 'mic');
  await f.graduate();
  const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId);
  assert.equal(result.assignments.length, 1);
  const row = JSON.parse(f.db.getNote(f.noteId).transcript).rows[0];
  assert.equal(row.speakerName, 'Alex');
  assert.equal(row.speakerStatus, 'provisional');
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

test('cached reconsideration cannot supersede a row veto while a clean sibling can graduate', async t => {
  const f = fixture(t);
  await f.graduate();
  const scope = require('../../src/helpers/noteSpeakerScope');
  const evidence = scope.decision(scope.readScope(f.db, f.noteId), {
    runId: f.runId, path: 'row_evaluation', rejectionReason: 'close_match',
  });
  const vetoed = { ...f.row, id: 'vetoed-row', uncertainty: { reason: 'close_match' }, speakerDecision: evidence };
  f.db.updateNote(f.noteId, { transcript: JSON.stringify({ version: 2, rows: [vetoed, f.row] }) });
  const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId);
  assert.equal(result.assignments.length, 1);
  const rows = JSON.parse(f.db.getNote(f.noteId).transcript).rows;
  assert.equal(rows[0].speakerName, undefined);
  assert.deepEqual(rows[0].speakerDecision, evidence);
  assert.equal(require('../../src/helpers/speakerRosterPolicy').recordedNameAllowed(rows[0]), false);
  assert.equal(rows[1].speakerName, 'Alex');
  assert.deepEqual(result.assignments[0].rows.map(row => row.id), ['live-row']);
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

test('roster reconsideration vetoes a cached eligible match after the participant is removed', async t => {
  const f = fixture(t);
  await f.graduate();
  const stale = {noteId:f.noteId,source:'note',revision:'old',roster:[{email:'alex@example.com'}],eligibleProfileIds:[f.person.id]};
  f.identifier.getSpeakerScope = () => stale;
  f.db.updateNote(f.noteId, { participants: '[]' });
  const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId);
  assert.deepEqual(result.assignments, []);
  assert.equal(JSON.parse(f.db.getNote(f.noteId).transcript).rows[0].speakerName, undefined);
});

test('roster reconsideration cannot name an approved outsider', async t => {
  const f = fixture(t);
  await f.graduate();
  f.db.updateNote(f.noteId, { participants: JSON.stringify([{email:'invited@example.com'}]) });
  const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId);
  assert.deepEqual(result.assignments, []);
  const row=JSON.parse(f.db.getNote(f.noteId).transcript).rows[0];
  assert.equal(row.speakerName, undefined);
  assert.equal(row.speakerDecision.rejectionReason, 'outside_roster');
});

test('roster reconsideration records the snapshot even when no approved voice matches', t => {
  const f=fixture(t);
  const result=reconsiderLiveClusters(f.db,f.identifier,f.noteId,f.runId);
  assert.deepEqual(result.assignments,[]);
  const row=JSON.parse(f.db.getNote(f.noteId).transcript).rows[0];
  assert.equal(row.speakerDecision.rejectionReason,'no_match');
  assert.equal(row.speakerDecision.runId,f.runId);
  assert.deepEqual(row.speakerDecision.roster,[{email:'alex@example.com'}]);
});

test('roster owner A/B vetoes reconsideration winner C without promoting A',async t=>{
  const f=fixture(t);
  await f.graduate();
  const a=f.db.createNamedSpeakerProfile('A','a@example.com');
  const b=f.db.createNamedSpeakerProfile('B','b@example.com');
  f.db.updateNote(f.noteId,{participants:JSON.stringify([{email:a.email},{email:b.email}])});
  f.identifier.getSpeakerProfiles=()=>[
    {...a,voice_usable:1,embedding:vector(.7,Math.sqrt(.51))},
    {...b,voice_usable:1,embedding:vector(.3,-Math.sqrt(.91))},
    {...f.person,voice_usable:1,embedding:vector(.95,Math.sqrt(.0975))},
  ];
  const result=reconsiderLiveClusters(f.db,f.identifier,f.noteId,f.runId);
  assert.deepEqual(result.assignments,[]);
  const row=JSON.parse(f.db.getNote(f.noteId).transcript).rows[0];
  assert.equal(row.speakerName,undefined);
  assert.equal(row.suggestedName,undefined);
  assert.equal(row.speakerDecision.acousticWinnerProfileId,f.person.id);
  assert.ok(Math.abs(row.speakerDecision.scores.best-.95)<1e-6);
  assert.ok(Math.abs(row.speakerDecision.scores.runnerUp-.7)<1e-6);
});

for (const change of ["enrollment", "roster expansion"]) {
  test(`a veto is reevaluated after ${change}, but cached evidence alone leaves it Unknown`, async (t) => {
    const f = fixture(t);
    const scope = require("../../src/helpers/noteSpeakerScope");
    if (change === "roster expansion") {
      await f.graduate();
      f.db.updateNote(f.noteId, {
        participants: JSON.stringify([{ email: "outsider@example.com" }]),
      });
    }
    reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId);
    const vetoed = JSON.parse(f.db.getNote(f.noteId).transcript).rows[0];
    assert.ok(vetoed.speakerDecision.rejectionReason);
    assert.equal(
      reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId).assignments.length,
      0
    );
    if (change === "enrollment") await f.graduate();
    else
      f.db.updateNote(f.noteId, { participants: JSON.stringify([{ email: "alex@example.com" }]) });
    const pending = JSON.parse(f.db.getNote(f.noteId).transcript).rows[0];
    const evaluations = new Map([[pending.id, {embedding:vector(1),audioContentHash:"canonical-live-audio",
      previousDecisionId:pending.speakerDecision.decisionId}]]);
    const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId, [], evaluations);
    assert.equal(result.assignments.length, 1);
    const actual = JSON.parse(f.db.getNote(f.noteId).transcript).rows[0];
    assert.equal(actual.speakerName, "Alex");
    assert.equal(actual.speakerDecision.revision, scope.readScope(f.db, f.noteId).revision);
  });
}

test("reconsideration evaluates retained row audio and commits its canonical content hash", async (t) => {
  const f = fixture(t);
  const recordingId = f.record(f.noteId, 1);
  f.row.audioSpan.recordingId = recordingId;
  f.db.updateNote(f.noteId, { transcript: JSON.stringify([f.row]) });
  reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId);
  await f.graduate();
  const { prepareSpeakerRowEvaluations } = require("../../src/helpers/speakerRowEvaluation");
  let contentHash;
  const extractor = {
    isAvailable: () => true,
    extractEmbeddingFromSamples: async (samples) => {
      contentHash = require("node:crypto")
        .createHash("sha256")
        .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
        .digest("hex");
      return vector(1);
    },
  };
  const evaluations = await prepareSpeakerRowEvaluations(
    f.db,
    f.identifier,
    f.noteId,
    f.runId,
    [],
    f.audio,
    extractor
  );
  assert.equal(evaluations.size, 1);
  const result = reconsiderLiveClusters(f.db, f.identifier, f.noteId, f.runId, [], evaluations);
  assert.equal(result.assignments.length, 1);
  const actual = JSON.parse(f.db.getNote(f.noteId).transcript).rows[0];
  assert.equal(actual.speakerName, "Alex");
  assert.equal(actual.audioContentHash, contentHash);
  assert.equal(actual.speakerDecision.evaluation.audioContentHash, contentHash);
});

test('a refused row evaluation cannot publish an accepted cluster assignment', async t => {
  const f = fixture(t);
  reconsiderLiveClusters(f.db,f.identifier,f.noteId,f.runId);
  const row = JSON.parse(f.db.getNote(f.noteId).transcript).rows[0];
  f.db.updateNote(f.noteId,{transcript:JSON.stringify([{...row,audioContentHash:'canonical'}])});
  await f.graduate();
  const evaluations = new Map([[row.id,{embedding:vector(1),audioContentHash:'different-content',previousDecisionId:row.speakerDecision.decisionId}]]);
  const result = reconsiderLiveClusters(f.db,f.identifier,f.noteId,f.runId,[],evaluations);
  assert.deepEqual(result.assignments,[]);
  assert.equal(f.identifier.transientDisplayNames.has('speaker_3'),false);
});
