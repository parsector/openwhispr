const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
let dir;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => dir, getAppPath: () => process.cwd(), isReady: () => false } };
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = 'test';
const DatabaseManager = require('../../src/helpers/database');
const enrollment = require('../../src/helpers/voiceEnrollment');
const enrollmentTiming = require('../../src/helpers/voiceEnrollmentTiming');
const { listReviewRows, reviewRowsPage, REVIEW_RULES_VERSION } = require('../../src/helpers/peopleActions');

test('all voice guard thresholds carry the same uncalibrated label', () => {
  assert.deepEqual(Object.values(enrollment.calibration).map(item => item.status),
    ['uncalibrated', 'uncalibrated', 'uncalibrated', 'uncalibrated']);
});

test('decision timing emits one structured debug line after renderer refresh', async t => {
  const logger = require('../../src/helpers/debugLogger');
  const original = logger.debug;
  const lines = [];
  logger.debug = message => lines.push(JSON.parse(message));
  t.after(() => { logger.debug = original; });
  const result = await enrollmentTiming.run('decide', async () => {
    enrollmentTiming.candidateCount(1);
    enrollmentTiming.decoded(12);
    return { success: true };
  }, true);
  assert.equal(lines.length, 0);
  enrollmentTiming.rendererRefresh(result.timingId, 7);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), [
    'event', 'action', 'total_ms', 'candidate_scan_ms', 'echo_decode_ms',
    'span_read_ms', 'ffmpeg_decode_ms', 'embed_ms', 'renderer_refresh_ms',
    'candidate_count', 'decode_count',
  ].sort());
  assert.equal(lines[0].renderer_refresh_ms, 7);
  assert.equal(lines[0].event, 'voice_enrollment_ipc_timing');
  assert.equal(lines[0].decode_count, 1);
});

test('review eligibility matches enrolment after owner labels, and changes when audio expires', async t => {
  const f = fixture(t);
  const { noteId } = f.note('review', 5);
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  for (const row of doc.rows) {
    delete row.speakerName;
    delete row.suggestedProfileId;
    delete row.speakerLockSource;
    row.speakerIsPlaceholder = true;
  }
  doc.rows[1].audioSpan.endSample = doc.rows[1].audioSpan.startSample + 2 * 24000;
  doc.rows[2].overlap = true;
  doc.rows[3].audioSpan.trackId = 'system';
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  f.audio.spanAvailable = (_note, _track, start) => start !== 5 * 24000 + 6000;
  const before = listReviewRows(f.db, null, f.audio);
  const byId = new Map(before.map(row => [row.rowId, row.eligibilityReason]));
  assert.deepEqual([...before.map(row => row.rowId)], ['review-4', 'review-3', 'review-2', 'review-1', 'review-0']);
  assert.equal(byId.get('review-0'), null);
  assert.equal(byId.get('review-1'), 'short');
  assert.equal(byId.get('review-2'), 'overlap');
  assert.equal(byId.get('review-3'), 'resolution');
  assert.equal(byId.get('review-4'), null);
  const { applySpeakerCorrection } = require('../../src/helpers/speakerCorrectionTransaction');
  for (const row of doc.rows) {
    assert.equal(applySpeakerCorrection(f.db, null, {
      type: 'apply', noteId, id: `label-${row.id}`, scope: 'row', rowIds: [row.id],
      name: 'Alex', profileId: f.person.id,
    }).success, true);
  }
  const offered = new Set(enrollment.listCandidates(f.db, f.audio, f.person.id).map(c => c.rowIds[0]));
  for (const [rowId, reason] of byId) assert.equal(offered.has(rowId), reason === null, rowId);
  for (const candidate of enrollment.listCandidates(f.db, f.audio, f.person.id)) {
    const playback = enrollment.play(f.db, f.audio, candidate.id);
    assert.equal(playback.state, 'available');
    f.completeReview(candidate.id, playback.token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', playback.token)).success, true);
  }
  f.audio.status = () => ({ state: 'expired', bytes: 0 });
  const afterExpiry = new Map(listReviewRows(f.db, f.person.id, f.audio).map(row => [row.rowId, row.eligibilityReason]));
  assert.equal(afterExpiry.get('review-0'), 'audio');
  assert.equal(afterExpiry.get('review-4'), 'audio');
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);
});

