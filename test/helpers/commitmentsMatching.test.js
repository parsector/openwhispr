const test = require("node:test");
const assert = require("node:assert/strict");
const { normaliseText, tokenSimilarity, shouldMerge, matchCompletion } = require("../../src/helpers/commitments/matching");

test("normalises filler, promise wording and politeness", () => {
  assert.equal(normaliseText("Um, I'll send the deck to Alex, please."), "send the deck to Alex");
});
test("a repeated commitment across three meetings merges", () => {
  const first = { text: "I will send the deck to Alex", person: "Alex", status: "open" };
  const second = { text: "I'll send the deck to Alex", person: "Alex", status: "open" };
  const third = { text: "Send the deck to Alex", person: "Alex", status: "open" };
  assert.ok(shouldMerge(first, second));
  assert.ok(shouldMerge(first, third));
});
test("completed prior row does not merge", () => {
  assert.equal(shouldMerge({ text: "send deck to Alex", person: "Alex", status: "completed" },
    { text: "send deck to Alex", person: "Alex" }), false);
});
test("different object does not merge", () => {
  assert.ok(tokenSimilarity("send the deck to Alex", "send pricing to Alex") < 0.75);
});
test("two people remain one person set", () => {
  assert.ok(shouldMerge({ text: "share report", person: '["Alex","Sam"]', status: "open" },
    { text: "share report", person: ["Sam", "Alex"] }));
});
test("completion requires an open matching row and person", () => {
  const row = { text: "send the deck to Alex", person: "Alex", status: "open" };
  assert.equal(matchCompletion("I sent the deck to Alex", [row], "Alex"), row);
  assert.equal(matchCompletion("I sent the deck to Alex", [row], "Sam"), null);
});
