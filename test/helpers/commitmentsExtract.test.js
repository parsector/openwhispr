const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { extractCommitments, windows, MARKER } = require("../../src/helpers/commitments/extract");
const { CommitmentStore } = require("../../src/helpers/commitments/store");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-todos-extract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => dir, isReady: () => false } };
    return original.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = original; });
  delete require.cache[require.resolve("../../src/helpers/database")];
  const db = new (require("../../src/helpers/database"))();
  t.after(() => db.db.close());
  return db;
}
const segments = [
  { text: "I'll send the deck to Alex by Friday.", speaker: "you", source: "mic" },
  { text: "I will schedule the review with Sam.", speaker: "you", source: "mic" },
  { text: "Alex will provide the figures to us.", speaker: "speaker_1", source: "system" },
  { text: "I'll send the deck to Alex.", speaker: "you", source: "mic" },
  { text: "I sent the deck to Alex.", speaker: "you", source: "mic" },
];
const items = [
  { text: "send the deck to Alex", quote: segments[0].text, segment_index: 0, person: "Alex", direction: "owe", due_raw: "Friday", kind: "new" },
  { text: "schedule the review with Sam", quote: segments[1].text, segment_index: 1, person: "Sam", direction: "owe", kind: "new" },
  { text: "provide the figures to us", quote: segments[2].text, segment_index: 2, person: "Alex", direction: "waiting", kind: "new" },
  { text: "send the deck to Alex", quote: segments[3].text, segment_index: 3, person: "Alex", direction: "owe", kind: "new" },
  { text: "sent the deck to Alex", quote: segments[4].text, segment_index: 4, person: "Alex", kind: "completion", strength: "explicit" },
  { text: "send a false item", quote: "invented quote", segment_index: 8, kind: "new" },
];
const note = { id: 42, title: "Team meeting", created_at: "2026-10-28T12:00:00Z", transcript: JSON.stringify(segments) };

test("extractor persists three todos, restatement and completion proposal", async (t) => {
  const db = setup(t);
  let calls = 0;
  const infer = async ({ responseFormat }) => { calls++; assert.equal(responseFormat.type, "json_object"); return JSON.stringify({ items }); };
  const result = await extractCommitments({ note, database: db, model: { mode: "local", model: "mock" }, infer });
  assert.equal(calls, 1);
  assert.deepEqual(result, { created: 3, proposals: 1, skipped: false });
  const store = new CommitmentStore(db);
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitments").get().n, 3);
  assert.deepEqual([...new Set(store.list().map((row) => row.source))], ["meeting"]);
  assert.ok(store.list().every((row) => row.source_agent === null));
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitment_mentions").get().n, 5);
  assert.equal(store.proposals(42).length, 1);
  assert.equal(db.db.prepare("SELECT mention_count FROM commitments WHERE person='Alex' AND direction='owe'").get().mention_count, 2);
  const proposalId = store.proposals(42)[0].id;
  await extractCommitments({ note, database: db, model: { mode: "local", model: "mock" }, infer });
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitments").get().n, 3);
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitment_mentions").get().n, 5);
  assert.equal(store.proposals(42).length, 1);
  assert.equal(store.proposals(42)[0].id, proposalId);
});

test("malformed later model window persists zero rows", async (t) => {
  const db = setup(t);
  const longNote = { ...note, transcript: JSON.stringify([
    { text: "I will send the deck to Alex. " + "x".repeat(7900) },
    { text: "I will schedule the review with Sam. " + "x".repeat(200) },
  ]) };
  let calls = 0;
  await assert.rejects(extractCommitments({ note: longNote, database: db,
    model: { mode: "local", model: "mock" }, infer: async () => ++calls === 1 ? JSON.stringify({ items: [] }) : "broken" }));
  assert.ok(calls > 1);
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitments").get().n, 0);
});

test("cloud response requires completion marker", () => {
  assert.throws(() => require("../../src/helpers/commitments/extract").parseResponse('{"items":[]}', false));
  assert.deepEqual(require("../../src/helpers/commitments/extract").parseResponse(`{"items":[]}${MARKER}`, false), []);
});

test("windows overlap one segment and preserve source indexes", () => {
  const parts = windows([{ text: "a".repeat(4) }, { text: "b".repeat(4) }, { text: "c".repeat(4) }], 10);
  assert.deepEqual(parts.map((part) => part.map((entry) => entry.segment_index)), [[0, 1], [1, 2]]);
});

test("parseable segments retain indexes across malformed entries", () => {
  const { parseSegments } = require("../../src/helpers/commitments/extract");
  const parsed = parseSegments(JSON.stringify([{ text: "First" }, null, { text: "Third" }]));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[2].text, "Third");
});