test('review and enrolment use the whole shared span, echo guard, and sample cap', t => {
  const f = fixture(t);
  const { noteId } = f.note('shared', 2);
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  doc.rows[1].audioSpan = { ...doc.rows[0].audioSpan };
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  assert.deepEqual(listReviewRows(f.db, f.person.id, f.audio).map(row => row.eligibilityReason), [null, null]);
  assert.deepEqual(enrollment.listCandidates(f.db, f.audio, f.person.id).map(c => c.rowIds[0]), ['shared-0', 'shared-1']);

  doc.rows[0].recordingId = 'different-recording';
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  assert.deepEqual(listReviewRows(f.db, f.person.id, f.audio).map(row => row.eligibilityReason), [null, 'resolution']);
  assert.deepEqual(enrollment.listCandidates(f.db, f.audio, f.person.id).map(c => c.rowIds[0]), ['shared-1']);
  delete doc.rows[0].recordingId;
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });

  f.audio.status = () => ({ state: 'complete', tracks: {
    mic: { chunks: [{ startSample: 0, sampleCount: 5 * 24000 }] },
    system: { chunks: [{ startSample: 0, sampleCount: 5 * 24000 }] },
  } });
  assert.deepEqual(listReviewRows(f.db, f.person.id, f.audio).map(row => row.eligibilityReason), ['overlap', 'overlap']);
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);

  f.audio.status = () => ({ state: 'complete' });
  const insert = f.db.db.prepare(`INSERT INTO voice_exemplars
    (id, profile_id, note_id, track, start_sample, end_sample, approved_at)
    VALUES (?, ?, ?, 'mic', ?, ?, CURRENT_TIMESTAMP)`);
  for (let i = 0; i < 20; i++) insert.run(`cap-${i}`, f.person.id, noteId, 24000 * (100 + i), 24000 * (101 + i));
  assert.deepEqual(listReviewRows(f.db, f.person.id, f.audio).map(row => row.eligibilityReason), ['limit', 'limit']);
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);
});

