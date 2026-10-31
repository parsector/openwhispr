const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateSpeakerAccuracy } = require("../../scripts/lib/speaker-accuracy-eval");

test("labelled rows score correct people, abstention, overlap, changes and correction effort", () => {
  const result = evaluateSpeakerAccuracy([
    { rowId: "a", person: "Alex", overlap: false },
    { rowId: "b", person: "Sam", overlap: false },
    { rowId: "c", person: "Alex", overlap: true },
  ], [
    { id: "a", speakerName: "Alex", changedAfterFinal: true },
    { id: "b", speakerIsPlaceholder: true },
    { id: "c", speakerIsPlaceholder: true, uncertainty: { reason: "overlapping_speech" } },
  ], 120, [{ kind: "correction" }, { kind: "split" }]);
  assert.equal(result.rates.rightPersonAfterFinal, 0.5);
  assert.equal(result.rates.refusal, 2 / 3);
  assert.equal(result.rates.overlapDetection, 1);
  assert.equal(result.rates.finalPassChange, 1 / 3);
  assert.equal(result.rates.correctionsPerMinute, 1);
});

test("correction effort is unavailable without a reviewed action log", () => {
  const result = evaluateSpeakerAccuracy([{ rowId: "a", person: "Alex" }],
    [{ id: "a", speakerName: "Alex" }], 60);
  assert.equal(result.rates.correctionsPerMinute, null);
});
