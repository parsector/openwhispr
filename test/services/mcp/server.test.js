const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const Module = require("node:module");
const { createTokenStore } = require("../../../src/services/mcp/server/tokenStore");
const { createMcpHttpServer } = require("../../../src/services/mcp/server/httpServer");
const { createTools, capResult } = require("../../../src/services/mcp/server/tools");
const { searchNotes } = require("../../../src/helpers/noteSearch");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-mcp-"));
  const tokens = createTokenStore(dir);
  const token = tokens.create("Claude Desktop");
  const note = { id: 7, title: "Plan", content: "A private note", enhanced_content: "", transcript: "", space_id: 1, created_at: "2026-01-01", note_type: "text" };
  const database = {
    getSpaces: () => [{ id: 1, name: "Personal" }],
    getFolders: () => [{ id: 3, name: "Work", space_id: 1 }],
    getNote: (id) => id === 7 ? note : null,
    searchNotes: () => [note],
  };
  const server = createMcpHttpServer({ tokens, tools: createTools(database), port: 0 });
  return { dir, tokens, token, server, database, cleanup: () => { server.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("token plaintext is returned once, hashed at rest, and revocable", () => {
  const f = fixture();
  try {
    assert.match(f.token.plaintext, /^owk_/);
    assert.equal(f.tokens.list()[0].plaintext, undefined);
    assert.equal(fs.readFileSync(path.join(f.dir, "mcp", "tokens.json"), "utf8").includes(f.token.plaintext), false);
    assert.equal(fs.statSync(path.join(f.dir, "mcp", "tokens.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(f.dir, "mcp")).mode & 0o777, 0o700);
    assert.equal(f.tokens.verify(f.token.plaintext).label, "Claude Desktop");
    assert.ok(f.tokens.list()[0].lastUsedAt);
    assert.equal(f.tokens.verify("owk_" + "x".repeat(43)), null);
    assert.equal(f.tokens.revoke(f.token.id), true);
    assert.equal(f.tokens.verify(f.token.plaintext), null);
  } finally { f.cleanup(); }
});

test("authentication, host guard, body cap, handshake, and read tools", async () => {
  const f = fixture();
  try {
    const url = await f.server.start();
    const request = (method, id, params = {}, extra = {}) => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.token.plaintext}`, ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const unauthorized = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");
    const badToken = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owk_invalid" }, body: "{}" });
    assert.equal(badToken.status, 401);
    const badHost = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: "POST", headers: { Host: "evil.example", Authorization: `Bearer ${f.token.plaintext}` } }, (res) => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject); req.end();
    });
    assert.equal(badHost, 403);
    const oversized = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.token.plaintext}` }, body: "x".repeat(65537) });
    assert.equal(oversized.status, 413);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${f.token.plaintext}` } })).status, 405);
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain", Authorization: `Bearer ${f.token.plaintext}` }, body: "{}" })).status, 415);

    const init = await request("initialize", 1, { protocolVersion: "1999-01-01", clientInfo: { name: "Claude" } });
    assert.equal(init.status, 200);
    assert.equal((await init.json()).result.protocolVersion, "2025-06-18");
    const session = init.headers.get("mcp-session-id");
    assert.ok(session);
    const premature = await request("tools/list", 2, {}, { "Mcp-Session-Id": session });
    assert.equal(premature.status, 400);
    assert.equal((await premature.json()).error.code, -32600);
    const initialized = await request("notifications/initialized", undefined, {}, { "Mcp-Session-Id": session });
    assert.equal(initialized.status, 202);
    const headers = { "Mcp-Session-Id": session };
    const wrongVersion = await request("tools/list", 20, {}, { ...headers, "MCP-Protocol-Version": "2025-03-26" });
    assert.equal(wrongVersion.status, 400);
    assert.equal((await wrongVersion.json()).error.code, -32600);
    const unknown = await request("tools/call", 21, { name: "missing", arguments: {} }, headers);
    assert.equal((await unknown.json()).error.code, -32602);
    const listed = await request("tools/list", 3, {}, headers);
    assert.deepEqual((await listed.json()).result.tools.map((tool) => tool.name), ["search_notes", "get_note", "list_folders"]);
    const called = await request("tools/call", 4, { name: "get_note", arguments: { id: 7 } }, headers);
    assert.match((await called.json()).result.content[0].text, /A private note/);
    const searched = await request("tools/call", 5, { name: "search_notes", arguments: { query: "Plan" } }, headers);
    assert.match((await searched.json()).result.content[0].text, /Plan/);
    const folders = await request("tools/call", 6, { name: "list_folders", arguments: {} }, headers);
    assert.match((await folders.json()).result.content[0].text, /Work/);
    const sse = await request("ping", 7, {}, { ...headers, Accept: "text/event-stream" });
    assert.match(sse.headers.get("content-type"), /text\/event-stream/);
    assert.match(await sse.text(), /event: message/);
    const log = fs.readFileSync(path.join(f.dir, "mcp", "activity.json"), "utf8");
    assert.equal(log.includes("A private note"), false);
    assert.deepEqual(f.tokens.activity().map((entry) => entry.tool), ["get_note", "search_notes", "list_folders"]);
    assert.equal(f.tokens.activity()[0].clientName, "Claude");
    const originalNote = f.database.getNote(7);
    f.database.getNote = () => ({ ...originalNote, title: "Long", content: "x".repeat(10000) });
    const longNote = await request("tools/call", 8, { name: "get_note", arguments: { id: 7 } }, headers);
    assert.match(JSON.parse((await longNote.json()).result.content[0].text).data.content, /\[TRUNCATED; original field length: 10000 characters\]$/);
    assert.equal((await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${f.token.plaintext}`, "Mcp-Session-Id": session } })).status, 204);
    assert.equal((await request("tools/list", 22, {}, headers)).status, 404);
    f.tokens.revoke(f.token.id);
    assert.equal((await request("initialize", 23, { protocolVersion: "2025-06-18" })).status, 401);
  } finally { f.cleanup(); }
});

