const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const {
  createConfigStore,
  parseConfig,
  NAME,
} = require("../../../../src/services/mcp/client/configStore");
const { McpClient } = require("../../../../src/services/mcp/client/McpClient");
const { McpManager } = require("../../../../src/services/mcp/client/manager");
const fixture = path.resolve(__dirname, "../../../fixtures/mcpFakeServer.js");

test("config validates and writes private, atomic JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-config-"));
  const file = path.join(dir, "mcp", "servers.json");
  const store = createConfigStore(file);
  assert.deepEqual(store.read().mcpServers, {});
  assert.throws(() => parseConfig("{bad"));
  assert.throws(
    () => parseConfig('{"mcpServers":{"a":{"command":"x"},"a":{"command":"y"}}}'),
    /Duplicate/
  );
  assert.throws(() => parseConfig('{"mcpServers":{"a":{"command":1}}}'), /command/);
  store.write({ mcpServers: { a: { command: "node", args: [] } } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.read().mcpServers.a.command, "node");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), [
    "client-settings.json",
    "servers.json",
  ]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))), ["mcpServers"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
test("name regex and collision on server enable", async () => {
  assert.equal(NAME.test("x".repeat(65)), false);
  assert.equal(NAME.test("bad space"), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-manager-"));
  const store = createConfigStore(path.join(dir, "servers.json"));
  const manager = new McpManager(store, { reservedNames: ["demo__echo"] });
  await manager.upsert("demo", { command: process.execPath, args: [fixture] });
  await assert.rejects(
    manager.confirm("demo", { command: process.execPath, args: [fixture], cwd: null }),
    /colliding/
  );
  assert.match(manager.list().servers[0].lastError, /colliding/);
  manager.stopAll();
  fs.rmSync(dir, { recursive: true, force: true });
});
test("stdio initializes, lists, calls, errors, cancels and times out without killing child", async () => {
  const spawned = [];
  const client = new McpClient(
    { command: process.execPath, args: [fixture] },
    { onSpawn: (entry) => spawned.push(entry) }
  );
  try {
    assert.equal((await client.initialize())[0].name, "echo");
    assert.equal(spawned.length, 1);
    assert.deepEqual((await client.call("echo", { value: 3 })).content, [
      { type: "text", text: '{"value":3}' },
    ]);
    await assert.rejects(client.call("error", {}), /fake error/);
    const controller = new AbortController();
    const cancelled = client.call("hang", {}, controller.signal);
    controller.abort();
    await assert.rejects(cancelled);
    await assert.rejects(
      client.request("tools/call", { name: "hang", arguments: {} }, undefined, 25),
      /timed out/
    );
    assert.deepEqual((await client.call("echo", { alive: true })).content, [
      { type: "text", text: '{"alive":true}' },
    ]);
  } finally {
    client.stop();
  }
});
test("HTTP Streamable transport initializes, lists, calls and reports errors", async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const message = JSON.parse(text);
    seen.push(message.method);
    if (!message.id) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("mcp-session-id", "fake-session");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        ...(message.method === "tools/call" && message.params.name === "error"
          ? { error: { code: -1, message: "failed" } }
          : {
              result:
                message.method === "tools/list"
                  ? { tools: [{ name: "echo" }] }
                  : message.method === "initialize"
                    ? {}
                    : { content: [{ type: "text", text: "ok" }] },
            }),
      })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new McpClient({
    type: "http",
    url: `http://127.0.0.1:${server.address().port}/mcp`,
  });
  try {
    assert.equal((await client.initialize())[0].name, "echo");
    assert.equal((await client.call("echo", {})).content[0].text, "ok");
    await assert.rejects(client.call("error", {}), /failed/);
    assert.deepEqual(seen.slice(0, 3), ["initialize", "notifications/initialized", "tools/list"]);
  } finally {
    client.stop();
    server.close();
  }
});
test("HTTP timeout and cancellation abort requests", async () => {
  const server = http.createServer((_req, _res) => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new McpClient({
    type: "http",
    url: `http://127.0.0.1:${server.address().port}/mcp`,
  });
  try {
    await assert.rejects(client.request("tools/call", {}, undefined, 20), /timed out/);
    const controller = new AbortController();
    const call = client.request("tools/call", {}, controller.signal);
    controller.abort(new Error("cancelled"));
    await assert.rejects(call, /cancelled/);
  } finally {
    client.stop();
    server.closeAllConnections();
    server.close();
  }
});
test("external config changes refresh the manager revision and server set", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-refresh-"));
  const file = path.join(dir, "servers.json");
  const store = createConfigStore(file);
  const manager = new McpManager(store);
  try {
    const before = (await manager.sync()).revision;
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { remote: { type: "http", url: "http://127.0.0.1:1/mcp" } } })
    );
    const after = await manager.sync();
    assert.ok(after.revision > before);
    assert.equal(after.servers[0].name, "remote");
  } finally {
    manager.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
