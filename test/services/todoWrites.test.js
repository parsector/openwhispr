const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createTokenStore } = require("../../src/services/mcp/server/tokenStore");
const { createMcpHttpServer } = require("../../src/services/mcp/server/httpServer");
const { createTools } = require("../../src/services/mcp/server/tools");
const { createToolRegistry: routineTools } = require("../../src/helpers/routines/routineToolRegistry");
const { createToolRegistry: chatTools } = require("../../src/services/tools/index.ts");
const { CommitmentStore } = require("../../src/helpers/commitments/store");
const { createTodo, updateTodo } = require("../../src/helpers/commitments/toolWrite");
const { getTodo, listTodos } = require("../../src/helpers/commitments/toolRead");

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE commitments (
    id TEXT PRIMARY KEY, account_id TEXT, space_id TEXT, text TEXT NOT NULL, quote TEXT,
    quote_segment_index INTEGER, source_note_id TEXT, source_note_title TEXT, person TEXT,
    direction TEXT, source TEXT DEFAULT 'meeting', source_agent TEXT, due_date TEXT, due_raw TEXT,
    due_confidence REAL, status TEXT, rejected_reason TEXT, speaker_confidence TEXT,
    mention_count INTEGER, pinned_fields TEXT, extraction_version TEXT, source_removed INTEGER,
    created_at TEXT, updated_at TEXT, completed_at TEXT, rejected_at TEXT, archived_at TEXT
  );
  CREATE TABLE commitment_mentions (id TEXT, commitment_id TEXT, note_id TEXT, segment_index INTEGER,
    quote TEXT, kind TEXT, prev_value TEXT, new_value TEXT, created_at TEXT);
  CREATE TABLE routine_runs (note_id INTEGER);`);
  return { db, activeAccountId: "a", getSpaces: () => [{ id: 1 }] };
}

function settings() { return { isSignedIn: false, productHelpEnabled: false, calendarConnected: false, cloudBackupEnabled: false, webSearchEnabled: false, keepNotesUnchanged: true }; }

test("MCP scopes deny and record every write while legacy and unscoped tokens retain reads", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-todo-write-"));
  const data = database();
  const tokens = createTokenStore(dir);
  const reader = tokens.create("Old reader");
  const writer = tokens.create("Writer", ["todos:write"]);
  const tokenFile = path.join(dir, "mcp", "tokens.json");
  const raw = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  delete raw[0].scopes;
  fs.writeFileSync(tokenFile, JSON.stringify(raw));
  assert.deepEqual(tokens.verify(reader.plaintext).scopes, []);
  assert.deepEqual(tokens.verify(writer.plaintext).scopes, ["todos:write"]);
  const baseTools = createTools(data);
  const tools = { ...baseTools, definitions: [...baseTools.definitions, { name: "unclassified", inputSchema: { type: "object", properties: {} } }] };
  const server = createMcpHttpServer({ tokens, tools, port: 0 });
  t.after(() => { server.stop(); data.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = await server.start();
  async function send(token, method, id, params = {}, session) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.plaintext}`, ...session && { "Mcp-Session-Id": session } }, body: JSON.stringify({ jsonrpc: "2.0", method, id, params }) });
    return { response, body: response.status === 202 ? null : await response.json() };
  }
  async function open(token, name) {
    const init = await send(token, "initialize", 1, { clientInfo: { name } });
    const session = init.response.headers.get("mcp-session-id");
    await send(token, "notifications/initialized", undefined, {}, session);
    return session;
  }
  const readSession = await open(reader, "Read client");
  const writeSession = await open(writer, "Write client");
  const call = (token, session, name, args) => send(token, "tools/call", 2, { name, arguments: args }, session);
  assert.equal(JSON.parse((await call(reader, readSession, "list_todos", {})).body.result.content[0].text).success, true);
  for (const name of ["create_todo", "update_todo"]) {
    const denied = await call(reader, readSession, name, name === "create_todo" ? { text: "Send deck" } : { id: "x", status: "completed" });
    assert.equal(denied.body.error.code, -32003);
    assert.match(denied.body.error.message, /todos:write/);
  }
  assert.deepEqual(tokens.activity().map((entry) => entry.tool), ["list_todos", "create_todo", "update_todo"]);
  assert.equal((await call(writer, writeSession, "unclassified", {})).body.error.code, -32003);
  const created = JSON.parse((await call(writer, writeSession, "create_todo", { text: "  Send\n deck  ", due_date: "2026-10-29", quote: "Send the deck" })).body.result.content[0].text);
  assert.equal(created.data.text, "Send deck");
  assert.equal(created.data.source, "agent");
  assert.equal(created.data.source_agent, "Write client");
  assert.deepEqual(created.data, getTodo(data, { id: created.data.id }).data);
  assert.equal(JSON.parse((await call(reader, readSession, "get_todo", { id: created.data.id })).body.result.content[0].text).data.id, created.data.id);
  const updated = JSON.parse((await call(writer, writeSession, "update_todo", { id: created.data.id, due_date: "2026-10-30", status: "completed" })).body.result.content[0].text);
  assert.equal(updated.data.status, "completed");
  assert.equal(updated.data.due_date, "2026-10-30");
  assert.equal(updated.data.mentions[0].kind, "date_moved");
});

