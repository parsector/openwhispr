const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeLocalTranscriptState, readTranscriptDocument, writeTranscriptDocument, publicTranscript,
  normalizeRowIds, migrateTranscriptDocument,
} = require('../../src/helpers/transcriptDocument');

test('idless duplicate rows get unique stable IDs beside an already identified row', () => {
  const collidingId = normalizeRowIds([{ text: 'yes', source: 'system' }], 'durable-note')[0].id;
  const rows = [
    { id: collidingId, text: 'yes', source: 'system' },
    { text: 'yes', source: 'system' },
    { text: 'yes', source: 'system' },
  ];
  const first = normalizeRowIds(rows, 'durable-note');
  assert.equal(new Set(first.map((row) => row.id)).size, 3);
  assert.deepEqual(normalizeRowIds(first, 'durable-note'), first);
  assert.deepEqual(normalizeRowIds(rows, 'durable-note').map((row) => row.id), first.map((row) => row.id));
});

test('duplicate IDs already on disk are repaired once with an audit marker', () => {
  const raw = JSON.stringify([{ id: 'duplicate', text: 'first' }, { id: 'duplicate', text: 'second' }]);
  const repaired = migrateTranscriptDocument(raw, 'durable-note');
  assert.equal(new Set(repaired.rows.map((row) => row.id)).size, 2);
  assert.equal(repaired.rows[1].idRepair.previousId, 'duplicate');
  const again = migrateTranscriptDocument(writeTranscriptDocument(repaired.rows), 'durable-note');
  assert.deepEqual(again.rows.map((row) => row.id), repaired.rows.map((row) => row.id));
  assert.equal(again.rows[1].idRepair.previousId, 'duplicate');
});

test('merged clusters have one Unknown number and competing clusters get fresh numbers', () => {
  const rows = [
    { id: 'a', text: 'first', source: 'system', speaker: 'speaker_0', diarizationRunId: 'run', unknownNumber: 1 },
    { id: 'b', text: 'second', source: 'system', speaker: 'speaker_0', diarizationRunId: 'run', unknownNumber: 2 },
    { id: 'c', text: 'third', source: 'system', speaker: 'speaker_1', diarizationRunId: 'run2', unknownNumber: 1 },
  ];
  const resolved = readTranscriptDocument(writeTranscriptDocument(rows)).rows;
  assert.equal(resolved[0].unknownNumber, 1);
  assert.equal(resolved[1].unknownNumber, 1);
  assert.ok(resolved[2].unknownNumber > 2);
});

test('older-client cloud pull keeps explicit Unknown and local-only rows', () => {
  const local = writeTranscriptDocument([
    { id: 'a', text: 'hello', source: 'system', timestamp: 1, speaker: 'speaker_0',
      speakerIsPlaceholder: true, speakerLocked: true, speakerLockSource: 'user',
      corrections: [{ id: 'correction', rowId: 'a', actor: 'user', previous: {}, next: {} }] },
    { id: 'local-only', text: 'saved here', source: 'system', timestamp: 2 },
  ]);
  const cloud = JSON.stringify([{ text: 'hello', source: 'system', timestamp: 1,
    speaker: 'speaker_0', speakerName: 'Alex', speakerStatus: 'confirmed' }]);
  const rows = readTranscriptDocument(mergeLocalTranscriptState(cloud, local)).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'a');
  assert.equal(rows[0].speakerName, undefined);
  assert.equal(rows[0].speakerLockSource, 'user');
  assert.equal(rows[0].corrections[0].id, 'correction');
  assert.equal(rows[1].id, 'local-only');
});

test('one mic row keeps its Unknown number through five serialisations', () => {
  let raw = writeTranscriptDocument([{ id: 'mic-1', text: 'hello', source: 'mic' }]);
  for (let i = 0; i < 5; i++) {
    const doc = readTranscriptDocument(raw);
    assert.equal(doc.rows[0].unknownNumber, 1);
    assert.equal(doc.unknownNumberHighWater, 1);
    raw = writeTranscriptDocument(doc.rows, doc.unknownNumberHighWater);
  }
});

test('outbound transcript and JSON export hide a superseded prior name', () => {
  const { formatJson } = require('../../src/helpers/transcriptFormatter');
  const row = { id: 'a', text: 'hello', source: 'system', speaker: 'speaker_0',
    speakerName: 'Alex', speakerIsPlaceholder: true, unknownNumber: 1 };
  const cloud = publicTranscript(writeTranscriptDocument([row]));
  const exported = formatJson({ title: 'Meeting', created_at: '2026-01-01T00:00:00Z' },
    [row], { speaker_0: 'Alex' });
  assert.equal(cloud.includes('Alex'), false);
  assert.equal(exported.includes('Alex'), false);
});