test('a retained legacy row without a persisted span is offered for review', async (t) => {
  const f = fixture(t);
  const { noteId } = f.note('legacy');
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  const startedAt = 1_700_000_000_000;
  Object.assign(doc.rows[0], { timestamp: startedAt + 5_000, speechStart: startedAt + 1_000,
    speechEnd: startedAt + 5_000, recordingId: noteId, recordingOrigin: startedAt,
    timebase: 'epoch' });
  delete doc.rows[0].audioSpan;
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  f.audio.status = () => ({ state: 'complete', bytes: 100, startedAt, recordingId: noteId,
    tracks: { mic: { chunks: [{ startSample: 0, sampleCount: 24000 * 6 }] } } });
  const report = enrollment.candidateReport(f.db, f.audio, f.person.id);
  assert.deepEqual(report.candidates.map(candidate => candidate.rowIds[0]), ['legacy-0']);
  assert.equal(report.reasons.audio, 0);
  const { playbackRange } = await import('../../src/utils/meetingAudioPlayback.ts');
  const { buildCalibrationLabels } = require('../../src/helpers/speakerCalibrationExport');
  const status = f.audio.status(noteId);
  const range = playbackRange(doc.rows[0], doc.rows, noteId, startedAt, status.tracks);
  const label = buildCalibrationLabels({ id: noteId, transcript: JSON.stringify(doc) }, {}, status).rows[0];
  assert.deepEqual([label.from, label.to, label.unavailableReason], [range.from, range.to, null]);
  assert.deepEqual([report.candidates[0].startSample, report.candidates[0].endSample],
    [Math.round((Math.max(range.from, label.start) + .25) * 24000),
      Math.round((Math.min(range.to, label.end) - .25) * 24000)]);

  doc.rows[0].audioSpan = { recordingId: 'old-recording', trackId: 'mic',
    startSample: 24000, endSample: 24000 * 5 };
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 1);

  f.audio.status = () => ({ state: 'expired', bytes: 0 });
  const expired = enrollment.candidateReport(f.db, f.audio, f.person.id);
  assert.equal(expired.candidates.length, 0);
  assert.equal(expired.reasons.audio, 1);

  f.audio.status = () => ({ state: 'complete', bytes: 100, startedAt, recordingId: noteId,
    tracks: { mic: { chunks: [{ startSample: 24000 * 20, sampleCount: 24000 * 6 }] } } });
  assert.equal(enrollment.candidateReport(f.db, f.audio, f.person.id).reasons.audio, 1);

  delete doc.rows[0].audioSpan;
  doc.rows[0].timestamp = 5;
  delete doc.rows[0].timebase;
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  f.audio.status = () => ({ state: 'complete', bytes: 100, startedAt, recordingId: noteId,
    tracks: { mic: { chunks: [{ startSample: 0, sampleCount: 24000 * 6 }] } } });
  assert.equal(enrollment.candidateReport(f.db, f.audio, f.person.id).reasons.resolution, 1);

  doc.rows[0].timestamp = startedAt + 5_000;
  doc.rows[0].timebase = 'epoch';
  doc.rows[0].speechEnd = startedAt + 3_000;
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  const short = enrollment.candidateReport(f.db, f.audio, f.person.id);
  assert.equal(short.candidates.length, 0);
  assert.equal(short.reasons.short, 1);

  doc.rows[0].overlap = true;
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  const overlap = enrollment.candidateReport(f.db, f.audio, f.person.id);
  assert.equal(overlap.candidates.length, 0);
  assert.equal(overlap.reasons.overlap, 1);
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
    const rows = Array.from({ length: count }, (_, i) => ({ id: `${suffix}-${i}`, source: 'mic', speaker: 'speaker_0',
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

test('focused candidate agrees with the scan and falls back after a revision change', t => {
  const f = fixture(t);
  const { noteId } = f.note('focused');
  const original = require('../../src/helpers/meetingAudioSpan.mjs').resolveMeetingAudioSpan;
  let resolved = 0;
  f.audio.resolveMeetingAudioSpan = (...args) => { resolved++; return original(...args); };
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  assert.ok(resolved > 0);
  resolved = 0;
  assert.deepEqual(enrollment.play(f.db, f.audio, candidate.id).candidate, candidate);
  assert.equal(resolved, 0);
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  doc.rows[0].text = 'revised';
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  enrollment.play(f.db, f.audio, candidate.id);
  assert.ok(resolved > 0, 'revision mismatch must use the authoritative scan');
});

test('enrolment facts cache invalidates for edits, audio loss, expiry and rules changes', t => {
  const f = fixture(t);
  const { noteId } = f.note('cached');
  const original = require('../../src/helpers/meetingAudioSpan.mjs').resolveMeetingAudioSpan;
  let resolved = 0;
  f.audio.resolveMeetingAudioSpan = (...args) => { resolved++; return original(...args); };
  const cold = enrollment.candidateReport(f.db, f.audio, f.person.id);
  assert.ok(resolved > 0);
  resolved = 0;
  assert.deepEqual(enrollment.candidateReport(f.db, f.audio, f.person.id), cold);
  assert.equal(resolved, 0);
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  doc.rows[0].text = 'edited';
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  enrollment.candidateReport(f.db, f.audio, f.person.id);
  assert.ok(resolved > 0);
  resolved = 0;
  f.audio.status = () => ({ state: 'deleted', bytes: 0 });
  assert.equal(enrollment.candidateReport(f.db, f.audio, f.person.id).reasons.audio, 1);
  f.audio.status = () => ({ state: 'expired', bytes: 0 });
  assert.equal(enrollment.candidateReport(f.db, f.audio, f.person.id).reasons.audio, 1);
  f.audio.status = () => ({ state: 'complete' });
  enrollment.candidateReport(f.db, f.audio, f.person.id);
  f.audio.spanAvailable = () => false;
  assert.equal(enrollment.candidateReport(f.db, f.audio, f.person.id).reasons.audio, 1);
  f.audio.spanAvailable = () => true;
  resolved = 0;
  enrollment.candidateReport(f.db, f.audio, f.person.id,
    enrollment.ENROLLMENT_RULES_VERSION + 1);
  assert.ok(resolved > 0);
});

test('listing, repeated play, complete and approve resolve a span only during the listing', async t => {
  const f = fixture(t);
  f.note('single-scan');
  const original = require('../../src/helpers/meetingAudioSpan.mjs').resolveMeetingAudioSpan;
  let resolved = 0;
  f.audio.resolveMeetingAudioSpan = (...args) => { resolved++; return original(...args); };
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  const listingResolutions = resolved;
  assert.ok(listingResolutions > 0);
  const first = enrollment.play(f.db, f.audio, candidate.id);
  assert.equal(first.state, 'available');
  const second = enrollment.play(f.db, f.audio, candidate.id);
  assert.equal(second.state, 'available');
  f.completeReview(candidate.id, second.token);
  assert.equal((await enrollment.decide(f.db, f.audio, f.extractor,
    candidate.id, 'approve', second.token)).success, true);
  assert.equal(resolved, listingResolutions);
});

test('voice query indexes migrate an existing database without changing results', t => {
  const f = fixture(t);
  const { noteId } = f.note('migration');
  const sql = [
    `SELECT id FROM notes WHERE note_type = 'meeting' AND deleted_at IS NULL ORDER BY id`,
    `SELECT id FROM voice_exemplars WHERE profile_id = ? AND approved_at IS NOT NULL ORDER BY approved_at, id`,
    `SELECT id FROM voice_exemplars WHERE profile_id = ? AND note_id = ? AND track = 'mic'
      AND start_sample < ? AND end_sample > ?`,
    `SELECT id FROM voice_enrollment_candidates WHERE profile_id = ? AND note_id = ?
      AND track = 'mic' AND start_sample = ? AND end_sample = ?`,
  ];
  const args = [[], [f.person.id], [f.person.id, noteId, 120000, 0],
    [f.person.id, noteId, 6000, 90000]];
  const indexNames = ['idx_notes_meeting_live', 'idx_voice_exemplars_profile_approved',
    'idx_voice_exemplars_overlap', 'idx_voice_candidates_overlap',
    'idx_speaker_mappings_profile', 'idx_speaker_run_mappings_profile'];
  for (const name of indexNames) f.db.db.exec(`DROP INDEX ${name}`);
  f.db.db.pragma('user_version = 5');
  const before = sql.map((query, i) => f.db.db.prepare(query).all(...args[i]));
  f.db.db.close();
  const reopened = new DatabaseManager();
  f.db.db = reopened.db;
  assert.equal(f.db.db.pragma('user_version', { simple: true }), 6);
  assert.deepEqual(sql.map((query, i) => f.db.db.prepare(query).all(...args[i])), before);
  for (const name of indexNames)
    assert.ok(f.db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name));
});

test('review cache recomputes only edited notes and keeps the person cap live', t => {
  const f = fixture(t);
  const one = f.note('one', 2).noteId;
  const two = f.note('two', 2).noteId;
  const original = require('../../src/helpers/meetingAudioSpan.mjs').resolveMeetingAudioSpan;
  let resolved = 0;
  f.audio.resolveMeetingAudioSpan = (...args) => { resolved++; return original(...args); };
  const cold = listReviewRows(f.db, f.person.id, f.audio);
  assert.ok(resolved >= 4);
  resolved = 0;
  assert.deepEqual(listReviewRows(f.db, f.person.id, f.audio), cold);
  assert.equal(resolved, 0, 'second open must perform zero span resolution');
  const doc = JSON.parse(f.db.getNote(one).transcript);
  doc.rows[0].text = 'edited';
  f.db.updateNote(one, { transcript: JSON.stringify(doc) });
  assert.deepEqual(reviewRowsPage(f.db, f.person.id, f.audio).pending, [one]);
  listReviewRows(f.db, f.person.id, f.audio);
  assert.ok(resolved > 0);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM review_row_cache').get().n, 2);
  const insert = f.db.db.prepare(`INSERT INTO voice_exemplars
    (id, profile_id, note_id, track, start_sample, end_sample, approved_at)
    VALUES (?, ?, ?, 'mic', ?, ?, CURRENT_TIMESTAMP)`);
  for (let index = 0; index < 20; index++)
    insert.run(`limit-${index}`, f.person.id, two, 24000 * (100 + index), 24000 * (101 + index));
  resolved = 0;
  assert.deepEqual(listReviewRows(f.db, f.person.id, f.audio).map(row => row.eligibilityReason),
    ['limit', 'limit', 'limit', 'limit']);
  assert.equal(resolved, 0, 'the live sample cap must not invalidate acoustic facts');
  assert.equal(f.db.deleteNote(one).success, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM review_row_cache WHERE note_id = ?').get(one).n, 0);
});

test('review cache invalidates for removed and expired audio and a rules-version bump', t => {
  const f = fixture(t);
  const one = f.note('one').noteId;
  const two = f.note('two').noteId;
  listReviewRows(f.db, f.person.id, f.audio);
  f.audio.status = noteId => ({ state: noteId === one ? 'deleted' : 'complete' });
  assert.deepEqual(reviewRowsPage(f.db, f.person.id, f.audio).pending, [one]);
  listReviewRows(f.db, f.person.id, f.audio);
  assert.equal(listReviewRows(f.db, f.person.id, f.audio).find(row => row.noteId === one).eligibilityReason, 'audio');
  f.audio.status = noteId => ({ state: noteId === two ? 'expired' : 'deleted' });
  assert.deepEqual(reviewRowsPage(f.db, f.person.id, f.audio).pending, [two]);
  listReviewRows(f.db, f.person.id, f.audio);
  assert.deepEqual(reviewRowsPage(f.db, f.person.id, f.audio, false, null, REVIEW_RULES_VERSION + 1).pending,
    [one, two]);
});

test('twenty-recording review benchmark preserves ordering and grouped reasons on a warm open', t => {
  const f = fixture(t);
  for (let index = 0; index < 20; index++) {
    const { noteId } = f.note(`note-${String(index).padStart(2, '0')}`);
    const doc = JSON.parse(f.db.getNote(noteId).transcript);
    doc.rows[0].uncertainty = { reason: index % 2 ? 'close_match' : 'overlapping_speech' };
    f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  }
  const original = require('../../src/helpers/meetingAudioSpan.mjs').resolveMeetingAudioSpan;
  let resolved = 0;
  f.audio.resolveMeetingAudioSpan = (...args) => { resolved++; return original(...args); };
  const coldStart = performance.now();
  const cold = listReviewRows(f.db, null, f.audio, true);
  const coldMs = performance.now() - coldStart;
  const coldResolutions = resolved;
  resolved = 0;
  const warmStart = performance.now();
  const warm = listReviewRows(f.db, null, f.audio, true);
  const warmMs = performance.now() - warmStart;
  assert.deepEqual(warm, cold);
  assert.equal(cold.length, 20);
  assert.deepEqual(new Set(cold.map(row => row.reason)),
    new Set(['close_match', 'overlapping_speech']));
  assert.deepEqual(cold.map(row => row.noteId), [...cold.map(row => row.noteId)].sort((a, b) => b - a));
  assert.ok(coldResolutions >= 20);
  assert.equal(resolved, 0);
  console.log(`review cache benchmark: cold ${coldResolutions} span resolutions / ${coldMs.toFixed(1)} ms; warm ${resolved} / ${warmMs.toFixed(1)} ms`);
});

test('fresh identity stays unenrolled; approval needs playback; rejection is durable', async t => {
  const f = fixture(t);
  const { noteId } = f.note('one');
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 0);
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  assert.equal(candidate.noteId, noteId);
  assert.equal(candidate.track, 'mic');
  assert.deepEqual(candidate.rowIds, ['one-0']);
  assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', null)).success, false);
  const played = enrollment.play(f.db, f.audio, candidate.id);
  assert.equal(played.state, 'available');
  f.completeReview(candidate.id, played.token);
  assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'reject', played.token)).success, true);
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);
});

