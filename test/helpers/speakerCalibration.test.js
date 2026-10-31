const test = require('node:test');
const assert = require('node:assert/strict');

test('owner calibration sweeps thresholds and recommends the strongest measured outcome', () => {
  const { sweepCalibration } = require('../../src/helpers/speakerCalibration');
  const rows = [
    { rowId: 'a', truePerson: 'A', bestName: 'A', bestScore: .8, runnerUpScore: .4, voicedSeconds: 2, overlapSeconds: 0, trueOverlap: false, currentLabel: 'A', corrected: false },
    { rowId: 'b', truePerson: 'B', bestName: 'B', bestScore: .62, runnerUpScore: .45, voicedSeconds: 2, overlapSeconds: 0, trueOverlap: false, currentLabel: 'B', corrected: true },
    { rowId: 'c', truePerson: 'B', bestName: 'A', bestScore: .57, runnerUpScore: .54, voicedSeconds: 2, overlapSeconds: 0, trueOverlap: false, currentLabel: 'B', corrected: true },
    { rowId: 'd', truePerson: 'A', bestName: 'A', bestScore: .8, runnerUpScore: .4, voicedSeconds: 2, overlapSeconds: .12, trueOverlap: true, currentLabel: null, corrected: false },
  ];
  const result = sweepCalibration(rows, 60, { similarityFloor: [.55, .6], runnerUpMargin: [.02, .05], minimumVoicedSeconds: [1.5], overlapToleranceSeconds: [.1, .2] });
  assert.equal(result.table.length, 8);
  assert.deepEqual(result.recommended, { similarityFloor: .6, runnerUpMargin: .05,
    minimumVoicedSeconds: 1.5, overlapToleranceSeconds: .1 });
  assert.equal(result.metrics.correctionsPerMinute, 2);
  assert.equal(result.table[0].overlapDetectionRate, 1);
});

test('app export preserves row identity, timing, label and correction provenance without inventing truth', () => {
  const { buildCalibrationLabels } = require('../../src/helpers/speakerCalibrationExport');
  const note = { transcript: JSON.stringify([{ id: 'row-a', text: 'Hello.', source: 'system',
    speakerName: 'Speaker A', audioSpan: { trackId: 'system', startSample: 24000, endSample: 48000 },
    finalRevision: { fromName: null, toName: 'Speaker A' } }]),
    speaker_action_log: JSON.stringify({ version: 1, actions: [{ kind: 'correction', id: 'one', sequence: 1,
      event: { actor: 'user', affectedRowIds: ['row-a'], snapshots: {
        'row-a': { previous: { speakerName: 'Speaker B' }, next: { speakerName: 'Speaker A' } } } } }] }) };
  const [row] = buildCalibrationLabels(note, { system: { file: 'system.wav', durationSeconds: 2 } }).rows;
  assert.equal(row.rowId, 'row-a');
  assert.equal(row.start, 1);
  assert.equal(row.end, 2);
  assert.equal(row.currentLabel, 'Speaker A');
  assert.equal(row.machineLabel, 'Speaker B');
  assert.equal(row.corrected, true);
  assert.deepEqual(row.ownerCorrectionActionIds, ['one']);
  assert.equal(row.finalPassChanged, true);
  assert.match(row.textHash, /^[0-9a-f]{64}$/);
  assert.equal(row.truePerson, null);
});