test("result cap includes explicit marker and original length", () => {
  const capped = capResult({ content: "x".repeat(10000) });
  assert.ok(capped.length <= 8000);
  assert.match(JSON.parse(capped).content, /\[TRUNCATED; original field length: 10000 characters\]$/);
  const many = capResult({ notes: Array.from({ length: 20 }, (_, id) => ({ id, content: "x".repeat(1000) })) });
  assert.ok(many.length <= 8000);
  assert.deepEqual(Object.keys(JSON.parse(many)), ["truncated", "untruncatedLength", "data"]);
  assert.equal(JSON.parse(many).untruncatedLength, JSON.stringify({ notes: Array.from({ length: 20 }, (_, id) => ({ id, content: "x".repeat(1000) })) }).length);
});

test("shared search uses account-scoped database access", async () => {
  const seen = [];
  const database = { searchNotes: (...args) => { seen.push(args); return [{ id: 1 }]; } };
  await searchNotes({ database, query: "plan" });
  assert.deepEqual(seen, [["plan", 10, undefined, undefined]]);
});

test("occupied port falls back to a free port and repeated start returns the actual URL", async () => {
  const f = fixture();
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  const server = createMcpHttpServer({ tokens: f.tokens, tools: createTools(f.database), port });
  try {
    const [first, second] = await Promise.all([server.start(), server.start()]);
    assert.equal(first, second);
    assert.notEqual(new URL(first).port, String(port));
    assert.equal(await server.start(), first);
  } finally { server.stop(); blocker.close(); f.cleanup(); }
});

test("MCP cannot read another account's note, search hit, folder, or space", async () => {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "electron") return { app: {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  let DatabaseManager;
  try { DatabaseManager = require("../../../src/helpers/database"); }
  finally { Module._load = originalLoad; }
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE spaces (id INTEGER PRIMARY KEY, name TEXT, kind TEXT, deleted_at TEXT, sort_order INTEGER DEFAULT 0);
    CREATE TABLE space_accounts (space_id INTEGER, account_id TEXT);
    CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT, space_id INTEGER, account_id TEXT, deleted_at TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, content TEXT, enhanced_content TEXT, transcript TEXT, space_id INTEGER, folder_id INTEGER, account_id TEXT, note_type TEXT, deleted_at TEXT, created_at TEXT);
    CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, content='notes', content_rowid='id');
    INSERT INTO spaces (id, name, kind) VALUES (1, 'Private', 'private'), (2, 'Team A', 'team'), (3, 'Team B', 'team');
    INSERT INTO space_accounts VALUES (2, 'account-a'), (3, 'account-b');
    INSERT INTO folders (id, name, space_id, account_id) VALUES (1, 'A folder', 2, 'account-a'), (2, 'B folder', 3, 'account-b');
    INSERT INTO notes (id, title, content, space_id, folder_id, account_id) VALUES (1, 'Visible', 'visible text', 2, 1, 'account-a'), (2, 'Foreign', 'foreign secret', 3, 2, 'account-b');
    INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');
  `);
  const database = Object.create(DatabaseManager.prototype);
  database.db = sqlite;
  database.setActiveAccountId("account-a");
  const f = fixture();
  const server = createMcpHttpServer({ tokens: f.tokens, tools: createTools(database, () => ({ search: async () => [{ noteId: 2, score: 0.9 }] })), port: 0 });
  try {
    const url = await server.start();
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${f.token.plaintext}` };
    const send = async (method, id, params, session) => {
      const response = await fetch(url, { method: "POST", headers: { ...headers, ...(session ? { "Mcp-Session-Id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method, id, params }) });
      return { response, body: response.status === 202 ? null : await response.json() };
    };
    const init = await send("initialize", 1, { protocolVersion: "2025-06-18", clientInfo: { name: "Test" } });
    const session = init.response.headers.get("mcp-session-id");
    await send("notifications/initialized", undefined, {}, session);
    const call = async (id, name, args) => JSON.parse((await send("tools/call", id, { name, arguments: args }, session)).body.result.content[0].text);
    assert.equal((await call(2, "get_note", { id: 2 })).data, null);
    assert.deepEqual((await call(3, "search_notes", { query: "foreign" })).data, []);
    assert.deepEqual((await call(4, "list_folders", {})).data.map((folder) => folder.name), ["A folder"]);
    assert.deepEqual((await call(5, "search_notes", { query: "visible" })).data.map((note) => note.id), [1]);
    assert.equal((await send("tools/call", 6, { name: "search_notes", arguments: { query: "foreign", space: "Team B" } }, session)).body.error.message, "Space not found");
  } finally { server.stop(); f.cleanup(); sqlite.close(); }
});