test('a rejected exact span from before shared resolution is not offered again', (t) => {
  const f = fixture(t);
  const { noteId } = f.note('previously-rejected');
  f.db.db.prepare(`INSERT INTO voice_enrollment_candidates
    (id, profile_id, note_id, track, start_sample, end_sample)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('old-rejection', f.person.id, noteId, 'mic', 6000, 90000);
  const report = enrollment.candidateReport(f.db, f.audio, f.person.id);
  assert.equal(report.candidates.length, 0);
  assert.equal(report.reasons.reviewed, 1);
});

test("a row corrected to this person is offered, while Unknown and another person are not", (t) => {
  const f = fixture(t);
  const { noteId } = f.note("first-name", 3);
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  for (const row of doc.rows)
    Object.assign(row, {
      speakerName: undefined,
      suggestedProfileId: undefined,
      speakerLockSource: undefined,
      speakerIsPlaceholder: true,
    });
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  const { applySpeakerCorrection } = require("../../src/helpers/speakerCorrectionTransaction");
  assert.equal(
    applySpeakerCorrection(f.db, null, {
      type: "apply",
      noteId,
      id: "initial",
      scope: "row",
      rowIds: ["first-name-0"],
      name: "Alex",
      profileId: f.person.id,
    }).success,
    true
  );
  assert.equal(
    applySpeakerCorrection(f.db, null, {
      type: "apply",
      noteId,
      id: "unknown",
      scope: "row",
      rowIds: ["first-name-1"],
      name: "",
    }).success,
    true
  );
  assert.equal(
    applySpeakerCorrection(f.db, null, {
      type: "apply",
      noteId,
      id: "other",
      scope: "row",
      rowIds: ["first-name-2"],
      name: "Sam",
    }).success,
    true
  );
  assert.equal(f.db.setSpeakerMapping(noteId, "speaker_0", f.person.id, "Alex").success, true);
  assert.deepEqual(
    enrollment.listCandidates(f.db, f.audio, f.person.id).map((c) => c.rowIds[0]),
    ["first-name-0"]
  );
  assert.equal(
    applySpeakerCorrection(f.db, null, {
      type: "apply",
      noteId,
      id: "later",
      scope: "row",
      rowIds: ["first-name-0"],
      name: "Alex",
      profileId: f.person.id,
    }).success,
    true
  );
  assert.deepEqual(
    enrollment.listCandidates(f.db, f.audio, f.person.id).map((c) => c.rowIds[0]),
    ["first-name-0"]
  );
  assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM voice_exemplars").get().n, 0);
});

test("empty enrolment reports short, expired, and two-person rows separately", (t) => {
  const f = fixture(t);
  const short = f.note("short", 3);
  const expired = f.note("expired", 2);
  const overlap = f.note("overlap");
  for (const { noteId, change } of [
    {
      noteId: short.noteId,
      change: (row) => {
        row.audioSpan.endSample = row.audioSpan.startSample + 2 * 24000;
      },
    },
    {
      noteId: overlap.noteId,
      change: (row) => {
        row.overlap = true;
      },
    },
  ]) {
    const doc = JSON.parse(f.db.getNote(noteId).transcript);
    doc.rows.forEach(change);
    f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  }
  f.audio.status = (id) =>
    id === expired.noteId ? { state: "expired", bytes: 0 } : { state: "complete" };
  const report = enrollment.candidateReport(f.db, f.audio, f.person.id);
  assert.deepEqual(report.candidates, []);
  assert.deepEqual(report.reasons, {
    short: 3,
    long: 0,
    audio: 2,
    overlap: 1,
    uncertain: 0,
    reviewed: 0,
    limit: 0,
    resolution: 0,
  });
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

test('elapsed time and a forged completion cannot replace audible playback in the requesting window', async t => {
  const f = fixture(t);
  f.note('audible');
  let clock = 1000;
  const store = { ...f.audio, now: () => clock };
  const [candidate] = enrollment.listCandidates(f.db, store, f.person.id);
  const sender = new EventEmitter();
  let audible = false;
  sender.isCurrentlyAudible = () => audible;
  const otherWindow = new EventEmitter();
  otherWindow.isCurrentlyAudible = () => false;
  const first = enrollment.play(f.db, store, candidate.id, sender);
  clock += 5000;
  assert.deepEqual(enrollment.complete(f.db, store, candidate.id, first.token, sender),
    { success: false, error: 'playback_required' });
  const second = enrollment.play(f.db, store, candidate.id, sender);
  audible = true;
  sender.emit('audio-state-changed', { audible: true });
  clock += 4000;
  audible = false;
  sender.emit('audio-state-changed', { audible: false });
  assert.deepEqual(enrollment.complete(f.db, store, candidate.id, second.token, otherWindow),
    { success: false, error: 'playback_required' });
  assert.deepEqual(enrollment.complete(f.db, store, candidate.id, second.token, sender),
    { success: true });
  assert.equal((await enrollment.decide(f.db, store, f.extractor, candidate.id, 'reject', second.token, otherWindow)).success, false);
  assert.equal((await enrollment.decide(f.db, store, f.extractor, candidate.id, 'reject', second.token, sender)).success, true);
});

test('three approved corrected spans across two recordings graduate without naming rows; a later correction demotes', async t => {
  const f = fixture(t);
  f.note('one', 2); f.note('two');
  const { applySpeakerCorrection } = require('../../src/helpers/speakerCorrectionTransaction');
  for (const suffix of ['one', 'two']) {
    const noteId = f.db.db.prepare('SELECT id FROM notes WHERE title = ?').get(`Meeting ${suffix}`).id;
    const rowIds = suffix === 'one' ? ['one-0', 'one-1'] : ['two-0'];
    assert.equal(applySpeakerCorrection(f.db, null, { type: 'apply', noteId, id: `label-${suffix}`,
      scope: 'row', rowIds, name: 'Alex', profileId: f.person.id }).success, true);
  }
  const transcriptsBeforeApproval = f.db.db.prepare("SELECT id, transcript FROM notes WHERE title IN ('Meeting one', 'Meeting two') ORDER BY id").all();
  const candidates = enrollment.listCandidates(f.db, f.audio, f.person.id);
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every(candidate => candidate.everCorrected));
  for (const candidate of candidates) {
    const { token } = enrollment.play(f.db, f.audio, candidate.id);
    f.completeReview(candidate.id, token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token)).success, true);
  }
  assert.equal(enrollment.progress(f.db, f.person.id).usable, true);
  assert.equal(f.db.getSpeakerProfiles(true).length, 1);
  assert.deepEqual(f.db.db.prepare("SELECT id, transcript FROM notes WHERE title IN ('Meeting one', 'Meeting two') ORDER BY id").all(), transcriptsBeforeApproval);
  const note = f.db.db.prepare("SELECT id FROM notes WHERE title = 'Meeting one'").get().id;
  assert.equal(applySpeakerCorrection(f.db, null, { type: 'apply', noteId: note, id: 'fix-one',
    scope: 'row', rowIds: ['one-0'], name: 'Bob' }).success, true);
  assert.equal(enrollment.progress(f.db, f.person.id).usable, false);
  assert.equal(f.db.getSpeakerProfiles(true).length, 0);
});

test('three legacy spans across two labelled meetings graduate only after each full review', async (t) => {
  const f = fixture(t);
  const first = f.note('legacy-one', 2);
  const second = f.note('legacy-two');
  const startedAt = 1_700_000_000_000;
  for (const { noteId } of [first, second]) {
    const doc = JSON.parse(f.db.getNote(noteId).transcript);
    for (const [index, row] of doc.rows.entries()) {
      delete row.audioSpan;
      Object.assign(row, { timebase: 'epoch', recordingId: noteId, recordingOrigin: startedAt,
        speechStart: startedAt + index * 5_000,
        speechEnd: startedAt + index * 5_000 + 4_000,
        timestamp: startedAt + index * 5_000 + 4_000 });
    }
    f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  }
  f.audio.status = (noteId) => ({ state: 'complete', bytes: 100, recordingId: noteId,
    startedAt, tracks: { mic: { chunks: [{ startSample: 0, sampleCount: 24000 * 15 }] } } });
  const candidates = enrollment.listCandidates(f.db, f.audio, f.person.id);
  assert.equal(candidates.length, 3, 'synthetic two-meeting fixture offers three rows');
  assert.equal(enrollment.progress(f.db, f.person.id).usable, false);
  for (const candidate of candidates) {
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id,
      'approve', null)).success, false);
    const playback = enrollment.play(f.db, f.audio, candidate.id);
    assert.equal(playback.state, 'available');
    f.completeReview(candidate.id, playback.token);
    assert.equal((await enrollment.decide(f.db, f.audio, f.extractor, candidate.id,
      'approve', playback.token)).success, true);
  }
  assert.equal(enrollment.progress(f.db, f.person.id).usable, true);
  assert.equal(enrollment.candidateReport(f.db, f.audio, f.person.id).reasons.reviewed, 3);
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
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  assert.ok(candidate);
  assert.equal(enrollment.candidateReport(f.db, f.audio, f.person.id).reasons.short, 1);
  const { token } = enrollment.play(f.db, f.audio, candidate.id);
  f.completeReview(candidate.id, token);
  const decision = await enrollment.decide(f.db, f.audio, f.extractor,
    candidate.id, 'approve', token);
  assert.equal(decision.success, true);
  assert.equal(decision.offers.candidates.length, 0);
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);
  assert.equal(enrollment.play(f.db, f.audio, candidate.id).state, 'unavailable');
});

test('reset and clear voice data remove approved samples; deleted audio cannot leave an offer', async t => {
  const f = fixture(t);
  f.note('one');
  const [candidate] = enrollment.listCandidates(f.db, f.audio, f.person.id);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_enrollment_fact_cache').get().n, 1);
  const { token } = enrollment.play(f.db, f.audio, candidate.id);
  f.completeReview(candidate.id, token);
  await enrollment.decide(f.db, f.audio, f.extractor, candidate.id, 'approve', token);
  const people = require('../../src/helpers/peopleActions');
  assert.equal(people.applyPersonAction(f.db, { type: 'reset', profileId: f.person.id }).success, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_enrollment_fact_cache').get().n, 0);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 0);
  f.audio.status = () => ({ state: 'deleted', bytes: 0 });
  assert.equal(enrollment.listCandidates(f.db, f.audio, f.person.id).length, 0);
  assert.equal(people.clearVoiceData(f.db, people.previewClearVoiceData(f.db)).success, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_enrollment_fact_cache').get().n, 0);
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
    encryption: { encryptBytes: bytes => bytes, decryptBytes: bytes => bytes },
    codec: require('../lib/fakeAudioCodec') });
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
  listReviewRows(f.db, f.person.id, store);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM review_row_cache WHERE note_id = ?').get(noteId).n, 1);
  store.delete(noteId);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM review_row_cache WHERE note_id = ?').get(noteId).n, 0);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM voice_exemplars').get().n, 0);
  assert.equal(f.db.db.prepare('SELECT length(embedding) n FROM speaker_profiles WHERE id = ?').get(f.person.id).n, 0);
  assert.equal(enrollment.listCandidates(f.db, store, f.person.id).length, 0);
  assert.equal(enrollment.undo(f.db, decision.id).success, false);
});

test('retention expiry makes a persisted review fact stale before the audio sweep', t => {
  const f = fixture(t);
  const { noteId } = f.note('retention');
  const { MeetingAudioStore, RATE } = require('../../src/helpers/meetingAudioStore');
  const startedAt = Date.now();
  let now = startedAt;
  const store = new MeetingAudioStore(path.join(dir, 'review-retention'), { database: f.db,
    now: () => now, encryption: { encryptBytes: bytes => bytes, decryptBytes: bytes => bytes },
    codec: require('../lib/fakeAudioCodec') });
  store.begin(noteId, startedAt);
  store.append(noteId, 'mic', Buffer.alloc(RATE * 2 * 4), startedAt);
  store.finish(noteId);
  const doc = JSON.parse(f.db.getNote(noteId).transcript);
  doc.rows[0].audioSpan.recordingId = store.status(noteId).recordingId;
  f.db.updateNote(noteId, { transcript: JSON.stringify(doc) });
  listReviewRows(f.db, f.person.id, store);
  assert.deepEqual(reviewRowsPage(f.db, f.person.id, store).pending, []);
  now += 3 * 86400000;
  assert.equal(store.status(noteId).state, 'expired');
  assert.deepEqual(reviewRowsPage(f.db, f.person.id, store).pending, [noteId]);
  assert.equal(listReviewRows(f.db, f.person.id, store)[0].eligibilityReason, 'audio');
  store.purgeAll();
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM review_row_cache').get().n, 0);
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
    encryption: { encryptBytes: bytes => bytes, decryptBytes: bytes => bytes },
    codec: require('../lib/fakeAudioCodec') });
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
    encryption: { encryptBytes: bytes => bytes, decryptBytes: bytes => bytes },
    codec: require('../lib/fakeAudioCodec') });
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
  assert.equal(enrollment.candidateReport(f.db, f.audio, f.person.id).reasons.overlap, 1);
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
