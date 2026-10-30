const test = require('node:test');
const assert = require('node:assert/strict');

const row = (id, speaker = 'speaker_0', text = id) => ({ id, source: 'system', speaker, text, timestamp: Number(id.slice(1)) || 0 });

test('row id survives save, reload, and text edit', async () => {
  const { parseTranscriptSegments } = await import('../../src/utils/parseTranscriptSegments.ts');
  const { serializeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const legacy = parseTranscriptSegments(JSON.stringify([{ text: 'hello', source: 'system' }]));
  assert.ok(legacy[0].id && !legacy[0].id.startsWith('stored-'));
  const saved = serializeTranscriptSegments([{ ...legacy[0], text: 'edited' }]);
  assert.equal(parseTranscriptSegments(saved)[0].id, legacy[0].id);
  assert.equal(parseTranscriptSegments(saved)[0].text, 'edited');
});

test('undo restores exactly the touched rows', async () => {
  const { correctTranscriptRows, undoTranscriptCorrection } = await import('../../src/utils/transcriptCorrections.ts');
  const initial = [row('r1'), row('r2'), row('r3')];
  const corrected = correctTranscriptRows(initial, new Set(['r1', 'r2']), 'selected', 'Alex');
  const restored = undoTranscriptCorrection(corrected, corrected[0].corrections[0].id);
  assert.deepEqual(restored, initial);
});

test('undo after an unrelated later correction preserves that correction', async () => {
  const { correctTranscriptRows, undoTranscriptCorrection } = await import('../../src/utils/transcriptCorrections.ts');
  const initial = [row('r1'), row('r2')];
  const first = correctTranscriptRows(initial, new Set(['r1']), 'row', 'Alex');
  const second = correctTranscriptRows(first, new Set(['r2']), 'row', 'Sam');
  const restored = undoTranscriptCorrection(second, first[0].corrections[0].id);
  assert.deepEqual(restored[0], initial[0]);
  assert.equal(restored[1].speakerName, 'Sam');
});

test('correction survives re-transcription and recycled cluster id does not inherit it', async () => {
  const { correctTranscriptRows } = await import('../../src/utils/transcriptCorrections.ts');
  const { mergeTranscriptSegments, resolveSegmentSpeakerName } = await import('../../src/utils/transcriptSpeakerState.ts');
  const previous = correctTranscriptRows([row('r1')], new Set(['r1']), 'row', 'Alex');
  const merged = mergeTranscriptSegments(previous, [{...row('new', 'speaker_0', 'changed words'), timestamp: 1, diarizationRunId: 'run2'}]);
  assert.equal(merged.find(s => s.id === 'r1').speakerName, 'Alex');
  assert.equal(merged.find(s => s.id === 'r1').text, 'r1');
  assert.ok(merged.some(s => s.id === 'new' && s.text === 'changed words' && !s.corrections));
  const newRow = {...row('r3', 'speaker_0'), diarizationRunId: 'run2'};
  assert.equal(resolveSegmentSpeakerName(newRow, { speaker_0: 'Alex' }), undefined);
});

test('different ids never acquire a correction from identical text or a nearby changed phrase', async () => {
  const { correctTranscriptRows } = await import('../../src/utils/transcriptCorrections.ts');
  const { mergeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  for (const [text, timestamp] of [['yes', 100], ['different words', 1.3]]) {
    const old = correctTranscriptRows([{ ...row('r1', 'speaker_0', 'yes'), timestamp: 1 }], new Set(['r1']), 'row', 'Alex');
    const merged = mergeTranscriptSegments(old, [{ ...row('other', 'speaker_0', text), timestamp }]);
    assert.equal(merged.find(s => s.id === 'r1').speakerName, 'Alex');
    assert.equal(merged.find(s => s.id === 'r1').text, 'yes');
    assert.equal(merged.some(s => s.id === 'other' && !s.corrections && !s.speakerLocked), true,
      'a different row remains independently unassessed');
  }
  const correctedIncoming = correctTranscriptRows(
    [{ ...row('incoming', 'speaker_0', 'yes'), timestamp: 1 }],
    new Set(['incoming']), 'row', 'Alex'
  );
  const mergedIncoming = mergeTranscriptSegments(
    [{ ...row('existing', 'speaker_0', 'yes'), timestamp: 1 }], correctedIncoming
  );
  assert.equal(mergedIncoming.find(s => s.id === 'existing').corrections, undefined);
  assert.equal(mergedIncoming.find(s => s.id === 'incoming').speakerName, 'Alex');
});

test('counter id migration rewrites matching references and quarantines unresolved ones', async () => {
  const { parseTranscriptSegmentsWithMigration } = await import('../../src/utils/parseTranscriptSegments.ts');
  const { serializeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const correction = { id: 'c1', rowId: 'seg-1', scope: 'row', actor: 'user', timestamp: '2026-01-01', previous: {}, next: { speakerName: 'Alex' } };
  const raw = JSON.stringify([{ id: 'seg-1', text: 'yes', source: 'system', speakerName: 'Alex', corrections: [correction, { ...correction, id: 'c2', rowId: 'missing' }] }]);
  const first = parseTranscriptSegmentsWithMigration(raw, 42);
  const repeated = parseTranscriptSegmentsWithMigration(raw, 42);
  assert.equal(repeated.segments[0].id, first.segments[0].id);
  assert.match(first.segments[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(first.segments[0].corrections.length, 1);
  assert.equal(first.segments[0].corrections[0].rowId, first.segments[0].id);
  assert.equal(first.segments[0].speakerName, 'Alex');
  assert.equal(first.quarantinedCorrections, 1);
  assert.equal(first.segments[0].quarantinedCorrections[0].rowId, 'missing');
  const second = parseTranscriptSegmentsWithMigration(serializeTranscriptSegments(first.segments), 42);
  assert.deepEqual(second.segments.map(s => [s.id, s.corrections?.[0]?.rowId]), first.segments.map(s => [s.id, s.corrections?.[0]?.rowId]));
  assert.equal(second.quarantinedCorrections, 0);
  assert.equal(second.segments[0].quarantinedCorrections[0].rowId, 'missing');
});

test('migration rewrites every selection reference and keeps ambiguous evidence for review', async () => {
  const { parseTranscriptSegmentsWithMigration } = await import('../../src/utils/parseTranscriptSegments.ts');
  const { serializeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const correction = { id: 'c1', rowId: 'seg-1', scope: 'selected', actor: 'user', timestamp: '2026-01-01',
    previous: {}, next: {}, affectedRowIds: ['seg-1', 'seg-2'], target: { rowIds: ['seg-1', 'seg-2'] },
    snapshots: { 'seg-1': { previous: {}, next: {} }, 'seg-2': { previous: {}, next: {} } } };
  const raw = JSON.stringify([
    { id: 'seg-1', text: 'one', source: 'system', corrections: [correction,
      { ...correction, id: 'ambiguous', affectedRowIds: ['missing'] }] },
    { id: 'seg-2', text: 'two', source: 'system' },
  ]);
  const first = parseTranscriptSegmentsWithMigration(raw, 42);
  const [a, b] = first.segments;
  assert.deepEqual(a.corrections[0].affectedRowIds, [a.id, b.id]);
  assert.deepEqual(a.corrections[0].target.rowIds, [a.id, b.id]);
  assert.deepEqual(Object.keys(a.corrections[0].snapshots), [a.id, b.id]);
  assert.equal(a.quarantinedCorrections[0].id, 'ambiguous');
  const reloaded = parseTranscriptSegmentsWithMigration(serializeTranscriptSegments(first.segments), 42);
  assert.equal(reloaded.segments[0].quarantinedCorrections[0].id, 'ambiguous');
});

test('cluster correction records carry note, run, and cluster identity', async () => {
  const { correctTranscriptRows } = await import('../../src/utils/transcriptCorrections.ts');
  const rows = [{ ...row('r1'), diarizationRunId: 'run1' }, { ...row('r2'), diarizationRunId: 'run2' }];
  const result = correctTranscriptRows(rows, new Set(['r1', 'r2']), 'cluster', 'Alex', undefined, 42, 'run1', 'speaker_0');
  assert.equal(result[0].corrections[0].noteId, 42);
  assert.equal(result[0].corrections[0].clusterId, 'speaker_0');
  assert.equal(result[1].corrections, undefined);
});

test('ambiguous time-only matches do not move a correction to another row', async () => {
  const { correctTranscriptRows } = await import('../../src/utils/transcriptCorrections.ts');
  const { mergeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const existing = correctTranscriptRows([
    { ...row('r1'), timestamp: 10 },
    { ...row('r2'), timestamp: 10.2 },
  ], new Set(['r1']), 'row', 'Alex');
  const merged = mergeTranscriptSegments(existing, [{ ...row('new'), timestamp: 10.1, text: 'different words' }]);
  assert.equal(merged.find((entry) => entry.id === 'r1').speakerName, 'Alex');
  assert.ok(merged.some((entry) => entry.text === 'different words' && entry.id !== 'r1'));
});

test('placeholder numbers stay stable when a cluster splits', async () => {
  const { normalizeTranscriptSegments, mergeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const initial = normalizeTranscriptSegments([row('r1'), row('r2'), row('r3', 'speaker_1')]);
  const split = mergeTranscriptSegments(initial, [{...initial[1], speaker: 'speaker_2', diarizationRunId: 'run2'}]);
  assert.equal(split.find(s => s.id === 'r1').unknownNumber, 1);
  assert.equal(split.find(s => s.id === 'r3').unknownNumber, 2);
  assert.equal(split.find(s => s.id === 'r2').unknownNumber, 3);
});

test('a recycled cluster id in a new run gets a new placeholder number', async () => {
  const { normalizeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const rows = normalizeTranscriptSegments([
    { ...row('r1'), diarizationRunId: 'run1', unknownNumber: 1 },
    { ...row('r2'), diarizationRunId: 'run2' },
  ]);
  assert.deepEqual(rows.map((entry) => entry.unknownNumber), [1, 2]);
});

test('deleting the highest numbered row does not reuse its placeholder', async () => {
  const { normalizeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const first = normalizeTranscriptSegments([row('r1'), row('r2', 'speaker_1')]);
  const afterRemoval = normalizeTranscriptSegments([first[0], row('r3', 'speaker_2')]);
  assert.deepEqual(afterRemoval.map((entry) => entry.unknownNumber), [1, 3]);
  assert.equal(afterRemoval[0].unknownNumberHighWater, 3);
});

test('explicit unknown is user locked and blocks a recycled cluster mapping', async () => {
  const { correctTranscriptRows } = await import('../../src/utils/transcriptCorrections.ts');
  const { resolveSegmentSpeakerName, mergeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const unknown = correctTranscriptRows([row('r1')], new Set(['r1']), 'row', null)[0];
  assert.equal(unknown.speakerLockSource, 'user');
  assert.equal(unknown.speakerIsPlaceholder, true);
  assert.equal(resolveSegmentSpeakerName(unknown, { speaker_0: 'Alex' }), undefined);
  const afterFinal = mergeTranscriptSegments([unknown], [{ ...row('r1'), speakerName: 'Sam', diarizationRunId: 'run2' }]);
  assert.equal(afterFinal[0].speakerName, undefined);
  assert.equal(afterFinal[0].speakerLockSource, 'user');
});

test('undoing an older correction keeps a newer correction on the same row', async () => {
  const { correctTranscriptRows, undoTranscriptCorrection } = await import('../../src/utils/transcriptCorrections.ts');
  const first = correctTranscriptRows([row('r1')], new Set(['r1']), 'row', 'Alex');
  const second = correctTranscriptRows(first, new Set(['r1']), 'row', 'Sam');
  const result = undoTranscriptCorrection(second, first[0].corrections[0].id);
  assert.equal(result[0].speakerName, 'Sam');
  const restored = undoTranscriptCorrection(result, result[0].corrections[0].id);
  assert.equal(restored[0].speakerName, undefined);
});
