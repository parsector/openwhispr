const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const strings = (x) => object(x) && Object.values(x).every((v) => typeof v === "string");
const own = (x, key) => Object.prototype.hasOwnProperty.call(x, key);

function validateServer(name, server) {
  if (!NAME.test(name)) throw new Error(`Invalid server name: ${name}`);
  if (!object(server)) throw new Error(`Invalid server: ${name}`);
  const allowed = new Set(
    server.type === "http" ? ["type", "url", "headers"] : ["type", "command", "args", "env", "cwd"]
  );
  if (Object.keys(server).some((key) => !allowed.has(key)))
    throw new Error(`Unknown server field: ${name}`);
  if (server.type === "http") {
    if (typeof server.url !== "string" || !/^https?:\/\//.test(server.url))
      throw new Error(`Invalid URL: ${name}`);
    if (server.headers !== undefined && !strings(server.headers))
      throw new Error(`Invalid headers: ${name}`);
    if (own(server, "command") || own(server, "args") || own(server, "env") || own(server, "cwd"))
      throw new Error(`Invalid HTTP server: ${name}`);
  } else {
    if (server.type !== undefined && server.type !== "stdio")
      throw new Error(`Invalid transport: ${name}`);
    if (typeof server.command !== "string" || !server.command.trim())
      throw new Error(`Invalid command: ${name}`);
    if (
      server.args !== undefined &&
      (!Array.isArray(server.args) || !server.args.every((v) => typeof v === "string"))
    )
      throw new Error(`Invalid args: ${name}`);
    if (server.env !== undefined && !strings(server.env)) throw new Error(`Invalid env: ${name}`);
    if (server.cwd !== undefined && typeof server.cwd !== "string")
      throw new Error(`Invalid cwd: ${name}`);
  }
  return server;
}
function validateConfig(value) {
  if (!object(value) || !object(value.mcpServers)) throw new Error("Expected mcpServers object");
  const names = new Set();
  for (const [name, server] of Object.entries(value.mcpServers)) {
    if (names.has(name)) throw new Error(`Duplicate server: ${name}`);
    names.add(name);
    validateServer(name, server);
  }
  if (value._openwhispr !== undefined && !object(value._openwhispr))
    throw new Error("Invalid settings");
  return value;
}
function parseConfig(text) {
  const parsed = validateConfig(JSON.parse(text));
  const start = /"mcpServers"\s*:\s*\{/.exec(text);
  if (!start) throw new Error("Expected mcpServers object");
  let depth = 1;
  let quoted = false;
  let escaped = false;
  let token = "";
  const names = new Set();
  for (let i = start.index + start[0].length; i < text.length && depth > 0; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) {
        token += char;
        escaped = false;
      } else if (char === "\\") {
        token += char;
        escaped = true;
      } else if (char === '"') {
        quoted = false;
        if (depth === 1 && /^\s*:/.test(text.slice(i + 1))) {
          const name = JSON.parse(`"${token}"`);
          if (names.has(name)) throw new Error(`Duplicate server: ${name}`);
          names.add(name);
        }
      } else token += char;
    } else if (char === '"') {
      quoted = true;
      token = "";
    } else if (char === "{") depth++;
    else if (char === "}") depth--;
  }
  return parsed;
}
function createConfigStore(file, fsImpl = fs) {
  const settingsFile = path.join(path.dirname(file), "client-settings.json");
  function read() {
    const servers = fsImpl.existsSync(file)
      ? parseConfig(fsImpl.readFileSync(file, "utf8"))
      : { mcpServers: {} };
    const settings = fsImpl.existsSync(settingsFile)
      ? JSON.parse(fsImpl.readFileSync(settingsFile, "utf8"))
      : {};
    if (!object(settings)) throw new Error("Invalid MCP client settings");
    return { mcpServers: servers.mcpServers, _openwhispr: settings };
  }
  function atomicWrite(target, value) {
    const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      fsImpl.renameSync(temp, target);
      if (process.platform !== "win32") fsImpl.chmodSync(target, 0o600);
    } catch (error) {
      try {
        fsImpl.unlinkSync(temp);
      } catch {}
      throw error;
    }
  }
  function write(value) {
    validateConfig(value);
    const dir = path.dirname(file);
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fsImpl.chmodSync(dir, 0o700);
    atomicWrite(file, { mcpServers: value.mcpServers });
    atomicWrite(settingsFile, value._openwhispr || {});
  }
  return { read, write };
}
module.exports = { NAME, validateServer, validateConfig, parseConfig, createConfigStore };
