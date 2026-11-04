const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { extractCommitments, windows, MARKER } = require("../../src/helpers/commitments/extract");
const { CommitmentStore } = require("../../src/helpers/commitments/store");
const { resolveExtractionModel } = require("../../src/helpers/commitments/extractionModel");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-todos-extract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => dir, isReady: () => false } };
    return original.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = original;
  });
  delete require.cache[require.resolve("../../src/helpers/database")];
  const db = new (require("../../src/helpers/database"))();
  db.commitmentsTestDir = dir;
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
  {
    text: "send the deck to Alex",
    quote: segments[0].text,
    segment_index: 0,
    person: "Alex",
    direction: "owe",
    due_raw: "Friday",
    kind: "new",
  },
  {
    text: "schedule the review with Sam",
    quote: segments[1].text,
    segment_index: 1,
    person: "Sam",
    direction: "owe",
    kind: "new",
  },
  {
    text: "provide the figures to us",
    quote: segments[2].text,
    segment_index: 2,
    person: "Alex",
    direction: "waiting",
    kind: "new",
  },
  {
    text: "send the deck to Alex",
    quote: segments[3].text,
    segment_index: 3,
    person: "Alex",
    direction: "owe",
    kind: "new",
  },
  {
    text: "sent the deck to Alex",
    quote: segments[4].text,
    segment_index: 4,
    person: "Alex",
    kind: "completion",
    strength: "explicit",
  },
  { text: "send a false item", quote: "invented quote", segment_index: 8, kind: "new" },
];
const note = {
  id: 42,
  title: "Team meeting",
  created_at: "2026-10-28T12:00:00Z",
  transcript: JSON.stringify(segments),
};

