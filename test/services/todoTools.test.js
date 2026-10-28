const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTools } = require("../../src/services/mcp/server/tools");
const { listTodos, getTodo } = require("../../src/helpers/commitments/toolRead");
const { createToolRegistry: routineTools } = require("../../src/helpers/routines/routineToolRegistry");
const { createToolRegistry: chatTools } = require("../../src/services/tools/index.ts");

const now = new Date(2026, 9, 28, 12);
const base = { account_id: "a", space_id: 1, status: "open", direction: "owe", person: "Alex", source_note_title: "Plan", mention_count: 2, archived_at: null, created_at: "2026-10-01" };
function row(id, patch = {}) { return { ...base, id, text: `Todo ${id}`, due_date: null, ...patch }; }
function mockDb(rows, mentions = []) {
  const database = {
    activeAccountId: "a",
    getSpaces: () => [{ id: 1, name: "Personal" }],
    db: { prepare(sql) {
      if (sql.includes("FROM commitments WHERE id=?")) return { get: (id, account) => rows.find((item) => item.id === id && item.account_id === account) };
      if (sql.includes("FROM commitments WHERE account_id IS ?")) return { all: (account) => rows.filter((item) => item.account_id === account && (sql.includes("archived_at IS NOT NULL") ? !!item.archived_at : !item.archived_at)) };
      if (sql.includes("FROM commitment_mentions WHERE commitment_id=?")) return { all: (id) => mentions.filter((item) => item.commitment_id === id) };
      if (sql.includes("SELECT note_id FROM routine_runs")) return { all: () => [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    } },
  };
  return database;
}

test("list filters, local date boundaries, UI ordering, archive and account-space scope", () => {
  const rows = [
    row("none"), row("tomorrow", { due_date: "2026-10-29" }),
    row("today", { due_date: "2026-10-28" }), row("overdue", { due_date: "2026-10-27" }),
    row("week-end", { due_date: "2026-11-03" }), row("after-week", { due_date: "2026-11-04" }),
    row("waiting", { direction: "waiting", due_date: "2026-10-26", person: '["Sam","Alex"]' }),
    row("proposed", { status: "proposed" }),
    row("archived", { status: "completed", archived_at: "2026-10-28" }),
    row("foreign-account", { account_id: "b" }), row("foreign-space", { space_id: 2 }),
  ];
  const db = mockDb(rows);
  assert.deepEqual(listTodos(db, {}, now).data.map((item) => item.id), ["overdue", "today", "tomorrow", "week-end", "after-week", "none", "waiting"]);
  assert.deepEqual(listTodos(db, { due: "overdue" }, now).data.map((item) => item.id), ["overdue"]);
  assert.deepEqual(listTodos(db, { due: "today" }, now).data.map((item) => item.id), ["today"]);
  assert.deepEqual(listTodos(db, { due: "week" }, now).data.map((item) => item.id), ["today", "tomorrow", "week-end"]);
  assert.deepEqual(listTodos(db, { due: "none" }, now).data.map((item) => item.id), ["none"]);
  assert.deepEqual(listTodos(db, { direction: "waiting", person: "sam" }, now).data.map((item) => item.id), ["waiting"]);
  assert.deepEqual(listTodos(db, { status: "proposed" }, now).data.map((item) => item.id), ["proposed"]);
  assert.deepEqual(listTodos(db, { status: "completed" }, now).data, []);
  assert.deepEqual(listTodos(db, { status: "completed", include_archived: true }, now).data.map((item) => item.id), ["archived"]);
  assert.equal(listTodos(db, {}, now).data[0].overdue, true);
  assert.equal(listTodos(db, { direction: "waiting" }, now).data[0].overdue, false);
  assert.deepEqual(Object.keys(listTodos(db, {}, now).data[0]), ["id", "text", "person", "direction", "due_date", "status", "overdue", "source_meeting_title", "mention_count"]);
  const midnight = new Date(2026, 9, 28, 0, 0);
  assert.deepEqual(listTodos(db, { due: "overdue" }, midnight).data, []);
  assert.deepEqual(listTodos(db, { due: "overdue" }, new Date(2026, 9, 28, 0, 1)).data.map((item) => item.id), ["overdue"]);
});

test("default and maximum limits clamp, and payload truncation remains valid JSON", async () => {
  const db = mockDb(Array.from({ length: 200 }, (_, i) => row(String(i), { text: "x".repeat(900), created_at: String(i).padStart(3, "0") })));
  assert.ok(listTodos(db, {}, now).data.length <= 20);
  assert.equal(listTodos(db, { limit: 500 }, now).data.length < 50, true);
  const result = listTodos(db, { limit: 500 }, now);
  assert.equal(result.truncated, true);
  assert.ok(result.data.length > 0);
  assert.ok(JSON.stringify(result).length <= 8000);
  const mcp = await createTools(db).call("list_todos", { limit: 500 });
  const parsed = JSON.parse(mcp.content[0].text);
  assert.equal(parsed.truncated, true);
  assert.ok(mcp.content[0].text.length <= 8000);
  const short = mockDb(Array.from({ length: 80 }, (_, i) => row(String(i))));
  assert.equal(listTodos(short, {}).data.length, 20);
  assert.equal(listTodos(short, { limit: 500 }).data.length, 50);
});

test("detail includes bounded mention history, and missing, archived, inaccessible IDs are clean not-found", async () => {
  const rows = [row("visible", { quote: "Stored quote", quote_segment_index: 4, source_note_id: "7", speaker_confidence: "attributed", rejected_reason: null }), row("archived", { archived_at: "now" }), row("foreign-space", { space_id: 2 })];
  const mentions = Array.from({ length: 15 }, (_, i) => ({ id: String(i), commitment_id: "visible", quote: `quote ${i}`, created_at: String(i) }));
  const db = mockDb(rows, mentions);
  const detail = getTodo(db, { id: "visible" });
  assert.equal(detail.data.quote, "Stored quote");
  assert.equal(detail.data.quote_segment_index, 4);
  assert.equal(detail.data.source_note_id, "7");
  assert.equal(detail.data.source_note_title, "Plan");
  assert.equal(detail.data.speaker_confidence, "attributed");
  assert.equal(detail.data.rejected_reason, null);
  assert.deepEqual(detail.data.mentions.map((m) => m.id), ["5", "6", "7", "8", "9", "10", "11", "12", "13", "14"]);
  for (const id of ["missing", "archived", "foreign-space"]) {
    assert.deepEqual(getTodo(db, { id }).data, null);
    assert.equal(JSON.parse((await createTools(db).call("get_todo", { id })).content[0].text).success, false);
  }
  const huge = mockDb([row("huge", { quote: "q".repeat(30000), text: "t".repeat(30000) })]);
  const bounded = getTodo(huge, { id: "huge" });
  assert.equal(bounded.truncated, true);
  assert.ok(JSON.stringify(bounded).length <= 8000);
});

test("MCP, assistant, and routine expose identical todo schemas and shared read results", async () => {
  const db = mockDb([row("one")]);
  const settings = { isSignedIn: false, productHelpEnabled: false, calendarConnected: false, cloudBackupEnabled: false, webSearchEnabled: false, keepNotesUnchanged: true };
  const chat = chatTools(settings);
  const routine = routineTools({ database: db, allowedTools: ["list_todos"], finishRun() {} });
  const mcp = createTools(db);
  for (const name of ["list_todos", "get_todo"]) {
    const external = mcp.definitions.find((tool) => tool.name === name);
    const assistant = chat.get(name);
    const assembled = routine.assembly.get(name);
    assert.ok(external && assistant && assembled);
    assert.deepEqual(external.inputSchema, assistant.parameters);
    assert.deepEqual(assembled.parameters, assistant.parameters);
    assert.equal(external.description, assistant.description);
  }
  assert.deepEqual(routine.get("list_todos").parameters, chat.get("list_todos").parameters);
  const expected = listTodos(db, {});
  assert.deepEqual(await routine.get("list_todos").execute({}), expected);
  global.window = { electronAPI: { todosToolList: async (args) => listTodos(db, args), todosToolGet: async (args) => getTodo(db, args) } };
  try {
    assert.deepEqual(await chat.get("list_todos").execute({}), expected);
    assert.deepEqual(await chat.get("get_todo").execute({ id: "one" }), getTodo(db, { id: "one" }));
  } finally { delete global.window; }
});
