const test = require("node:test");
const assert = require("node:assert/strict");

test("generated summary hash detects only subsequent summary edits", async () => {
  const { makeContentHash, materialHashOf, summaryWasHandEdited, withSummaryHash } =
    await import("../../src/lib/noteSummaryHash.ts");
  const material = makeContentHash("notes\ntranscript");
  const stored = withSummaryHash(material, "Generated summary");
  assert.equal(materialHashOf(stored), material);
  assert.equal(summaryWasHandEdited("Generated summary", stored), false);
  assert.equal(summaryWasHandEdited("Hand edited summary", stored), true);
  assert.equal(summaryWasHandEdited(null, stored), false);
  assert.equal(summaryWasHandEdited("Generated summary", material), false);
});
