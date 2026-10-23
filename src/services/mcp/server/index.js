const fs = require("node:fs");
const path = require("node:path");
const { createTokenStore } = require("./tokenStore");
const { createTools } = require("./tools");
const { createMcpHttpServer } = require("./httpServer");

function registerLocalMcp({ ipcMain, userData, database, getSemanticSearch }) {
  const tokens = createTokenStore(userData);
  const server = createMcpHttpServer({ tokens, tools: createTools(database, getSemanticSearch) });
  const settingsFile = path.join(userData, "mcp", "settings.json");
  let enabled = false;
  let url = null;
  try { enabled = JSON.parse(fs.readFileSync(settingsFile, "utf8")).enabled === true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  async function setEnabled(next) {
    if (typeof next !== "boolean") throw new Error("Expected boolean");
    if (next) url = await server.start();
    else { server.stop(); url = null; }
    enabled = next;
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(path.dirname(settingsFile), 0o700);
    fs.writeFileSync(settingsFile, JSON.stringify({ enabled }), { mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(settingsFile, 0o600);
    return { enabled, url };
  }
  ipcMain.handle("local-mcp-state", () => ({ enabled, url, tokens: tokens.list(), activity: tokens.activity() }));
  ipcMain.handle("local-mcp-enable", (_event, value) => setEnabled(value));
  ipcMain.handle("local-mcp-create-token", (_event, label) => tokens.create(label));
  ipcMain.handle("local-mcp-revoke-token", (_event, id) => tokens.revoke(id));
  if (enabled) server.start().then((value) => { url = value; }).catch(() => { enabled = false; });
  return () => server.stop();
}

module.exports = { registerLocalMcp };
