const test = require("node:test");
const assert = require("node:assert/strict");
let completion;
let isMarkerOnly;
test.before(
  async () =>
    ({ completion, isMarkerOnly } = await import("../../src/helpers/routines/routineCompletion.js"))
);

test("finish_run confirms content or explicitly declares empty", () => {
  assert.deepEqual(
    completion({
      text: "Useful note",
      toolsAvailable: true,
      finishRun: { empty: false, headline: "Ready" },
    }),
    { status: "done", text: "Useful note", headline: "Ready" }
  );
  assert.equal(
    completion({ text: "ignored", toolsAvailable: true, finishRun: { empty: true } }).status,
    "empty"
  );
});

test("missing finish_run saves usable text as partial; no text fails", () => {
  assert.equal(completion({ text: "Useful note", toolsAvailable: true }).status, "partial");
  assert.equal(
    completion({ text: "<think>Only thinking</think>", toolsAvailable: true }).status,
    "failed"
  );
});

test("second marker uses same strict detector as the note summarizer", () => {
  for (const text of [
    "NOTHING_TO_REPORT",
    "**NOTHING_TO_REPORT**",
    "```markdown\nNOTHING_TO_REPORT\n```",
    "No meetings.\nNOTHING_TO_REPORT",
    "<think>analysis</think>\nNOTHING_TO_REPORT",
  ]) {
    assert.equal(isMarkerOnly(text, "NOTHING_TO_REPORT"), true, text);
    assert.equal(completion({ text, toolsAvailable: false }).status, "empty");
  }
  for (const text of [
    "## Summary\nUseful item\nNOTHING_TO_REPORT",
    "- NOTHING_TO_REPORT",
    "<think>NOTHING_TO_REPORT</think>\nUseful note",
  ]) {
    assert.equal(isMarkerOnly(text, "NOTHING_TO_REPORT"), false, text);
  }
});
