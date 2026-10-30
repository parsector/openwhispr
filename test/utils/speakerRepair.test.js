const test = require('node:test');
const assert = require('node:assert/strict');
const readTranscriptDocument = (raw) => { const parsed = JSON.parse(raw); const rows = Array.isArray(parsed) ? parsed : parsed.rows; return { rows, unknownNumberHighWater: Array.isArray(parsed) ? Math.max(0, ...rows.map(r => r.unknownNumberHighWater || r.unknownNumber || 0)) : parsed.unknownNumberHighWater }; };
const row = (id, run, speaker = 'speaker_0') => ({ id, text: id, source: 'system', speaker, diarizationRunId: run });

test('delete every row, reload, resume, and allocate above note high-water', async () => {
  const { serializeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const { parseSeedSegments } = await import('../../src/utils/parseTranscriptSegments.ts');
  const first = serializeTranscriptSegments([row('a', 'old'), row('b', 'old', 'speaker_1')]);
  const deleted = serializeTranscriptSegments([], readTranscriptDocument(first).unknownNumberHighWater);
  assert.equal(readTranscriptDocument(deleted).unknownNumberHighWater, 2);
  assert.deepEqual(parseSeedSegments(deleted, 7), []);
  const resumed = serializeTranscriptSegments([row('c', 'new')], readTranscriptDocument(deleted).unknownNumberHighWater);
  assert.equal(readTranscriptDocument(resumed).rows[0].unknownNumber, 3);
});

test('resumed session and old session never duplicate Unknown speaker 1', async () => {
  const { mergeSessionDiarization } = await import('../../src/utils/diarizationCompletion.ts');
  const { normalizeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const old = normalizeTranscriptSegments([row('a', 'old')]);
  const merged = mergeSessionDiarization({ existing: old, seedLength: 1,
    unknownNumberHighWater: 1, segments: [row('b', 'new')] });
  assert.deepEqual(merged.segments.map(s => s.unknownNumber), [1, 2]);
});

test('the 51st correction leaves the first event undoable', async () => {
  const { correctTranscriptRows, undoTranscriptCorrection } = await import('../../src/utils/transcriptCorrections.ts');
  let rows = [row('a', 'one')];
  let first;
  for (let i = 0; i < 55; i++) {
    rows = correctTranscriptRows(rows, new Set(['a']), 'row', `Person ${i}`);
    if (i === 0) first = rows[0].corrections[0].id;
  }
  assert.equal(rows[0].corrections.length, 55);
  const undone = undoTranscriptCorrection(rows, first);
  assert.equal(undone[0].corrections.length, 54);
});

test('sync and JSON export redact local evidence while remote render keeps labels', async () => {
  const { buildNoteUpdatePayload } = await import('../../src/helpers/cloudSyncGuards.js');
  const { formatJson } = require('../../src/helpers/transcriptFormatter.js');
  const { parseTranscriptSegments } = await import('../../src/utils/parseTranscriptSegments.ts');
  const source = row('a', 'old');
  Object.assign(source, { speakerName: 'Alex', speakerLocked: true, speakerLockSource: 'user',
    corrections: [{ id: 'secret', previous: { speakerName: 'Prior' } }], suggestedName: 'Candidate',
    suggestedProfileId: 1234, uncertainty: { reason: 'ambiguous', candidates: ['Sam', 'Pat'] } });
  const raw = JSON.stringify([source]);
  const payload = buildNoteUpdatePayload({ transcript: raw }, null);
  const exported = formatJson({ title: 'Note', created_at: '2026-01-01T00:00:00Z' }, [source], {});
  for (const text of [payload.transcript, exported]) {
    for (const secret of ['secret', 'Prior', 'Candidate', '1234', 'Sam', 'Pat', 'corrections', 'suggestedProfileId'])
      assert.equal(text.includes(secret), false, secret);
  }
  const remote = parseTranscriptSegments(payload.transcript, 8);
  assert.equal(remote[0].speakerName, 'Alex');
  assert.equal(remote[0].speakerLocked, true);
});

test('final analysis keeps the number already displayed on a matched live row', async () => {
  const { normalizeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const { mergeSessionDiarization } = await import('../../src/utils/diarizationCompletion.ts');
  const live = normalizeTranscriptSegments([row('live', 'run1', 'speaker_0')]);
  const final = mergeSessionDiarization({ existing: live, seedLength: 0,
    unknownNumberHighWater: 1,
    segments: [{ ...row('final-id', 'run1', 'speaker_7'), text: 'live' }],
  });
  assert.equal(final.segments[0].unknownNumber, 1);
  assert.equal(final.segments[0].speaker, 'speaker_7');
});

test('JSON export retains the note counter after all rows are removed', async () => {
  const { formatJson } = require('../../src/helpers/transcriptFormatter.js');
  const note = { title: 'Empty meeting', created_at: '2026-01-01T00:00:00Z',
    transcript: JSON.stringify({ version: 2, unknownNumberHighWater: 9, rows: [] }) };
  const exported = JSON.parse(formatJson(note, [], {}));
  assert.equal(exported.unknownNumberHighWater, 9);
  assert.deepEqual(exported.transcriptRows, []);
});

test('two live rows split into different final clusters receive distinct Unknown numbers', async () => {
  const { normalizeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const { mergeSessionDiarization } = await import('../../src/utils/diarizationCompletion.ts');
  const live = normalizeTranscriptSegments([
    { ...row('a', 'run1'), text: 'first' },
    { ...row('b', 'run1'), text: 'second' },
  ]);
  const final = mergeSessionDiarization({ existing: live, seedLength: 0,
    unknownNumberHighWater: 1, segments: [
      { ...row('a', 'run1', 'speaker_1'), text: 'first' },
      { ...row('b', 'run1', 'speaker_2'), text: 'second' },
    ] });
  assert.notEqual(final.segments[0].unknownNumber, final.segments[1].unknownNumber);
  assert.deepEqual(final.segments.map((s) => s.unknownNumber), [1, 2]);
});

test('final abstention clears the prior name from the saved row', async () => {
  const { mergeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const previous = { ...row('a', 'run1'), speakerName: 'Alex', speakerStatus: 'confirmed',
    speakerIsPlaceholder: false };
  const final = { ...row('a', 'run1'), speakerName: undefined, speakerStatus: 'provisional',
    speakerIsPlaceholder: true };
  const [saved] = mergeTranscriptSegments([previous], [final]);
  assert.equal(saved.speakerName, undefined);
  assert.equal(saved.speakerIsPlaceholder, true);
});