test("shared validation gives actionable errors and never accepts proposed or arbitrary fields", () => {
  const data = database();
  try {
    for (const input of [{ text: " " }, { text: "x".repeat(501) }, { text: "okay", due_date: "2026-02-30" }])
      assert.throws(() => createTodo(data, input, "Assistant"), (error) => error.code === -32602 && /text|due_date/.test(error.message));
    const row = createTodo(data, { text: "Okay" }, "Assistant").data;
    for (const input of [{ status: "proposed" }, { status: "unknown" }, { rejected_reason: "why" }, { due_date: "2026-02-30" }, { text: "overwrite" }])
      assert.throws(() => updateTodo(data, { id: row.id, ...input }, "Assistant"), (error) => error.code === -32602 && /status|rejected_reason|due_date|Unknown/.test(error.message));
    assert.equal(listTodos(data).data[0].source_agent, "Assistant");
  } finally { data.db.close(); }
});

test("agent updates obey user pins and all three creation paths retain attribution", () => {
  const data = database();
  try {
    const store = new CommitmentStore(data);
    const meeting = store.create({ text: "Meeting" });
    const manual = store.create({ text: "Manual" }, { user: true });
    const agent = createTodo(data, { text: "Agent" }, "Assistant").data;
    assert.deepEqual([meeting.source, manual.source, agent.source], ["meeting", "manual", "agent"]);
    assert.equal(agent.source_agent, "Assistant");
    assert.equal(manual.source_agent, null);
    store.update(meeting.id, { person: "User choice", due_date: "2026-10-28" }, { user: true });
    const result = updateTodo(data, { id: meeting.id, person: "Agent choice", due_date: "2026-10-29", status: "completed" }, "Assistant").data;
    assert.equal(result.person, "User choice");
    assert.equal(result.due_date, "2026-10-28");
    assert.equal(result.status, "completed");
    assert.equal(result.mentions.length, 0);
    store.update(manual.id, { status: "open" }, { user: true });
    const pinnedStatus = updateTodo(data, { id: manual.id, status: "rejected", rejected_reason: "Agent claim" }, "Assistant").data;
    assert.equal(pinnedStatus.status, "open");
    assert.equal(pinnedStatus.rejected_reason, null);
  } finally { data.db.close(); }
});

test("assistant write tools use the shared store path and Assistant attribution", async () => {
  const data = database();
  global.window = { electronAPI: {
    todosToolCreate: async (args) => createTodo(data, args, "Assistant"),
    todosToolUpdate: async (args) => updateTodo(data, args, "Assistant"),
  } };
  try {
    const chat = chatTools(settings());
    const created = await chat.get("create_todo").execute({ text: "Follow up" });
    assert.equal(created.data.source_agent, "Assistant");
    const changed = await chat.get("update_todo").execute({ id: created.data.id, person: "Alex" });
    assert.equal(changed.data.person, "Alex");
    const invalid = await chat.get("create_todo").execute({ text: "" });
    assert.equal(invalid.success, false);
    assert.match(invalid.displayText, /text must be 1–500/);
  } finally { delete global.window; data.db.close(); }
});

test("no delete, bulk or archive todo tool is exposed, and routines cannot reach writes", () => {
  const data = database();
  try {
    const mcp = createTools(data);
    const chat = chatTools(settings());
    const routine = routineTools({ database: data, allowedTools: ["create_todo", "update_todo", "list_todos"], finishRun() {} });
    for (const names of [mcp.definitions.map((tool) => tool.name), chat.getAll().map((tool) => tool.name), routine.list().map((tool) => tool.name)])
      assert.equal(names.some((name) => /(?:delete|bulk|archive).*todo/.test(name)), false);
    assert.equal(routine.get("create_todo"), undefined);
    assert.equal(routine.get("update_todo"), undefined);
    assert.ok(routine.get("list_todos"));
  } finally { data.db.close(); }
});
