const test = require("node:test");
const assert = require("node:assert/strict");
const { sourceChipsByIndex } = require("../../src/components/todos/sourceChips.ts");

test("source chips map only live rows to their exact segment index", () => {
  const rows = [
    { id: "a", quote_segment_index: 2, status: "open" },
    { id: "b", quote_segment_index: 2, status: "proposed" },
    { id: "c", quote_segment_index: 3, status: "completed" },
    { id: "d", quote_segment_index: null, status: "open" },
    { id: "e", quote_segment_index: 0, status: "rejected" },
  ];
  const map = sourceChipsByIndex(rows);
  assert.deepEqual(map.get(2).map((row) => row.id), ["a", "b"]);
  assert.equal(map.has(3), false);
  assert.equal(map.has(0), false);
});
