const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStreamJson, MAX_LINE } = require("../../../src/services/agents/streamJson");

// Synthetic fixture of documented --output-format stream-json events; owner capture replaces it later.
const fixture = fs.readFileSync(
  path.join(__dirname, "../../fixtures/claude-stream.synthetic.jsonl"),
  "utf8"
);
test("parses documented events across partial chunks", () => {
  const events = [];
  const parser = createStreamJson((event) => events.push(event));
  for (let index = 0; index < fixture.length; index += 7)
    parser.feed(fixture.slice(index, index + 7));
  parser.end();
  assert.deepEqual(
    events.map((event) => event.kind),
    ["init", "text", "tool", "tool_result", "result"]
  );
  assert.equal(events[2].summary, "Read src/x.ts");
  assert.equal(events[4].duration_ms, 1234);
});
test("garbage and unknown types remain harmless", () => {
  const events = [];
  const parser = createStreamJson((event) => events.push(event));
  parser.feed('garbage\n{"type":"future"}\n');
  assert.deepEqual(
    events.map((event) => event.kind),
    ["unknown", "unknown"]
  );
});
test("caps huge lines and rolling steps", () => {
  const parser = createStreamJson();
  parser.feed("x".repeat(MAX_LINE + 1) + "\n");
  assert.equal(parser.steps[0].truncated, true);
  parser.feed("garbage\n".repeat(205));
  assert.equal(parser.steps.length, 200);
});
test("error result is preserved", () => {
  const parser = createStreamJson();
  parser.feed('{"type":"result","is_error":true,"result":"failed"}\n');
  assert.equal(parser.steps[0].is_error, true);
});
