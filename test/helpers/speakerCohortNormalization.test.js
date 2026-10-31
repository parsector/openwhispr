const test = require('node:test');
const assert = require('node:assert/strict');
const { rankProfiles } = require('../../src/helpers/speakerCohortNormalization');
const v = (x, y) => Float32Array.from({ length: 512 }, (_, i) => i === 0 ? x : i === 1 ? y : 0);
const cosine = (a, b) => a[0] * b[0] + a[1] * b[1];

test('recording cohort separates a room-wide match from a distinctive voice', () => {
  const profiles = [{ id: 'A', embedding: v(.9, -.435) }, { id: 'B', embedding: v(.95, .312) }];
  const result = rankProfiles(v(1, 0), [v(.7, .714)], profiles, cosine);
  assert.equal(result.rawBest.id, 'B');
  assert.equal(result.cohortBest.id, 'A');
  assert.equal(result.changed, true);
});

test('without another voice in the recording, cohort ranking is raw ranking', () => {
  const profiles = [{ id: 'A', embedding: v(.9, -.435) }, { id: 'B', embedding: v(.95, .312) }];
  const result = rankProfiles(v(1, 0), [], profiles, cosine);
  assert.equal(result.cohortBest.id, 'B');
  assert.equal(result.changed, false);
});
