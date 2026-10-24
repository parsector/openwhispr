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

test("Cursor normalizes init, deltas, tools and terminal error without duplicate buffered text", () => {
  const { createStreamParser } = require("../../../src/services/agents/streamJson");
  const parser = createStreamParser("cursor-agent");
  const values = [
    { type: "system", subtype: "init", model: "auto", session_id: "s" },
    { type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "Hello" }] } },
    {
      type: "assistant",
      timestamp_ms: 2,
      message: { content: [{ type: "text", text: " world" }] },
    },
    {
      type: "assistant",
      model_call_id: "m",
      message: { content: [{ type: "text", text: "Hello world" }] },
    },
    { type: "tool_call", subtype: "started", tool_call: { readToolCall: { path: "src/x.ts" } } },
    { type: "tool_call", subtype: "started", tool_call: { writeToolCall: { path: "src/y.ts" } } },
    {
      type: "tool_call",
      subtype: "started",
      tool_call: { shellToolCall: { command: "git status" } },
    },
    { type: "tool_call", subtype: "completed", tool_call: { shellToolCall: {} } },
    { type: "result", is_error: true, result: "failed", duration_ms: 12, session_id: "s" },
  ];
  parser.feed(values.map((value) => JSON.stringify(value)).join("\n") + "\n");
  assert.deepEqual(
    parser.steps.map((event) => event.kind),
    ["init", "text", "text", "tool", "tool", "tool", "tool_result", "result"]
  );
  assert.equal(
    parser.steps
      .filter((event) => event.kind === "text")
      .map((event) => event.text)
      .join(""),
    "Hello world"
  );
  assert.deepEqual(
    parser.steps.filter((event) => event.kind === "tool").map((event) => event.summary),
    ["Read src/x.ts", "Wrote src/y.ts", "Ran git status"]
  );
  assert.equal(parser.steps.at(-1).is_error, true);
  assert.equal(parser.steps[0].model, "auto");
});

test("Cursor tolerates garbage, future subtype and caps lines and steps", () => {
  const { createCursorStreamJson } = require("../../../src/services/agents/streamJson");
  const parser = createCursorStreamJson();
  parser.feed('garbage\n{"type":"tool_call","subtype":"future"}\n');
  assert.deepEqual(
    parser.steps.map((event) => event.kind),
    ["unknown", "unknown"]
  );
  parser.feed("x".repeat(MAX_LINE + 1) + "\n");
  assert.equal(parser.steps[2].truncated, true);
  parser.feed("garbage\n".repeat(205));
  assert.equal(parser.steps.length, 200);
});

test("parser factory preserves Claude event mapping", () => {
  const { createStreamParser } = require("../../../src/services/agents/streamJson");
  const parser = createStreamParser("claude");
  parser.feed(fixture);
  assert.deepEqual(
    parser.steps.map((event) => event.kind),
    ["init", "text", "tool", "tool_result", "result"]
  );
});
