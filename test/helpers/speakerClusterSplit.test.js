const test = require("node:test");
const assert = require("node:assert/strict");
const { partitionClusterByVoice } = require("../../src/helpers/speakerClusterSplit");

test("a contrasting seed partitions a mixed cluster using local voice evidence", () => {
  const embeddings = new Map([
    ["a", Float32Array.from([1, 0])],
    ["b", Float32Array.from([0, 1])],
    ["c", Float32Array.from([0.1, 0.9])],
    ["d", Float32Array.from([0.9, 0.1])],
  ]);
  const plan = partitionClusterByVoice(["a", "b", "c", "d"], ["b"], embeddings);
  assert.deepEqual(plan.movedIds, ["b", "c"]);
  assert.deepEqual(plan.retainedIds, ["a", "d"]);
  assert.equal(plan.acousticRows, 1);
});

test("without two usable voice anchors only the reviewed rows move", () => {
  const plan = partitionClusterByVoice(["a", "b", "c"], ["b"], new Map());
  assert.deepEqual(plan.movedIds, ["b"]);
  assert.equal(plan.acousticRows, 0);
});