test("self-hosted extraction runs with endpoint tool calling disabled", async (t) => {
  const db = setup(t);
  let calls = 0;
  const result = await extractCommitments({
    note,
    database: db,
    model: {
      mode: "self-hosted",
      provider: "lan",
      remoteUrl: "https://inference.aimaterialhub.com/v1",
      model: "deepseek-v4.1-flash:1017-cloud",
      supportsToolCalls: false,
    },
    infer: async ({ model, responseFormat }) => {
      calls++;
      assert.equal(model.supportsToolCalls, false);
      assert.equal(responseFormat, undefined);
      return JSON.stringify({ items: [] }) + MARKER;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { created: 0, proposals: 0, skipped: false, reason: "empty_items" });
});

test("extraction uses the configured self-hosted chat model without a routine override", async (t) => {
  const db = setup(t);
  const chat = {
    mode: "self-hosted",
    provider: "custom",
    remoteUrl: "https://models.example/v1",
    model: "chat-only-model",
    supportsToolCalls: false,
  };
  const selection = resolveExtractionModel(null, chat);
  assert.equal(selection.source, "chat-model");
  const result = await extractCommitments({
    note,
    database: db,
    ...selection,
    infer: async ({ model }) => {
      assert.equal(model, chat);
      return JSON.stringify({ items: [items[0]] }) + MARKER;
    },
  });
  assert.equal(result.created, 1);
  const log = JSON.parse(
    fs.readFileSync(path.join(db.commitmentsTestDir, "logs", "commitments-extract.log"), "utf8")
  );
  assert.equal(log.model_provider, "custom");
  assert.equal(log.model_id, "chat-only-model");
  assert.equal(log.model_source, "chat-model");
});

test("extraction skips with no configured model and prefers an explicit routine choice", async (t) => {
  const db = setup(t);
  const missing = resolveExtractionModel(null, null);
  let called = false;
  const skipped = await extractCommitments({
    note,
    database: db,
    ...missing,
    infer: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
  assert.deepEqual(skipped, { created: 0, proposals: 0, skipped: true, reason: "no_model" });
  const routine = { mode: "local", provider: "local", model: "routine-model" };
  assert.deepEqual(resolveExtractionModel(routine, { model: "chat-model" }), {
    model: routine,
    source: "routine-choice",
  });
  assert.equal(resolveExtractionModel({ ...routine, routineOverride: false }, null).model, null);
});

test("extractor persists three todos, restatement and completion proposal", async (t) => {
  const db = setup(t);
  let calls = 0;
  const infer = async ({ responseFormat }) => {
    calls++;
    assert.equal(responseFormat.type, "json_object");
    return JSON.stringify({ items });
  };
  const result = await extractCommitments({
    note,
    database: db,
    model: { mode: "local", model: "mock" },
    infer,
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { created: 3, proposals: 1, skipped: false });
  const store = new CommitmentStore(db);
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitments").get().n, 3);
  assert.deepEqual([...new Set(store.list().map((row) => row.source))], ["meeting"]);
  assert.ok(store.list().every((row) => row.source_agent === null));
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitment_mentions").get().n, 5);
  assert.equal(store.proposals(42).length, 1);
  assert.equal(
    db.db
      .prepare("SELECT mention_count FROM commitments WHERE person='Alex' AND direction='owe'")
      .get().mention_count,
    2
  );
  const proposalId = store.proposals(42)[0].id;
  await extractCommitments({ note, database: db, model: { mode: "local", model: "mock" }, infer });
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitments").get().n, 3);
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitment_mentions").get().n, 5);
  assert.equal(store.proposals(42).length, 1);
  assert.equal(store.proposals(42)[0].id, proposalId);
});

test("malformed later model window persists zero rows", async (t) => {
  const db = setup(t);
  const longNote = {
    ...note,
    transcript: JSON.stringify([
      { text: "I will send the deck to Alex. " + "x".repeat(7900) },
      { text: "I will schedule the review with Sam. " + "x".repeat(200) },
    ]),
  };
  let calls = 0;
  await assert.rejects(
    extractCommitments({
      note: longNote,
      database: db,
      model: { mode: "local", model: "mock" },
      infer: async () => (++calls === 1 ? JSON.stringify({ items: [] }) : "broken"),
    })
  );
  assert.ok(calls > 1);
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitments").get().n, 0);
});

test("cloud response accepts JSON with or without completion marker", () => {
  assert.deepEqual(
    require("../../src/helpers/commitments/extract").parseResponse('{"items":[]}', false),
    []
  );
  assert.deepEqual(
    require("../../src/helpers/commitments/extract").parseResponse(`{"items":[]}${MARKER}`, false),
    []
  );
});

test("fenced and prose-wrapped JSON both create a todo", async (t) => {
  const db = setup(t);
  for (const body of [
    `\`\`\`json\n${JSON.stringify({ items: [items[0]] })}\n\`\`\``,
    `Here are the actions: ${JSON.stringify({ items: [items[0]] })} Thanks.`,
  ]) {
    const result = await extractCommitments({
      note,
      database: db,
      model: { mode: "local", model: "mock" },
      infer: async () => body,
    });
    assert.equal(result.created, 1);
  }
});

test("raw JSON, HTTP failure, empty items, and malformed envelopes have distinct outcomes", async (t) => {
  const db = setup(t);
  const options = { note, database: db, model: { mode: "local", model: "mock" } };
  assert.equal(
    (
      await extractCommitments({
        ...options,
        infer: async () => JSON.stringify({ items: [items[0]] }),
      })
    ).created,
    1
  );
  await assert.rejects(
    extractCommitments({
      ...options,
      infer: async () => {
        const error = new Error("HTTP 500");
        error.status = 500;
        throw error;
      },
    }),
    (error) => error.reason === "http_error"
  );
  assert.equal(
    (await extractCommitments({ ...options, infer: async () => '{"items":[]}' })).reason,
    "empty_items"
  );
  assert.equal(new CommitmentStore(db).list().length, 1);
  await assert.rejects(
    extractCommitments({ ...options, infer: async () => '{"other":[]}' }),
    (error) => error.reason === "invalid_response"
  );
  await assert.rejects(
    extractCommitments({ ...options, infer: async () => "not JSON" }),
    (error) => error.reason === "invalid_response"
  );
  const log = fs
    .readFileSync(path.join(db.commitmentsTestDir, "logs", "commitments-extract.log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(log.length, 5);
  assert.deepEqual(
    log.map((entry) => entry.skip_reason),
    [null, "http_error", "empty_items", "invalid_response", "invalid_response"]
  );
  assert.equal(log[1].http_status, 500);
  assert.equal(log[4].raw_response_length, "not JSON".length);
  assert.ok(log[4].raw_response_snippet.length <= 300);
  assert.ok(log.every((entry) => !JSON.stringify(entry).includes(segments[0].text)));
});

test("punctuation and diacritics in a neighbouring quote still anchor a todo", async (t) => {
  const db = setup(t);
  const result = await extractCommitments({
    note: {
      ...note,
      transcript: JSON.stringify([
        { text: "We discussed the plan." },
        { text: "I'll prepare the café-demo tomorrow." },
      ]),
    },
    database: db,
    model: { mode: "local", model: "mock" },
    infer: async () =>
      JSON.stringify({
        items: [
          {
            text: "prepare the cafe demo",
            quote: "I'll prepare the cafe demo tomorrow",
            segment_index: 0,
            kind: "new",
          },
        ],
      }),
  });
  assert.equal(result.created, 1);
  assert.equal(new CommitmentStore(db).list()[0].quote_segment_index, 1);
});

test("completion-only re-extraction preserves the existing todo and proposes completion", async (t) => {
  const db = setup(t);
  const base = { note, database: db, model: { mode: "local", model: "mock" } };
  await extractCommitments({ ...base, infer: async () => JSON.stringify({ items: [items[0]] }) });
  const result = await extractCommitments({
    ...base,
    infer: async () => JSON.stringify({ items: [items[4]] }),
  });
  assert.equal(result.proposals, 1);
  assert.equal(new CommitmentStore(db).list().length, 1);
});

test("transcript and model skips plus rejected quotes have logged reasons", async (t) => {
  const db = setup(t);
  const base = {
    database: db,
    model: { mode: "local", model: "mock" },
    infer: async () => JSON.stringify({ items: [{ ...items[0], quote: "invented quotation" }] }),
  };
  assert.equal(
    (await extractCommitments({ ...base, note: { ...note, transcript: null } })).reason,
    "no_transcript_rows"
  );
  assert.equal((await extractCommitments({ ...base, note, model: null })).reason, "no_model");
  assert.equal((await extractCommitments({ ...base, note })).reason, "all_items_rejected");
  const entries = fs
    .readFileSync(path.join(db.commitmentsTestDir, "logs", "commitments-extract.log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    entries.map((entry) => entry.skip_reason),
    ["no_transcript_rows", "no_model", "all_items_rejected"]
  );
  assert.equal(entries[2].rejected_reasons.quote_not_found, 1);
});

test("owner action items in a v2 transcript produce four todos end to end", async (t) => {
  const db = setup(t);
  const lines = [
    "Fix the JSON loop/crash issue occurring during page edits — Kosmas",
    "Refine the Improve Existing functionality — You",
    "Prepare a demo for tomorrow, including context and generation features — Kosmas and You",
    "Implement bulk generation after the current tasks are finished — Kosmas",
  ];
  const ownerNote = {
    ...note,
    transcript: JSON.stringify({
      version: 2,
      rows: lines.map((text, index) => ({
        id: String(index),
        text,
        speaker: "you",
        source: "mic",
      })),
    }),
  };
  const modelItems = lines.map((line, index) => ({
    text: line.split(" — ")[0],
    quote: line,
    segment_index: index,
    person: index === 2 ? ["Kosmas", "You"] : line.split(" — ")[1],
    kind: "new",
  }));
  const result = await extractCommitments({
    note: ownerNote,
    database: db,
    model: { mode: "local", model: "mock" },
    infer: async () => `\`\`\`json\n${JSON.stringify({ items: modelItems })}\n\`\`\``,
  });
  assert.equal(result.created, 4);
  assert.equal(new CommitmentStore(db).list().length, 4);
  const log = JSON.parse(
    fs
      .readFileSync(path.join(db.commitmentsTestDir, "logs", "commitments-extract.log"), "utf8")
      .trim()
  );
  assert.equal(log.transcript_shape, "rows");
  assert.equal(log.transcript_version, 2);
  assert.equal(log.segment_count, 4);
  assert.equal(log.parsed_item_count, 4);
  assert.equal(log.accepted_count, 4);
  assert.equal(log.created_count, 4);
});

test("summary action items create source summary rows once without a transcript", (t) => {
  const db = setup(t);
  const summaryNote = {
    ...note,
    transcript: null,
    enhanced_content: `## Action Items\n- [ ] Fix the JSON loop/crash issue occurring during page edits — Kosmas\n- [ ] Refine the Improve Existing functionality — You\n- [ ] Prepare a demo for tomorrow, including context and generation features — Kosmas and You\n- [ ] Implement bulk generation after the current tasks are finished — Kosmas`,
  };
  db.getNote = (id) => (id === note.id ? summaryNote : null);
  const { extractSummaryForNote } = require("../../src/helpers/commitments/extract");
  const selection = resolveExtractionModel(null, {
    mode: "self-hosted",
    provider: "custom",
    model: "chat-model",
  });
  assert.deepEqual(extractSummaryForNote(note.id, { database: db, model: null }), {
    created: 0,
    proposals: 0,
    skipped: true,
    reason: "no_model",
  });
  assert.equal(extractSummaryForNote(note.id, { database: db, ...selection }).created, 4);
  assert.equal(extractSummaryForNote(note.id, { database: db, ...selection }).created, 0);
  const rows = new CommitmentStore(db).list();
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.source === "summary"));
  assert.equal(rows.find((row) => row.text.startsWith("Prepare"))?.person, '["Kosmas","You"]');
});

test("windows overlap one segment and preserve source indexes", () => {
  const parts = windows(
    [{ text: "a".repeat(4) }, { text: "b".repeat(4) }, { text: "c".repeat(4) }],
    10
  );
  assert.deepEqual(
    parts.map((part) => part.map((entry) => entry.segment_index)),
    [
      [0, 1],
      [1, 2],
    ]
  );
});

test("legacy transcript arrays produce their spoken segments", () => {
  const { parseSegments } = require("../../src/helpers/commitments/extract");
  const parsed = parseSegments(JSON.stringify([{ text: "First" }, null, { text: "Third" }]));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].text, "Third");
});

test("version 2 transcript envelopes produce live spoken rows", () => {
  const { parseSegments } = require("../../src/helpers/commitments/extract");
  const raw = JSON.stringify({
    version: 2,
    unknownNumberHighWater: 3,
    rows: [
      { id: "one", text: "First", source: "mic", speaker: "you", timestamp: 123 },
      { id: "two", text: "Removed", deleted: true },
      { id: "three", text: "Third", unknownNumber: 3 },
    ],
  });
  assert.deepEqual(
    parseSegments(raw).map((row) => row.text),
    ["First", "Third"]
  );
  assert.deepEqual(
    parseSegments(JSON.stringify({ rows: [{ text: "Unversioned row" }] })).map((row) => row.text),
    ["Unversioned row"]
  );
});

test("empty and malformed transcripts produce no segments with a reason", () => {
  const { parseSegments } = require("../../src/helpers/commitments/extract");
  for (const raw of ["", "garbage", "{}", JSON.stringify({ version: 3, rows: [{ text: "No" }] })]) {
    const logs = [];
    assert.deepEqual(
      parseSegments(raw, 42, (message, details) => logs.push({ message, details })),
      []
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0].details.noteId, 42);
  }
});

test("extractor persists exactly one todo from a version 2 meeting", async (t) => {
  const db = setup(t);
  const text = "I will send Alex the revised deck tomorrow.";
  const v2Note = {
    ...note,
    transcript: JSON.stringify({
      version: 2,
      unknownNumberHighWater: 1,
      rows: [{ id: "row-1", text, speaker: "you", source: "mic", timestamp: 123 }],
    }),
  };
  const infer = async () =>
    JSON.stringify({
      items: [
        {
          text: "send Alex the revised deck",
          quote: text,
          segment_index: 0,
          person: "Alex",
          direction: "owe",
          kind: "new",
        },
      ],
    });
  assert.deepEqual(
    await extractCommitments({
      note: v2Note,
      database: db,
      model: { mode: "local", model: "mock" },
      infer,
    }),
    { created: 1, proposals: 0, skipped: false }
  );
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitments").get().n, 1);
});

test("one-note re-extraction loads only the requested existing note", async (t) => {
  const db = setup(t);
  const text = "I will send Alex the revised deck tomorrow.";
  const existing = {
    ...note,
    transcript: JSON.stringify({
      version: 2,
      rows: [{ id: "row-1", text, speaker: "you", source: "mic" }],
    }),
  };
  const requested = [];
  db.getNote = (id) => {
    requested.push(id);
    return id === existing.id ? existing : null;
  };
  const infer = async () =>
    JSON.stringify({
      items: [
        {
          text: "send Alex the revised deck",
          quote: text,
          segment_index: 0,
          person: "Alex",
          direction: "owe",
          kind: "new",
        },
      ],
    });
  const { extractForNote } = require("../../src/helpers/commitments/extract");
  const options = { database: db, model: { mode: "local", model: "mock" }, infer };
  assert.deepEqual(await extractForNote(existing.id, options), {
    created: 1,
    proposals: 0,
    skipped: false,
  });
  assert.deepEqual(requested, [existing.id]);
  assert.deepEqual(await extractForNote(999, options), {
    created: 0,
    proposals: 0,
    skipped: true,
    reason: "note_missing",
  });
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM commitments").get().n, 1);
});
