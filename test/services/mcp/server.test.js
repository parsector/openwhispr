const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createTokenStore } = require("../../../src/services/mcp/server/tokenStore");
const { createMcpHttpServer } = require("../../../src/services/mcp/server/httpServer");
const { createTools, capResult } = require("../../../src/services/mcp/server/tools");
const { searchNotes } = require("../../../src/services/mcp/server/searchNotes");

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

    const init = await request("initialize", 1, { protocolVersion: "1999-01-01", clientInfo: { name: "Claude" } });
    assert.equal(init.status, 200);
    assert.equal((await init.json()).result.protocolVersion, "2025-06-18");
    const session = init.headers.get("mcp-session-id");
    assert.ok(session);
    assert.equal((await request("tools/list", 2, {}, { "Mcp-Session-Id": session })).status, 400);
    const initialized = await request("notifications/initialized", undefined, {}, { "Mcp-Session-Id": session });
    assert.equal(initialized.status, 202);
    const headers = { "Mcp-Session-Id": session };
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
  } finally { f.cleanup(); }
});

test("result cap includes explicit marker and original length", () => {
  const original = JSON.stringify({ content: "x".repeat(10000) });
  const capped = capResult({ content: "x".repeat(10000) });
  assert.equal(capped.length, 8000);
  assert.match(capped, new RegExp(`\\[TRUNCATED; untruncated length: ${original.length} characters\\]$`));
});

test("shared search passes all-spaces access only when requested", async () => {
  const seen = [];
  const database = { searchNotes: (...args) => { seen.push(args); return [{ id: 1 }]; } };
  await searchNotes({ database, query: "plan", allSpaces: true });
  await searchNotes({ database, query: "plan" });
  assert.equal(seen[0][4], true);
  assert.equal(seen[1][4], false);
});
